import {
  AccountAddress, type AccountSigner, buildBasicAccountSigner, CcdAmount, type ConcordiumGRPCClient, ContractAddress, ContractEvent,
  DataBlob, Energy, Parameter, ReceiveName, ReturnValue, TransactionExpiry, TransactionHash,
} from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { Transaction } from '@concordium/web-sdk/transactions';
import {
  type ClaimKind, type CoverView, decodeClaim, decodeCoverView, decodePolicy, decodeRegistryEvent, encodeAssess, encodeCoverQuery,
  encodeDecide, encodeFileClaim, encodeFraud, encodeIssuePolicy, encodePayout, encodeU64, type IssuePolicyParams, type RegistryEvent,
  decodeViewResult, encodeIncident, encodeIssue, encodeMandateKey, encodeReceipt, encodeRevoke,
  type IssueParams, type MandateEntry,
} from '@kuasa/core';

export const TESTNET = {
  caip2: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  grpc: { host: 'grpc.testnet.concordium.com', port: 20000 },
  explorer: 'https://ccdexplorer.io/testnet',
} as const;

export function connect(host: string = TESTNET.grpc.host, port: number = TESTNET.grpc.port, tls = true): ConcordiumGRPCClient {
  return new ConcordiumGRPCNodeClient(host, port, tls ? credentials.createSsl() : credentials.createInsecure(), { timeout: 15_000 });
}

/** An account that can sign: address + exported Ed25519 key (single-key accounts). */
export type Wallet = { address: AccountAddress.Type; signer: AccountSigner };

export const wallet = (address: string, privateKeyHex: string): Wallet => ({
  address: AccountAddress.fromBase58(address),
  signer: buildBasicAccountSigner(privateKeyHex),
});

/** Uint8Array to a standalone ArrayBuffer (web-sdk takes ArrayBuffer). */
const ab = (u: Uint8Array) => u.slice().buffer as ArrayBuffer;

export const bigintJson = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/**
 * Signs (optionally with a sponsor co-signing and paying the fee), submits and waits
 * for finalization. With a sponsor, the sender never needs CCD.
 */
