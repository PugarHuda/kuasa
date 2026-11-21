/**
 * Kuasa Cover claim assessor: deterministic rules over on-chain receipts. It only recommends;
 * a human claims handler approves before anything is paid.
 *
 * Non-delivery is deliberately not covered (Concordium's Protocol-Enforced Escrow handles that).
 */

import { defaultReason, REASON_CODES, type ReasonCode } from '@kuasa/core';

export type AssessInput = {
  claim: { kind: 'AgentMistake' | 'WrongItem' | 'MerchantLoss'; amount: bigint; orders: string[] };
  policy: {
    validFromMs: number; validUntilMs: number; limit: bigint; paidOut: bigint; deductible: bigint; mandateId: string; owner: string;
    /** Set for per-order cover: only the insured order is covered. */
    orderRef?: string;
  };
  /** Receipt events found on-chain for the claimed orders (with block time in ms). */
  receipts: {
    order: string; amount: bigint; at: number; mandateId: string; owner: string;
    /** Payment transaction the receipt records (duplicates must be different payments). */
    paymentTx?: string;
    /** For per-order cover: whether this receipt was recorded with the policy's order reference. */
    matchesOrderRef?: boolean;
  }[];
  /** When the mandate was revoked, if it was. Orders after that are not covered. */
  revokedAt?: number;
  /** Orders already paid or claimed under any policy of the same mandate (no double cover). */
  priorPaidOrders: string[];
  /** An incident is on file for the mandate (required for MerchantLoss). */
  incidentFiled: boolean;
  /** Chargeback-style reason code from the claim's evidence (defaults by kind). */
  reason?: ReasonCode;
  /** Delivery notes whose signature by the receipt's recorder was already verified. */
  delivery?: { order: string; paymentTx: string; ordered: string; shipped: string }[];
  /** SKUs of the AP2 intent the policy was bought under, if any. */
  intentSkus?: string[];
};

/** loss: the verified loss (claim capped by the matched receipt), before the deductible and the limit. */
export type Assessment = { ok: boolean; reason: string; payout: bigint; noEvidence: boolean; loss?: bigint };

export const DUPLICATE_WINDOW_MS = 10 * 60_000;
const no = (reason: string, noEvidence = false): Assessment => ({ ok: false, reason, payout: 0n, noEvidence });

export function assess(i: AssessInput): Assessment {
  const { claim, policy } = i;
  if (!['AgentMistake', 'WrongItem', 'MerchantLoss'].includes(claim.kind)) return no('unsupported claim kind');
  if (claim.orders.length === 0 || claim.amount <= 0n) return no('a claim needs at least one order and a positive amount');
  const matched: AssessInput['receipts'] = [];
  for (const order of claim.orders) {
    const r = i.receipts.find((x) => x.order === order && x.mandateId === policy.mandateId && x.owner === policy.owner);
    if (!r) return no(`no on-chain evidence for order ${order}`, true);
    matched.push(r);
  }
  const coverEnds = i.revokedAt !== undefined && i.revokedAt < policy.validUntilMs ? i.revokedAt : policy.validUntilMs;
  for (const r of matched) {
    if (r.at < policy.validFromMs || r.at > coverEnds) return no(`order ${r.order} is outside the policy period (or after the mandate was revoked)`);
    if (i.priorPaidOrders.includes(r.order)) return no(`order ${r.order} was already paid`);
    if (policy.orderRef !== undefined && r.matchesOrderRef !== true) return no(`order ${r.order} is not the order this cover insured`);
  }

  const reason = i.reason ?? defaultReason(claim.kind);
  if (!Object.hasOwn(REASON_CODES, reason) || REASON_CODES[reason].kind !== claim.kind) return no(`reason code ${reason} does not fit a ${claim.kind} claim`);
  const noteFor = (r: (typeof matched)[number]) => i.delivery?.find((d) => d.order === r.order && (r.paymentTx === undefined || d.paymentTx === r.paymentTx));

  switch (reason) {
    case 'AM20': {
      if (matched.length !== 1) return no('an outside-intent claim covers exactly one receipt');
      if (!i.intentSkus?.length) return no('this policy was not bought under an owner-signed AP2 intent that names SKUs');
      const d = noteFor(matched[0]);
      if (!d) return no('an outside-intent claim needs the merchant-signed delivery note for the order');
      if (i.intentSkus.includes(d.ordered)) return no(`${d.ordered} is inside the user’s AP2 intent`);
      break;
    }
    case 'AM10': {
      if (matched.length !== 2) return no('an agent mistake (duplicate order) needs two receipts');
      const [a, b] = matched;
      if (a.order === b.order) return no('a duplicate order needs two different orders');
      if (a.paymentTx !== undefined && a.paymentTx === b.paymentTx) return no('a duplicate order needs two different payments');
      if (a.amount !== b.amount) return no('duplicate orders must have the same amount');
      if (Math.abs(a.at - b.at) > DUPLICATE_WINDOW_MS) return no('duplicate orders must be within 10 minutes of each other');
      break;
    }
    case 'WI10': {
      if (matched.length !== 1) return no('a wrong-item claim covers exactly one receipt');
      const d = noteFor(matched[0]);
      if (!d) return no('a wrong-item claim needs the merchant-signed delivery note for the order');
      if (d.shipped === d.ordered) return no(`the merchant’s delivery note shows the ordered item (${d.ordered}) was shipped`);
      break;
    }
    case 'ML10':
      if (matched.length !== 1) return no('a merchant-loss claim covers exactly one receipt');
      if (!i.incidentFiled) return no('a merchant-loss claim needs an incident filed on the mandate');
      break;
    default:
      return no('unsupported claim kind');
  }

  const loss = claim.amount < matched[0].amount ? claim.amount : matched[0].amount;
  if (loss <= policy.deductible) return no('loss is at or below the deductible');
  const remaining = policy.limit - policy.paidOut;
  const due = loss - policy.deductible;
  const payout = due < remaining ? due : remaining;
  if (payout <= 0n) return no('policy limit exhausted');
  const why = reason === 'AM10' || reason === 'ML10' ? 'receipt matched on-chain' : `${reason} ${REASON_CODES[reason].label}: receipt matched on-chain, merchant-signed delivery note verified`;
  return { ok: true, reason: why, payout, noEvidence: false, loss };
}
