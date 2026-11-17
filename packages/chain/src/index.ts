import {
  AccountAddress, type AccountSigner, buildBasicAccountSigner, CcdAmount, type ConcordiumGRPCClient, ContractAddress,
  DataBlob, Energy, Parameter, ReceiveName, ReturnValue, TransactionExpiry, TransactionHash,
} from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { Transaction } from '@concordium/web-sdk/transactions';
import {
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
  const { nonce } = await grpc.getNextAccountNonce(from.address);
  const configured = tx.addMetadata({ sender: from.address, nonce, expiry: TransactionExpiry.futureMinutes(10) });
  const signable = sponsor
    ? await Transaction.sponsor(await Transaction.sign(configured.addSponsor(sponsor.address).build(), from.signer) as Parameters<typeof Transaction.sponsor>[0], sponsor.signer)
    : await Transaction.sign(configured.build(), from.signer);
  const hash = await grpc.sendTransaction(Transaction.finalize(signable));
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
  recordReceipt = (owner: string, id: string, orderHex: string, paymentTxHex: string, amount: bigint, recorder: Wallet) =>
    this.update('recordReceipt', encodeReceipt(owner, id, orderHex, paymentTxHex, amount), recorder);
  reportIncident = (owner: string, id: string, evidenceHex: string, reporter: Wallet, sponsor?: Wallet) =>
    this.update('reportIncident', encodeIncident(owner, id, evidenceHex), reporter, sponsor);
}