export async function submit(grpc: ConcordiumGRPCClient, tx: Transaction.Builder, from: Wallet, sponsor?: Wallet) {
  // Several processes sign for the same account (e.g. shop attester + console incident): a nonce
  // taken by a concurrent sender is retried with a fresh one. Rejected => nothing was submitted.
  let hash: Awaited<ReturnType<ConcordiumGRPCClient['sendTransaction']>>;
  const header = { ...tx.header };
  for (let attempt = 0; ; attempt++) {
    const { nonce } = await grpc.getNextAccountNonce(from.address);
    // a builder takes metadata (and a sponsor) once: every attempt starts from the unconfigured transaction
    const configured = new Transaction.Builder({ ...header }, tx.payload).addMetadata({ sender: from.address, nonce, expiry: TransactionExpiry.futureMinutes(10) });
    const signable = sponsor
      ? await Transaction.sponsor(await Transaction.sign(configured.addSponsor(sponsor.address).build(), from.signer) as Parameters<typeof Transaction.sponsor>[0], sponsor.signer)
      : await Transaction.sign(configured.build(), from.signer);
    try { hash = await grpc.sendTransaction(Transaction.finalize(signable)); break; } catch (e) {
      if (attempt >= 4 || !/duplicate nonce/i.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
  }
  const summary = await grpc.waitForTransactionFinalization(hash);
  return { hash: TransactionHash.toHexString(hash), summary };
}

const jsonSafe = (_k: string, v: unknown) =>
  typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString()) : v;

/**
 * An unsigned transaction for `sender` to sign in their own wallet: the service that prepares it
 * never holds the key. Returns the SDK's signable JSON (nonce and a 30-minute expiry filled in).
 */
export async function prepareTx(grpc: ConcordiumGRPCClient, tx: Transaction.Builder, sender: string) {
  const from = AccountAddress.fromBase58(sender);
  const { nonce } = await grpc.getNextAccountNonce(from);
  const signable = tx.addMetadata({ sender: from, nonce, expiry: TransactionExpiry.futureMinutes(30) }).build();
  return JSON.parse(JSON.stringify(Transaction.toJSON(signable as never), jsonSafe)) as Record<string, unknown>;
}

/** The wallet side: sign a prepared transaction with the sender's own key and submit it. */
export async function signAndSend(grpc: ConcordiumGRPCClient, json: unknown, from: Wallet) {
  const signable = Transaction.signableFromJSON(json);
  const signed = await Transaction.sign(signable, from.signer);
  const hash = await grpc.sendTransaction(Transaction.finalize(signed as never));
  const summary = await grpc.waitForTransactionFinalization(hash);
  return { hash: TransactionHash.toHexString(hash), summary };
}

/** Anchors bytes on-chain (Verify & Access requests and audit records use this). */
export const registerData = (grpc: ConcordiumGRPCClient, data: Uint8Array, from: Wallet, sponsor?: Wallet) =>
  submit(grpc, Transaction.registerData({ data: new DataBlob(ab(data)) }) as Transaction.Builder, from, sponsor);

/** Client for the kuasa-registry contract. Mandates are keyed by (owner, id). */
export class KuasaRegistry {
  readonly address: ContractAddress.Type;
  constructor(readonly grpc: ConcordiumGRPCClient, index: bigint, subindex = 0n) {
    this.address = ContractAddress.create(index, subindex);
  }

  async view(owner: string, id: string): Promise<MandateEntry | null> {
    const res = await this.grpc.invokeContract({
      contract: this.address,
      method: ReceiveName.fromString('kuasa.view'),
      parameter: Parameter.fromBuffer(ab(encodeMandateKey(owner, id))),
    });
    if (res.tag !== 'success' || !res.returnValue) throw new Error(`kuasa.view failed: ${JSON.stringify(res, bigintJson)}`);
    return decodeViewResult(new Uint8Array(ReturnValue.toBuffer(res.returnValue)));
  }

  private async update(method: string, param: Uint8Array, from: Wallet, sponsor?: Wallet) {
    const tx = Transaction.updateContract(
      { amount: CcdAmount.zero(), address: this.address, receiveName: ReceiveName.fromString(`kuasa.${method}`), message: Parameter.fromBuffer(ab(param)) },
      Energy.create(30_000),
    ) as Transaction.Builder;
    const r = await submit(this.grpc, tx, from, sponsor);
    const s = r.summary.summary;
    if (!s || s.type !== 'accountTransaction' || 'rejectReason' in s) {
      throw new Error(`kuasa.${method} rejected on-chain (tx ${r.hash}): ${JSON.stringify(s, bigintJson)}`);
    }
    return r;
  }

  issue = (p: IssueParams, owner: Wallet, sponsor?: Wallet) => this.update('issue', encodeIssue(p), owner, sponsor);
  revoke = (id: string, reasonHex: string, owner: Wallet, sponsor?: Wallet) => this.update('revoke', encodeRevoke(id, reasonHex), owner, sponsor);
  /** Unsigned revoke, for the owner to sign in their own wallet. */
  revokeTx = (id: string, reasonHex: string) => Transaction.updateContract(
    { amount: CcdAmount.zero(), address: this.address, receiveName: ReceiveName.fromString('kuasa.revoke'), message: Parameter.fromBuffer(ab(encodeRevoke(id, reasonHex))) },
    Energy.create(30_000),
  ) as Transaction.Builder;
  recordReceipt = (owner: string, id: string, orderHex: string, paymentTxHex: string, amount: bigint, recorder: Wallet) =>
    this.update('recordReceipt', encodeReceipt(owner, id, orderHex, paymentTxHex, amount), recorder);
  reportIncident = (owner: string, id: string, evidenceHex: string, reporter: Wallet, sponsor?: Wallet) =>
    this.update('reportIncident', encodeIncident(owner, id, evidenceHex), reporter, sponsor);
}

/** Client for the kuasa-cover contract (policies and claims). */
export class KuasaCover {
  readonly address: ContractAddress.Type;
  constructor(readonly grpc: ConcordiumGRPCClient, index: bigint, subindex = 0n) {
    this.address = ContractAddress.create(index, subindex);
  }

  private async invoke(method: string, param: Uint8Array) {
    const res = await this.grpc.invokeContract({
      contract: this.address,
      method: ReceiveName.fromString(`kuasa_cover.${method}`),
      parameter: Parameter.fromBuffer(ab(param)),
    });
    if (res.tag !== 'success' || !res.returnValue) throw new Error(`kuasa_cover.${method} failed: ${JSON.stringify(res, bigintJson)}`);
    return new Uint8Array(ReturnValue.toBuffer(res.returnValue));
  }

  policy = async (id: bigint) => decodePolicy(await this.invoke('policy', encodeU64(id)));
  claim = async (id: bigint) => decodeClaim(await this.invoke('claim', encodeU64(id)));
  coverOf = async (payer: string, order?: string): Promise<CoverView> => decodeCoverView(await this.invoke('coverOf', encodeCoverQuery(payer, order)));
  claimsAuthorized = async (id: bigint) => (await this.invoke('claimsAuthorized', encodeU64(id)))[0] === 1;
  /** v2: the published automation rules (null on a v1 contract, which has none). */
  rules = async (): Promise<{ autoPayLimit: bigint; objectionWindowMs: number } | null> => {
    try {
      const b = await this.invoke('rules', new Uint8Array());
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return { autoPayLimit: v.getBigUint64(0, true), objectionWindowMs: Number(v.getBigUint64(8, true)) };
    } catch { return null; }
  };

  private async update(method: string, param: Uint8Array, from: Wallet, sponsor?: Wallet) {
    const tx = Transaction.updateContract(
      { amount: CcdAmount.zero(), address: this.address, receiveName: ReceiveName.fromString(`kuasa_cover.${method}`), message: Parameter.fromBuffer(ab(param)) },
      Energy.create(60_000),
    ) as Transaction.Builder;
    const r = await submit(this.grpc, tx, from, sponsor);
    const s = r.summary.summary;
    if (!s || s.type !== 'accountTransaction' || 'rejectReason' in s) {
      throw new Error(`kuasa_cover.${method} rejected on-chain (tx ${r.hash}): ${JSON.stringify(s, bigintJson)}`);
    }
    return r;
  }

  issuePolicy = (p: IssuePolicyParams, operator: Wallet) => this.update('issuePolicy', encodeIssuePolicy(p), operator);
  fileClaim = (p: { policyId: bigint; kind: ClaimKind; amount: bigint; evidence: string; orders: string[] }, claimant: Wallet, sponsor?: Wallet) =>
    this.update('fileClaim', encodeFileClaim(p), claimant, sponsor);
  assess = (claimId: bigint, ok: boolean, reasonHex: string, operator: Wallet) => this.update('assessClaim', encodeAssess(claimId, ok, reasonHex), operator);
  decide = (claimId: bigint, approve: boolean, operator: Wallet) => this.update('decideClaim', encodeDecide(claimId, approve), operator);
  recordPayout = (claimId: bigint, payoutTx: string, amount: bigint, operator: Wallet) => this.update('recordPayout', encodePayout(claimId, payoutTx, amount), operator);
  markFraud = (claimId: bigint, disclosureHex: string, operator: Wallet) => this.update('markFraud', encodeFraud(claimId, disclosureHex), operator);
  cancelPolicy = (policyId: bigint, holder: Wallet) => this.update('cancelPolicy', encodeU64(policyId), holder);
  /** v2: automatic approval, accepted by the contract only within its published rules. */
  autoApprove = (claimId: bigint, operator: Wallet) => this.update('autoApprove', encodeU64(claimId), operator);
  /** v2: a party to the claim objects during the objection window (signed by that party). */
  objectClaim = (claimId: bigint, party: Wallet) => this.update('objectClaim', encodeU64(claimId), party);

  /** issuePolicy / fileClaim ids: the first u64 of the PolicyIssued (tag 0) / ClaimFiled (tag 1) event. */
  static idFromEvents(summary: unknown, index: bigint): bigint | null {
    for (const e of contractEvents(summary, index)) {
      if (e[0] === 0 || e[0] === 1) return new DataView(e.buffer, e.byteOffset + 1, 8).getBigUint64(0, true);
    }
    return null;
  }
}

/** Raw event logs emitted by contract <index,*> in a finalized transaction summary. */
export function contractEvents(summary: unknown, index: bigint): Uint8Array[] {
  const s = (summary as { summary?: { events?: unknown[] } })?.summary ?? (summary as { events?: unknown[] });
  const out: Uint8Array[] = [];
  for (const ev of (s?.events ?? []) as { tag?: string; address?: { index: bigint }; events?: ContractEvent.Type[] }[]) {
    if (ev.tag === 'Updated' && ev.address?.index === index) out.push(...(ev.events ?? []).map((x) => ContractEvent.toBuffer(x)));
  }
  return out;
}

/** kuasa-registry events in a finalized transaction, with the block time (ms). */
export async function registryEventsOfTx(grpc: ConcordiumGRPCClient, txHash: string, registryIndex: bigint): Promise<{ at: number; events: RegistryEvent[] } | null> {
  const st = await grpc.getBlockItemStatus(TransactionHash.fromHexString(txHash)).catch(() => null);
  if (!st || st.status !== 'finalized' || !st.outcome) return null;
  const info = await grpc.getBlockInfo(st.outcome.blockHash);
  const events = contractEvents(st.outcome.summary, registryIndex).map(decodeRegistryEvent).filter((e): e is RegistryEvent => e !== null);
  return { at: info.blockSlotTime.getTime(), events };
}

/** The first kuasa-cover instance; its claim records keep un-namespaced CIS-8004 keys. */
export const COVER_V1 = 13066n;
/** CIS-8004 metadata key for a claim record (decision, attest) on a given cover contract. */
export const claimKey = (kind: 'decision' | 'attest', cover: bigint | string, claimId: bigint | string) =>
  BigInt(cover) === COVER_V1 ? `kuasa:${kind}:${claimId}` : `kuasa:${kind}:${cover}:${claimId}`;

/** Concordium's CIS-8004 Agent Registry on testnet. */
export const AGENT_REGISTRY = ContractAddress.create(12802n, 0n);

const lenPrefixed = (b: Uint8Array) => { const out = new Uint8Array(4 + b.length); new DataView(out.buffer).setUint32(0, b.length, true); out.set(b, 4); return out; };
const tokenParam = (tokenHex: string) => { const t = Buffer.from(tokenHex, 'hex'); return Uint8Array.from([t.length, ...t]); };

/** CIS-8004 `setMetadata { token_id, key, value }`. Owner-only; the registry rejects values with quotes or angle brackets. */
export function encodeSetMetadata(tokenHex: string, key: string, value: string): Uint8Array {
  if (/["<>]/.test(value)) throw new Error('metadata value may not contain quotes or angle brackets');
  const enc = new TextEncoder();
  return Uint8Array.from([...tokenParam(tokenHex), ...lenPrefixed(enc.encode(key)), ...lenPrefixed(enc.encode(value))]);
}

/** Unsigned CIS-8004 setMetadata, for the token owner to sign in their own wallet. */
export const cis8004SetMetadataTx = (tokenHex: string, key: string, value: string) => Transaction.updateContract(
  { amount: CcdAmount.zero(), address: AGENT_REGISTRY, receiveName: ReceiveName.fromString('CIS-8004.setMetadata'), message: Parameter.fromBuffer(ab(encodeSetMetadata(tokenHex, key, value))) },
  Energy.create(30_000),
) as Transaction.Builder;

export async function cis8004SetMetadata(grpc: ConcordiumGRPCClient, tokenHex: string, key: string, value: string, owner: Wallet, sponsor?: Wallet) {
  const tx = cis8004SetMetadataTx(tokenHex, key, value);
  const r = await submit(grpc, tx, owner, sponsor);
  const s = r.summary.summary as { transactionType?: string };
  if (s.transactionType === 'failed') throw new Error(`CIS-8004.setMetadata rejected (tx ${r.hash})`);
  return r;
}

/** CIS-8004 `getMetadata { token_id, key } -> Option<Vec<u8>>`, as UTF-8 text. */
export async function cis8004GetMetadata(grpc: ConcordiumGRPCClient, tokenHex: string, key: string): Promise<string | null> {
  const param = Uint8Array.from([...tokenParam(tokenHex), ...lenPrefixed(new TextEncoder().encode(key))]);
  const res = await grpc.invokeContract({ contract: AGENT_REGISTRY, method: ReceiveName.fromString('CIS-8004.getMetadata'), parameter: Parameter.fromBuffer(ab(param)) });
  if (res.tag !== 'success' || !res.returnValue) return null;
  const b = new Uint8Array(ReturnValue.toBuffer(res.returnValue));
  if (b[0] !== 1) return null;
  const n = new DataView(b.buffer, b.byteOffset + 1, 4).getUint32(0, true);
  return new TextDecoder().decode(b.subarray(5, 5 + n));
}
export * from './audit.js';
