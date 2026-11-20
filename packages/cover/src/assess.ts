/**
 * Kuasa Cover claim assessor: deterministic rules over on-chain receipts. It only recommends;
 * a human claims handler approves before anything is paid.
 *
 * Non-delivery is deliberately not covered (Concordium's Protocol-Enforced Escrow handles that).
 */

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
};

export type Assessment = { ok: boolean; reason: string; payout: bigint; noEvidence: boolean };

const DUPLICATE_WINDOW_MS = 10 * 60_000;
const no = (reason: string, noEvidence = false): Assessment => ({ ok: false, reason, payout: 0n, noEvidence });

export function assess(i: AssessInput): Assessment {
  const { claim, policy } = i;
  if (!['AgentMistake', 'WrongItem', 'MerchantLoss'].includes(claim.kind)) return no('unsupported claim kind');
  if (claim.orders.length === 0 || claim.amount <= 0n) return no('a claim needs at least one order and a positive amount');
  const matched = [];
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

  switch (claim.kind) {
    case 'AgentMistake': {
      if (matched.length !== 2) return no('an agent mistake (duplicate order) needs two receipts');
      const [a, b] = matched;
      if (a.order === b.order) return no('a duplicate order needs two different orders');
      if (a.paymentTx !== undefined && a.paymentTx === b.paymentTx) return no('a duplicate order needs two different payments');
      if (a.amount !== b.amount) return no('duplicate orders must have the same amount');
      if (Math.abs(a.at - b.at) > DUPLICATE_WINDOW_MS) return no('duplicate orders must be within 10 minutes of each other');
      break;
    }
    case 'WrongItem':
      if (matched.length !== 1) return no('a wrong-item claim covers exactly one receipt');
      break;
    case 'MerchantLoss':
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
  return { ok: true, reason: 'receipt matched on-chain', payout, noEvidence: false };
}
