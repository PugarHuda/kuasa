import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, type AssessInput } from '../src/index.js';

const EUR = 1_000_000n;
const MIN = 60_000;
const T0 = 1_800_000_000_000;
const receipt = (order: string, at = T0 + MIN, amount = 24n * EUR) => ({ order, amount, at, mandateId: 'm1', owner: 'alice' });
const base: AssessInput = {
  claim: { kind: 'WrongItem', amount: 24n * EUR, orders: ['o1'] },
  policy: { validFromMs: T0, validUntilMs: T0 + 30 * 24 * 60 * MIN, limit: 100n * EUR, paidOut: 0n, deductible: EUR, mandateId: 'm1', owner: 'alice' },
  receipts: [receipt('o1')],
  priorPaidOrders: [],
  incidentFiled: false,
  delivery: [{ order: 'o1', paymentTx: 'p1', ordered: '/shop/wine/rioja', shipped: '/shop/vape/mint' }],
};
const run = (over: Omit<Partial<AssessInput>, 'claim'> & { claim?: Partial<AssessInput['claim']> } = {}) =>
  assess({ ...base, ...over, claim: { ...base.claim, ...over.claim } });

test('WI10 wrong item: receipt + merchant-signed note showing another item, payout = amount - deductible', () => {
  assert.deepEqual(run(), { ok: true, reason: 'WI10 wrong item shipped: receipt matched on-chain, merchant-signed delivery note verified', payout: 23n * EUR, noEvidence: false, loss: 24n * EUR });
  assert.match(run({ delivery: undefined }).reason, /delivery note/);
  assert.match(run({ delivery: [{ order: 'o1', paymentTx: 'p1', ordered: '/shop/wine/rioja', shipped: '/shop/wine/rioja' }] }).reason, /ordered item .* was shipped/);
  assert.match(run({ delivery: [{ order: 'other', paymentTx: 'p1', ordered: 'a', shipped: 'b' }] }).reason, /delivery note/, 'note must be for the claimed order');
  assert.match(run({ reason: 'AM10' }).reason, /does not fit a WrongItem/);
});

test('AM20 outside the user intent (prompt injection): needs the policy AP2 SKUs and a note for an item outside them', () => {
  const am20 = { claim: { kind: 'AgentMistake' as const }, reason: 'AM20' as const, intentSkus: ['/shop/groceries/bread'] };
  assert.equal(run(am20).ok, true);
  assert.match(run(am20).reason, /^AM20/);
  assert.match(run({ ...am20, intentSkus: undefined }).reason, /AP2 intent/);
  assert.match(run({ ...am20, intentSkus: ['/shop/wine/rioja'] }).reason, /inside the user/);
  assert.match(run({ ...am20, delivery: [] }).reason, /delivery note/);
});

test('AgentMistake needs two matching receipts', () => {
  const twice = { claim: { kind: 'AgentMistake' as const, orders: ['o1', 'o2'] }, receipts: [receipt('o1'), receipt('o2', T0 + 3 * MIN)] };
  assert.equal(run(twice).ok, true);
  assert.equal(run(twice).payout, 23n * EUR);
  assert.match(run({ ...twice, claim: { kind: 'AgentMistake', orders: ['o1'] } }).reason, /two receipts/);
  assert.match(run({ ...twice, receipts: [receipt('o1'), receipt('o2', T0 + 3 * MIN, 10n * EUR)] }).reason, /same amount/);
  assert.match(run({ ...twice, receipts: [receipt('o1'), receipt('o2', T0 + 20 * MIN)] }).reason, /10 minutes/);
});

test('MerchantLoss needs a receipt and a filed incident', () => {
  assert.match(run({ claim: { kind: 'MerchantLoss' } }).reason, /incident/);
  assert.equal(run({ claim: { kind: 'MerchantLoss' }, incidentFiled: true }).ok, true);
});

test('rejects receipt after revoke or outside period', () => {
  assert.match(run({ revokedAt: T0 + 30_000 }).reason, /outside the policy period/);
  assert.match(run({ receipts: [receipt('o1', T0 - MIN)] }).reason, /outside the policy period/);
  assert.match(run({ receipts: [receipt('o1', T0 + 31 * 24 * 60 * MIN)] }).reason, /outside the policy period/);
});

test('rejects foreign mandate receipt', () => {
  const r = run({ receipts: [{ ...receipt('o1'), mandateId: 'other' }] });
  assert.deepEqual([r.ok, r.noEvidence], [false, true]);
  assert.match(r.reason, /no on-chain evidence/);
});

test('missing receipt counts as no evidence (fraud signal)', () => {
  assert.deepEqual(run({ receipts: [] }), { ok: false, reason: 'no on-chain evidence for order o1', payout: 0n, noEvidence: true });
});

test('already paid order is refused', () => {
  assert.match(run({ priorPaidOrders: ['o1'] }).reason, /already paid/);
});

test('caps payout at remaining limit; refuses at or below the deductible', () => {
  assert.equal(run({ policy: { ...base.policy, paidOut: 90n * EUR } }).payout, 10n * EUR);
  assert.match(run({ claim: { amount: EUR } }).reason, /deductible/);
  assert.equal(run({ claim: { amount: 50n * EUR } }).payout, 23n * EUR, 'never more than the receipt');
});

test('fails closed on malformed claims', () => {
  assert.equal(run({ claim: { orders: [] } }).ok, false);
  assert.equal(run({ claim: { amount: 0n } }).ok, false);
  assert.equal(run({ claim: { kind: 'Whatever' as never } }).ok, false);
});

test('AgentMistake with the same order (or payment) twice is refused', () => {
  const same = { claim: { kind: 'AgentMistake' as const, orders: ['o1', 'o1'] }, receipts: [receipt('o1')] };
  assert.match(run(same).reason, /two different orders/);
  const samePay = { claim: { kind: 'AgentMistake' as const, orders: ['o1', 'o2'] },
    receipts: [{ ...receipt('o1'), paymentTx: 'p1' }, { ...receipt('o2', T0 + 2 * MIN), paymentTx: 'p1' }] };
  assert.match(run(samePay).reason, /two different payments/);
});

test('order cover only pays for the order it insured', () => {
  const p = { ...base.policy, orderRef: 'ref1' };
  assert.match(run({ policy: p, receipts: [{ ...receipt('o1'), matchesOrderRef: false }] }).reason, /not the order this cover insured/);
  assert.equal(run({ policy: p, receipts: [{ ...receipt('o1'), matchesOrderRef: true }] }).ok, true);
});
