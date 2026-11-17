import type { Mandate } from './mandate.js';
import { type Claims, type Requirements, unmetRequirements } from './claims.js';

/** Mandate state as stored in the on-chain Kuasa registry. */
export type MandateState = {
  status: 'active' | 'revoked';
  spent: bigint;
  maxTotal: bigint;
  validUntil: number;
  payer: string;
  /** sha256 of the off-chain mandate document */
  docSha256: string;
};

export type Order = {
  payer: string; // sender of the x402 payment transaction
  merchant: string; // payTo
  asset: string;
  amount: bigint;
  category: string;
  now: number; // unix seconds
};

export type Decision = { ok: true } | { ok: false; reasons: string[] };

/**
 * The single authorization decision for "may this agent buy this, right now?".
 * Pure: every input is already fetched and verified by the caller.
 */
export function authorize(args: {
  mandate: Mandate;
  docSha256: string; // hash of the mandate document as received
  state: MandateState | null;
  claims: Claims; // derived from a cryptographically verified presentation
  requirements: Requirements;
  order: Order;
}): Decision {
  const { mandate: m, state, order: o } = args;
  const r: string[] = [];

  if (!state) return { ok: false, reasons: ['mandate not registered on-chain'] };
  if (state.docSha256 !== args.docSha256) r.push('mandate document does not match on-chain hash');
  if (state.status !== 'active') r.push(`mandate ${state.status}`);
  if (o.now < m.scope.validFrom) r.push('mandate not yet valid');
  if (o.now > Math.min(m.scope.validUntil, state.validUntil)) r.push('mandate expired');

  // Only the delegated agent may spend: the x402 sender must be the mandate's payer account.
  if (o.payer !== m.agent.payer || o.payer !== state.payer) r.push('payer is not the mandated agent');

  if (o.asset !== m.scope.asset) r.push(`asset ${o.asset} not allowed (mandate: ${m.scope.asset})`);
  if (o.amount > BigInt(m.scope.maxPerOrder)) r.push('amount exceeds per-order limit');
  if (state.spent + o.amount > state.maxTotal) r.push('amount exceeds remaining mandate budget');
  if (!m.scope.categories.includes(o.category)) r.push(`category "${o.category}" not in mandate`);
  if (m.scope.merchants?.length && !m.scope.merchants.includes(o.merchant)) r.push('merchant not in mandate allowlist');

  r.push(...unmetRequirements(args.claims, args.requirements));
  return r.length ? { ok: false, reasons: r } : { ok: true };
}
