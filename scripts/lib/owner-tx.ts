/**
 * Owner actions signed in the owner's own Concordium Wallet, with Kuasa paying the fee (a sponsored
 * transaction, Protocol 10): Kuasa builds the transaction with the owner as sender and itself as sponsor,
 * signs as sponsor and hands the JSON to the page; the wallet shows it, signs as sender and submits.
 * Kuasa never holds the owner's key, and the owner needs no CCD.
 *   register  mint the owner's agent in the Agent Registry (CIS-8004, built by the hosted registry MCP)
 *   issue     the Kuasa mandate for that agent: budget, expiry, who may record its spending
 *   revoke    withdraw the mandate: shops and insurers refuse the agent from the next block
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import type { ConcordiumGRPCClient } from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { encodeIssue, encodeRevoke } from '@kuasa/core';
import { loadProfile } from './identity.js';

const AGENT_REGISTRY = { index: 12802n, subindex: 0n };
const state = () => JSON.parse(readFileSync(new URL('../../.kuasa/state.json', import.meta.url), 'utf8')) as { registry: string; mandates: Record<string, { payer: string }> };
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function sponsor() {
  const a = loadProfile('insurer').accounts.find((x) => x.credNumber === 1)!;
  return { address: sdk.AccountAddress.fromBase58(a.address), signer: sdk.buildBasicAccountSigner(a.key) };
}

async function mcp<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch('https://agent-registry-mcp.concordium.com/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...args, network: 'testnet' } } }),
  });
  const raw = await r.text();
  const res = JSON.parse(raw.slice(raw.indexOf('{'))).result;
  if (res.isError) throw new Error(`registry MCP ${name}: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text) as T;
}

/** 8-byte little-endian hex of a CIS-8004 token id (the form mandates and proof bindings use). */
export const tokenHex = (id: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(id); return b.toString('hex'); };

/** The owner's agents in the Agent Registry, newest last. */
export async function agentsOf(owner: string) {
  const r = await mcp<{ agents?: { token_id: number; status?: string }[] }>('agents_by_owner', { owner_account: owner });
  return (r.agents ?? []).map((a) => ({ tokenId: String(a.token_id), tokenHex: tokenHex(BigInt(a.token_id)), status: a.status ?? null }));
}

async function sponsored(grpc: ConcordiumGRPCClient, tx: Transaction.Builder, owner: string) {
  const sender = sdk.AccountAddress.fromBase58(owner);
  const { nonce } = await grpc.getNextAccountNonce(sender);
  const sp = sponsor();
  const signable = tx.addMetadata({ sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }).addSponsor(sp.address).build();
  const signed = await Transaction.sponsor(signable as Parameters<typeof Transaction.sponsor>[0], sp.signer);
  return JSON.parse(JSON.stringify(Transaction.toJSON(signed as never), (_k, v) => (typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v)));
}

export async function prepareOwnerTx(grpc: ConcordiumGRPCClient, owner: string, action: string, args: { agentToken?: string; mandateId?: string }) {
  sdk.AccountAddress.fromBase58(owner); // an account address or it throws
  if (action === 'register') {
    const b = await mcp<{ contract_address: { index: number; subindex?: number }; receive_name: string; parameter_hex: string; suggested_energy?: number }>('build_register', { sender: owner });
    // only ever the Agent Registry's register entrypoint, whatever the MCP returns
    if (BigInt(b.contract_address.index) !== AGENT_REGISTRY.index || !/\.register$/.test(b.receive_name)) throw new Error('unexpected registry transaction');
    const tx = Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: sdk.ContractAddress.create(AGENT_REGISTRY.index, AGENT_REGISTRY.subindex), receiveName: sdk.ReceiveName.fromString(b.receive_name), message: sdk.Parameter.fromHexString(b.parameter_hex) }, sdk.Energy.create(b.suggested_energy ?? 30_000)) as Transaction.Builder;
    return { transaction: await sponsored(grpc, tx, owner), what: 'Register your agent in the Agent Registry' };
  }
  const registry = sdk.ContractAddress.create(BigInt(state().registry), 0n);
  if (action === 'issue') {
    if (!/^[0-9a-f]{16}$/.test(args.agentToken ?? '')) throw new Error('agentToken: 16 hex characters');
    const mine = await agentsOf(owner);
    if (!mine.some((a) => a.tokenHex === args.agentToken && a.status !== 'Revoked')) throw new Error('that agent is not yours in the Agent Registry');
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    const shopPayTo = loadProfile('merchant').accounts.find((a) => a.credNumber === 0)!.address;
    const insurer = loadProfile('insurer').accounts.find((a) => a.credNumber === 0)!.address;
    const param = encodeIssue({
      id, payer: owner, agentRegistry: AGENT_REGISTRY, agentToken: args.agentToken!, uri: 'https://kuasa-explorer.vercel.app/owner.html',
      maxTotal: 50_000_000n, validUntilMs: BigInt(Date.now() + 30 * 86_400_000), recorders: [shopPayTo, insurer],
    });
    const tx = Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: registry, receiveName: sdk.ReceiveName.fromString('kuasa.issue'), message: sdk.Parameter.fromBuffer(ab(param)) }, sdk.Energy.create(30_000)) as Transaction.Builder;
    return { transaction: await sponsored(grpc, tx, owner), mandateId: id, what: 'Give your agent a mandate: 50 EUDemo over 30 days' };
  }
  if (action === 'revoke') {
    if (!/^[0-9a-f]{64}$/.test(args.mandateId ?? '')) throw new Error('mandateId: 64 hex characters');
    const reason = Buffer.from(sdk.sha256([Buffer.from('revoked by its owner from the Concordium Wallet')])).toString('hex');
    const tx = Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: registry, receiveName: sdk.ReceiveName.fromString('kuasa.revoke'), message: sdk.Parameter.fromBuffer(ab(encodeRevoke(args.mandateId!, reason))) }, sdk.Energy.create(30_000)) as Transaction.Builder;
    return { transaction: await sponsored(grpc, tx, owner), what: 'Revoke the mandate' };
  }
  throw new Error('action: register, issue or revoke');
}

