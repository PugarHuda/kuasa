import { R, W } from './registry.js';

/**
 * Binary codec for the kuasa-cover contract (contracts/kuasa-cover). Layouts are pinned by
 * test/cover-vectors.json, which the contract's own tests check too.
 */

export type PolicyKind = 'period' | { order: string };
export type ClaimKind = 'AgentMistake' | 'WrongItem' | 'MerchantLoss';
export type ClaimStatus =
  | { tag: 'Filed' }
  | { tag: 'Assessed'; ok: boolean; reason: string }
  | { tag: 'Approved' }
  | { tag: 'Rejected' }
  | { tag: 'Paid'; payoutTx: string }
  | { tag: 'Fraud'; disclosure: string };

export type IssuePolicyParams = {
  holder: string;
  agentPayer: string;
  agentToken: string;
  mandate: { owner: string; id: string };
  kind: PolicyKind;
  limit: bigint;
  deductible: bigint;
  premium: bigint;
  premiumTx: string;
  validUntilMs: bigint;
};

export type Policy = IssuePolicyParams & { validFromMs: bigint; paidOut: bigint; status: 'Active' | 'Cancelled' };

export type FileClaimParams = { policyId: bigint; kind: ClaimKind; amount: bigint; evidence: string; orders: string[] };

export type Claim = FileClaimParams & { claimant: string; status: ClaimStatus; payout: bigint };

export type CoverView = { periodRemaining: bigint; orderLimit: bigint; policyId: bigint | null };

const CLAIM_KINDS: ClaimKind[] = ['AgentMistake', 'WrongItem', 'MerchantLoss'];

export function encodeIssuePolicy(p: IssuePolicyParams): Uint8Array {
  const w = new W().account(p.holder).account(p.agentPayer).str(p.agentToken).account(p.mandate.owner).hash(p.mandate.id);
  if (p.kind === 'period') w.u8(0);
  else w.u8(1).hash(p.kind.order);
  return w.u64(p.limit).u64(p.deductible).u64(p.premium).hash(p.premiumTx).u64(p.validUntilMs).done();
}

export function encodeFileClaim(p: FileClaimParams): Uint8Array {
  const w = new W().u64(p.policyId).u8(CLAIM_KINDS.indexOf(p.kind)).u64(p.amount).hash(p.evidence).u32(p.orders.length);
  p.orders.forEach((o) => w.hash(o));
  return w.done();
}

export const encodeAssess = (claimId: bigint, ok: boolean, reason: string) => new W().u64(claimId).u8(ok ? 1 : 0).hash(reason).done();
export const encodeDecide = (claimId: bigint, approve: boolean) => new W().u64(claimId).u8(approve ? 1 : 0).done();
export const encodePayout = (claimId: bigint, payoutTx: string, amount: bigint) => new W().u64(claimId).hash(payoutTx).u64(amount).done();
export const encodeFraud = (claimId: bigint, disclosure: string) => new W().u64(claimId).hash(disclosure).done();
export const encodeU64 = (n: bigint) => new W().u64(n).done();

export function encodeCoverQuery(payer: string, order?: string): Uint8Array {
  const w = new W().account(payer);
  return (order ? w.u8(1).hash(order) : w.u8(0)).done();
}

export function decodeCoverView(bytes: Uint8Array): CoverView {
  const r = new R(bytes);
  const v = { periodRemaining: r.u64(), orderLimit: r.u64(), policyId: r.u8() === 1 ? r.u64() : null };
  r.end();
  return v;
}

/** Decodes `Option<Policy>` as returned by the `policy` view. */
export function decodePolicy(bytes: Uint8Array): Policy | null {
  const r = new R(bytes);
  if (r.u8() === 0) { r.end(); return null; }
  const p: Policy = {
    holder: r.account(),
    agentPayer: r.account(),
    agentToken: r.str(),
    mandate: { owner: r.account(), id: r.hash() },
    kind: r.u8() === 0 ? 'period' : { order: r.hash() },
    limit: r.u64(),
    deductible: r.u64(),
    premium: r.u64(),
    premiumTx: r.hash(),
    validFromMs: r.u64(),
    validUntilMs: r.u64(),
    paidOut: r.u64(),
    status: r.u8() === 0 ? 'Active' : 'Cancelled',
  };
  r.end();
  return p;
}

function readStatus(r: R): ClaimStatus {
  switch (r.u8()) {
    case 0: return { tag: 'Filed' };
    case 1: return { tag: 'Assessed', ok: r.bool(), reason: r.hash() };
    case 2: return { tag: 'Approved' };
    case 3: return { tag: 'Rejected' };
    case 4: return { tag: 'Paid', payoutTx: r.hash() };
    case 5: return { tag: 'Fraud', disclosure: r.hash() };
    default: throw new Error('unknown claim status');
  }
}

/** Decodes `Option<Claim>` as returned by the `claim` view. */
export function decodeClaim(bytes: Uint8Array): Claim | null {
  const r = new R(bytes);
  if (r.u8() === 0) { r.end(); return null; }
  const policyId = r.u64();
  const claimant = r.account();
  const kind = CLAIM_KINDS[r.u8()];
  if (!kind) throw new Error('unknown claim kind');
  const c: Claim = {
    policyId, claimant, kind, amount: r.u64(), evidence: r.hash(),
    orders: Array.from({ length: r.u32() }, () => r.hash()),
    status: readStatus(r), payout: r.u64(),
  };
  r.end();
  return c;
}

export type RegistryEvent =
  | { type: 'Issued'; id: string; owner: string; payer: string; maxTotal: bigint; validUntilMs: bigint }
  | { type: 'Revoked'; id: string; by: string; reason: string }
  | { type: 'Receipt'; owner: string; id: string; order: string; paymentTx: string; amount: bigint; spent: bigint }
  | { type: 'Incident'; owner: string; id: string; evidence: string };

/** Decodes one kuasa-registry event log entry; unknown tags yield null. */
export function decodeRegistryEvent(bytes: Uint8Array): RegistryEvent | null {
  const r = new R(bytes);
  switch (r.u8()) {
    case 0: return { type: 'Issued', id: r.hash(), owner: r.account(), payer: r.account(), maxTotal: r.u64(), validUntilMs: r.u64() };
    case 1: return { type: 'Revoked', id: r.hash(), by: r.account(), reason: r.hash() };
    case 2: return { type: 'Receipt', owner: r.account(), id: r.hash(), order: r.hash(), paymentTx: r.hash(), amount: r.u64(), spent: r.u64() };
    case 3: {
      const owner = r.account(), id = r.hash();
      if (r.u8() === 0) r.account(); else { r.u64(); r.u64(); } // reporter: Address
      return { type: 'Incident', owner, id, evidence: r.hash() };
    }
    default: return null;
  }
}
