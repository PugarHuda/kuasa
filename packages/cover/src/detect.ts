import { DUPLICATE_WINDOW_MS } from './assess.js';

/** A receipt seen on-chain (kuasa-registry Receipt event) with the transaction that recorded it. */
export type SeenReceipt = { owner: string; mandateId: string; order: string; paymentTx: string; amount: bigint; at: number; receiptTx: string };
export type Duplicate = { owner: string; mandateId: string; amount: bigint; orders: [string, string]; paymentTxs: [string, string]; receiptTxs: [string, string]; at: number };

/**
 * Parametric trigger for AM10: two receipts on the same mandate with the same amount, different
 * payments, within the duplicate window. Uses exactly the rule the assessor applies, so a detected
 * pair, once filed, is assessed positive. Each order is used in at most one pair.
 */
export function findDuplicates(receipts: SeenReceipt[], used: ReadonlySet<string> = new Set()): Duplicate[] {
  const out: Duplicate[] = [];
  const taken = new Set(used);
  const sorted = [...receipts].sort((a, b) => a.at - b.at);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (taken.has(a.order)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.at - a.at > DUPLICATE_WINDOW_MS) break;
      if (taken.has(b.order) || b.mandateId !== a.mandateId || b.owner !== a.owner || b.amount !== a.amount || b.paymentTx === a.paymentTx || b.order === a.order) continue;
      taken.add(a.order).add(b.order);
      out.push({ owner: a.owner, mandateId: a.mandateId, amount: a.amount, orders: [a.order, b.order], paymentTxs: [a.paymentTx, b.paymentTx], receiptTxs: [a.receiptTx, b.receiptTx], at: b.at });
      break;
    }
  }
  return out;
}