// ---- the owner's agent insures itself: test EUDemo from Concordium's allowlist, then a premium paid from the wallet ----

const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
/** The Web3 ID (V0) statement Concordium's EUDemo allowlist accepts: EU nationality. */
export const EUDEMO_STATEMENT = [{ type: 'AttributeInSet', attributeTag: 'nationality', set: EU }];
export const COVER_TERMS = { limit: 10_000_000n, deductible: 500_000n, premium: 500_000n, days: 7 };

async function credIdsOf(grpc: ConcordiumGRPCClient, owner: string) {
  const info = await grpc.getAccountInfo(sdk.AccountAddress.fromBase58(owner));
  return new Set(Object.values(info.accountCredentials).map((c) => (c.value.contents as { credId?: string; regId?: string }).credId ?? (c.value.contents as { regId?: string }).regId));
}

/**
 * Puts the owner's account on the EUDemo allow list and funds it with test EUDemo, the way Concordium's
 * allowlist dApp does: the wallet's EU-nationality proof (Web3 ID V0) is checked by Concordium's verifier,
 * then the distribution backend allow-lists and funds the account. The proof must come from this account.
 */
export async function getTestEudemo(grpc: ConcordiumGRPCClient, owner: string, presentation: string) {
  sdk.AccountAddress.fromBase58(owner);
  const p = JSON.parse(presentation) as { verifiableCredential?: { credentialSubject?: { id?: string } }[] };
  const ids = (p.verifiableCredential ?? []).map((c) => c.credentialSubject?.id?.match(/cred:([0-9a-f]{96})$/)?.[1]);
  const own = await credIdsOf(grpc, owner);
  if (!ids.length || ids.some((id) => !id || !own.has(id))) throw new Error('the proof is not from a credential of this account');
  const v = await fetch('https://web3id-verifier.testnet.concordium.com/v0/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: presentation, signal: AbortSignal.timeout(20_000) });
  if (!v.ok) throw new Error(`Concordium's verifier rejected the proof: ${v.status}`);
  const start = await fetch('https://allowlistapi.testnet.concordium.com/token-distribution/distribute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userAccount: owner, tokenId: 'EUDemo' }), signal: AbortSignal.timeout(20_000) });
  if (!start.ok) throw new Error(`the EUDemo distribution refused: ${start.status} ${(await start.text()).slice(0, 120)}`);
  const { processId } = await start.json() as { processId: string };
  for (let i = 0; i < 40; i++) {
    const s = await (await fetch(`https://allowlistapi.testnet.concordium.com/token-distribution/status/${processId}`, { signal: AbortSignal.timeout(15_000) })).json() as { status: string; error?: string; result?: { transactionHash?: string } };
    if (s.status === 'completed') return { tx: s.result?.transactionHash ?? null };
    if (s.status === 'failed') throw new Error(`the EUDemo distribution failed: ${s.error}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('the EUDemo distribution is still running; try again in a minute');
}

const insurerTreasury = () => loadProfile('insurer').accounts.find((x) => x.credNumber === 0)!.address;

/** The premium as a sponsored EUDemo transfer from the owner's account to Kuasa Cover's pool, memo naming the mandate. */
export async function preparePremium(grpc: ConcordiumGRPCClient, owner: string, mandateId: string) {
  if (!/^[0-9a-f]{64}$/.test(mandateId)) throw new Error('mandateId: 64 hex characters');
  const payload = sdk.createTokenUpdatePayload(sdk.TokenId.fromString('EUDemo'), {
    transfer: { amount: sdk.TokenAmount.create(COVER_TERMS.premium, 6), recipient: sdk.CborAccountAddress.fromAccountAddress(sdk.AccountAddress.fromBase58(insurerTreasury())), memo: sdk.CborMemo.fromString(`kuasa owner-cover ${mandateId}`) },
  } as never);
  const tx = Transaction.tokenUpdate(payload) as unknown as Transaction.Builder;
  return { transaction: await sponsored(grpc, tx, owner), what: `Pay the premium: ${Number(COVER_TERMS.premium) / 1e6} EUDemo for ${Number(COVER_TERMS.limit) / 1e6} EUDemo of cover over ${COVER_TERMS.days} days` };
}

const usedPremiums = new Set<string>();
/**
 * Issues the policy once the premium is on-chain: a finalized EUDemo transfer of the premium from the owner
 * to Kuasa Cover's pool whose memo names a live mandate this account issued for its own agent. Returns the
 * policy and its CIS-2 certificate (announced, so explorers list it).
 */
export async function issueOwnerCover(grpc: ConcordiumGRPCClient, owner: string, mandateId: string, agentToken: string, premiumTx: string) {
  if (!/^[0-9a-f]{64}$/.test(premiumTx) || !/^[0-9a-f]{64}$/.test(mandateId) || !/^[0-9a-f]{16}$/.test(agentToken)) throw new Error('premiumTx, mandateId, agentToken');
  if (usedPremiums.has(premiumTx)) throw new Error('this premium already bought a policy');
  if (!(await agentsOf(owner)).some((a) => a.tokenHex === agentToken && a.status !== 'Revoked')) throw new Error('that agent is not yours in the Agent Registry');
  const st = await grpc.getBlockItemStatus(sdk.TransactionHash.fromHexString(premiumTx));
  if (st.status !== 'finalized' || !st.outcome) throw new Error('the premium is not finalized yet');
  const sum = st.outcome.summary as unknown as { transactionType?: string; events?: { tag: string; tokenId: string; from: { address: string }; to: { address: string }; amount: { value: string }; memo?: unknown }[] };
  const tr = (sum.events ?? []).filter((e) => e.tag === 'TokenTransfer' && String(e.tokenId) === 'EUDemo' && String(e.to?.address) === insurerTreasury() && String(e.from?.address) === owner);
  if (sum.transactionType !== 'tokenUpdate' || tr.length !== 1 || BigInt(tr[0].amount.value) < COVER_TERMS.premium) throw new Error('not a premium transfer from this account into the pool');
  const memoJson = JSON.parse(JSON.stringify(tr[0].memo ?? null)) as unknown;
  const memo = typeof memoJson === 'string' ? Buffer.from(memoJson, 'hex').toString('utf8') : JSON.stringify(memoJson);
  if (!memo.includes(`kuasa owner-cover ${mandateId}`)) throw new Error('the premium does not name this mandate');
  const { KuasaCover, wallet, submit } = await import('@kuasa/chain');
  const op = loadProfile('insurer').accounts.find((x) => x.credNumber === 1)!;
  const coverIndex = 13105n;
  const cover = new KuasaCover(grpc, coverIndex);
  usedPremiums.add(premiumTx);
  const r = await cover.issuePolicy({
    holder: owner, agentPayer: owner, agentToken, mandate: { owner, id: mandateId }, kind: 'period',
    limit: COVER_TERMS.limit, deductible: COVER_TERMS.deductible, premium: COVER_TERMS.premium, premiumTx, validUntilMs: BigInt(Date.now() + COVER_TERMS.days * 86_400_000),
  } as never, wallet(op.address, op.key)).catch((e) => { usedPremiums.delete(premiumTx); throw e; });
  const policyId = KuasaCover.idFromEvents(r.summary, coverIndex);
  if (policyId === null) throw new Error(`policy issued but its id is unreadable (tx ${r.hash})`);
  const param = new Uint8Array([8, ...new Uint8Array(new BigUint64Array([policyId]).buffer)]);
  const a = await submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: sdk.ContractAddress.create(13120n, 0n), receiveName: sdk.ReceiveName.fromString('kuasa_certificate.announce'), message: sdk.Parameter.fromBuffer(param.buffer) }, sdk.Energy.create(30_000)) as Transaction.Builder, wallet(op.address, op.key));
  return { policyId: String(policyId), policyTx: r.hash, certificate: { contract: '<13120,0>', index: '13120', tokenId: Buffer.from(new BigUint64Array([policyId]).buffer).toString('hex'), announceTx: a.hash } };
}
