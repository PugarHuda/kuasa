import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, findDuplicates, type SeenReceipt } from '../src/index.js';

const MIN = 60_000;
const r = (order: string, at: number, amount = 3_000_000n, mandateId = 'm1'): SeenReceipt => ({ owner: 'alice', mandateId, order, paymentTx: `p-${order}`, amount, at, receiptTx: `r-${order}` });

test('detects a duplicate pair exactly as the assessor would accept it, once per order', () => {
  const seen = [r('a', 0), r('b', 2 * MIN), r('c', 3 * MIN), r('d', 30 * MIN), r('e', 31 * MIN, 5_000_000n), r('f', 31 * MIN, 3_000_000n, 'm2')];
  const d = findDuplicates(seen);
  assert.deepEqual(d.map((x) => x.orders), [['a', 'b']], 'c pairs with nothing left; d/e differ in amount; f is another mandate');
  assert.deepEqual(findDuplicates(seen, new Set(['a'])).map((x) => x.orders), [['b', 'c']], 'already-claimed orders are skipped');
  const [a, b] = [seen[0], seen[1]];
  const verdict = assess({
    claim: { kind: 'AgentMistake', amount: a.amount, orders: d[0].orders },
    policy: { validFromMs: -1, validUntilMs: 99 * MIN, limit: 50_000_000n, paidOut: 0n, deductible: 1_000_000n, mandateId: 'm1', owner: 'alice' },
    receipts: [a, b], priorPaidOrders: [], incidentFiled: false,
  });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.deepEqual(findDuplicates([r('x', 0), r('y', 11 * MIN)]), [], 'outside the 10-minute window');
});
