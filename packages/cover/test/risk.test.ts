import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote, type RiskInput } from '../src/index.js';

const EUR = 1_000_000n;
const base: RiskInput = {
  limit: 100n * EUR, days: 30,
  mandate: { maxPerOrder: 50n * EUR, categories: ['wine'], merchants: ['shop'] },
  provenAgeAndResidency: true, ownerKind: 'person', incidents: 0, receipts: 0,
};
const premium = (over: Partial<RiskInput>) => {
  const q = quote({ ...base, ...over });
  if ('refused' in q) throw new Error(q.refused);
  return q.premium;
};

test('golden case: 2% base x tightness 0.9 x allowlist 0.9 x wine 1.2 x proven 0.9', () => {
  const q = quote(base);
  assert.ok(!('refused' in q));
  assert.equal(q.premium, 1_749_600n);
  assert.deepEqual(q.factors.map((f) => [f.name, f.multiplier]), [
    ['base', 1], ['mandate tightness', 0.9], ['merchant allowlist', 0.9], ['category', 1.2], ['proven attributes', 0.9],
  ]);
  assert.ok(q.factors.every((f) => f.reason.length > 0), 'every factor explains itself');
});

test('pro-rata by days', () => {
  assert.equal(premium({ days: 15 }), 874_800n);
});

test('tighter mandates are cheaper, looser ones are not discounted', () => {
  assert.equal(premium({ mandate: { ...base.mandate, maxPerOrder: 25n * EUR } }), 1_555_200n); // x0.8
  assert.equal(premium({ mandate: { ...base.mandate, maxPerOrder: 80n * EUR } }), 1_944_000n); // x1.0
});

test('highest category risk applies; unknown categories are refused', () => {
  assert.equal(premium({ mandate: { ...base.mandate, categories: ['groceries', 'vape'] } }), 2_041_200n); // x1.4
  assert.deepEqual(quote({ ...base, mandate: { ...base.mandate, categories: ['weapons'] } }), { refused: 'unknown category: weapons' });
});

test('owner kind and history', () => {
  assert.equal(premium({ ownerKind: 'business' }), 1_487_160n); // x0.85
  assert.equal(premium({ incidents: 1 }), 2_187_000n); // x1.25
  assert.equal(premium({ receipts: 10 }), 1_574_640n); // -10% => x0.9
  assert.equal(premium({ receipts: 1000 }), 1_224_720n); // floor x0.7
});

test('order top-up is max(1.5% of the order, 0.10)', () => {
  assert.equal(premium({ order: { amount: 60n * EUR } }), 900_000n);
  assert.equal(premium({ order: { amount: 1n * EUR } }), 100_000n);
});

test('rejects nonsense input', () => {
  assert.ok('refused' in quote({ ...base, limit: 0n }));
  assert.ok('refused' in quote({ ...base, days: 0 }));
});

test('prototype keys are not categories', () => {
  for (const c of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(quote({ ...base, mandate: { ...base.mandate, categories: [c] } }), { refused: `unknown category: ${c}` });
  }
});

test('experience rating: paid claims raise the premium 20% each (max x2) and cancel the claim-free discount', () => {
  assert.equal(premium({ paidClaims: 1 }), 2_099_520n);
  assert.equal(premium({ paidClaims: 9 }), 3_499_200n);
  assert.equal(premium({ paidClaims: 1, receipts: 10 }), 2_099_520n, 'no claim-free discount after a paid claim');
  const q = quote({ ...base, paidClaims: 1 });
  assert.ok(!('refused' in q) && q.factors.some((f) => f.name === 'claims history' && f.multiplier === 1.2));
});

test('roadmap factors: an operator bond lowers the period premium; order velocity raises per-order cover', () => {
  const plain = quote({ ...base });
  const bonded = quote({ ...base, bonded: true });
  assert.ok(!('refused' in plain) && !('refused' in bonded));
  assert.ok(bonded.premium < plain.premium);
  assert.ok(bonded.factors.some((f) => f.name === 'operator bond'));
  const calm = quote({ ...base, order: { amount: 20_000_000n }, recentOrders: 2 });
  const fast = quote({ ...base, order: { amount: 20_000_000n }, recentOrders: 5 });
  assert.ok(!('refused' in calm) && !('refused' in fast));
  assert.equal(calm.premium, 300_000n);
  assert.equal(fast.premium, 525_000n, '1.5% x (1 + 0.25 x 3)');
  const loop = quote({ ...base, order: { amount: 20_000_000n }, recentOrders: 12 });
  assert.ok(!('refused' in loop));
  assert.equal(loop.premium, 600_000n, 'capped at x2');
});
