import { AccountAddress } from '@concordium/web-sdk';
import type { MandateState } from './policy.js';

/**
 * Binary codec for the kuasa-registry contract (concordium-std `Serial` layout:
 * little-endian ints, u32-length-prefixed strings/vecs, u8 option/bool tags).
 * Hand-written so callers need no schema; covered by round-trip tests.
 */

export type MandateEntry = {
  owner: string;
  payer: string;
  agentRegistry: { index: bigint; subindex: bigint };
  agentToken: string;
  uri: string;
  maxTotal: bigint;
  spent: bigint;
  validUntilMs: bigint;
  revoked: boolean;
  recorders: string[];
  receipts: bigint;
  incidents: bigint;
};

export type IssueParams = {
  id: string; // 64 hex
  payer: string;
  agentRegistry: { index: bigint; subindex: bigint };
  agentToken: string;
  uri: string;
  maxTotal: bigint;
  validUntilMs: bigint;
  recorders: string[];
};

/** concordium-std `Serial` writer (little-endian, u32-length strings/vecs). */
export class W {
  private parts: number[] = [];
  u8(n: number) { this.parts.push(n & 0xff); return this; }
  u32(n: number) { for (let i = 0; i < 4; i++) this.parts.push((n >>> (8 * i)) & 0xff); return this; }
  u64(n: bigint) { for (let i = 0n; i < 8n; i++) this.parts.push(Number((n >> (8n * i)) & 0xffn)); return this; }
  bytes(b: Uint8Array) { this.parts.push(...b); return this; }
  str(s: string) { const b = new TextEncoder().encode(s); return this.u32(b.length).bytes(b); }
  account(a: string) { return this.bytes(AccountAddress.fromBase58(a).decodedAddress); }
  hash(hex: string) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('hash must be 64 hex chars');
    return this.bytes(Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))));
  }
  done() { return Uint8Array.from(this.parts); }
}

/** concordium-std `Deserial` reader. */
export class R {
  private o = 0;
  constructor(private b: Uint8Array) {}
  private take(n: number) {
    if (this.o + n > this.b.length) throw new Error('unexpected end of buffer');
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  u8() { return this.take(1)[0]; }
  u32() { const s = this.take(4); return (s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) >>> 0; }
  u64() { const s = this.take(8); let n = 0n; for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(s[i]); return n; }
  str() { return new TextDecoder().decode(this.take(this.u32())); }
  account() { return AccountAddress.fromBuffer(this.take(32).slice().buffer).address; }
  hash() { return Buffer.from(this.take(32)).toString('hex'); }
  bool() { return this.u8() === 1; }
  end() { if (this.o !== this.b.length) throw new Error('trailing bytes'); }
}

export function encodeIssue(p: IssueParams): Uint8Array {
  const w = new W().hash(p.id).account(p.payer).u64(p.agentRegistry.index).u64(p.agentRegistry.subindex)
    .str(p.agentToken).str(p.uri).u64(p.maxTotal).u64(p.validUntilMs).u32(p.recorders.length);
  p.recorders.forEach((r) => w.account(r));
  return w.done();
}

export const encodeRevoke = (id: string, reasonHex: string) => new W().hash(id).hash(reasonHex).done();

/** Mandates are keyed on-chain by (owner, id) so ids cannot be squatted by other owners. */
export const encodeMandateKey = (owner: string, id: string) => new W().account(owner).hash(id).done();

export const encodeReceipt = (owner: string, id: string, orderHex: string, paymentTxHex: string, amount: bigint) =>
  new W().account(owner).hash(id).hash(orderHex).hash(paymentTxHex).u64(amount).done();

export const encodeIncident = (owner: string, id: string, evidenceHex: string) =>
  new W().account(owner).hash(id).hash(evidenceHex).done();

/** Encodes an `Option<MandateEntry>` exactly as the contract's `view` returns it (for tests/fixtures). */
export function encodeViewResult(m: MandateEntry | null): Uint8Array {
  const w = new W();
  if (!m) return w.u8(0).done();
  w.u8(1).account(m.owner).account(m.payer).u64(m.agentRegistry.index).u64(m.agentRegistry.subindex)
    .str(m.agentToken).str(m.uri).u64(m.maxTotal).u64(m.spent).u64(m.validUntilMs).u8(m.revoked ? 1 : 0)
    .u32(m.recorders.length);
  m.recorders.forEach((r) => w.account(r));
  return w.u64(m.receipts).u64(m.incidents).done();
}

export function decodeViewResult(bytes: Uint8Array): MandateEntry | null {
  const r = new R(bytes);
  if (r.u8() === 0) { r.end(); return null; }
  const m: MandateEntry = {
    owner: r.account(),
    payer: r.account(),
    agentRegistry: { index: r.u64(), subindex: r.u64() },
    agentToken: r.str(),
    uri: r.str(),
    maxTotal: r.u64(),
    spent: r.u64(),
    validUntilMs: r.u64(),
    revoked: r.u8() === 1,
    recorders: Array.from({ length: r.u32() }, () => r.account()),
    receipts: r.u64(),
    incidents: r.u64(),
  };
  r.end();
  return m;
}

/** Adapts an on-chain entry to the policy engine's view. */
export function toMandateState(m: MandateEntry, docSha256: string): MandateState {
  return {
    owner: m.owner,
    status: m.revoked ? 'revoked' : 'active',
    spent: m.spent,
    maxTotal: m.maxTotal,
    validUntil: Number(m.validUntilMs / 1000n),
    payer: m.payer,
    docSha256,
  };
}
