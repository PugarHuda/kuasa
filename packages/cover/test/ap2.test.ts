import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeFromAp2Intent } from '../src/ap2.js';

const intent = {
  user_cart_confirmation_required: false,
  natural_language_description: 'One bottle of Rioja for dinner',
  merchants: ['Kuasa demo shop'],
  skus: null,
  requires_refundability: true,
  intent_expiry: '2026-12-01T00:00:00Z',
};
const accounts: Record<string, string> = { 'Kuasa demo shop': 'ACC_SHOP' };

test('an AP2 IntentMandate maps onto an enforceable Kuasa mandate scope', () => {
  const s = scopeFromAp2Intent(intent, (m) => accounts[m]);
  assert.ok(!('refused' in s));
  assert.deepEqual(s.merchants, ['ACC_SHOP']);
  assert.equal(s.validUntil, Date.parse('2026-12-01T00:00:00Z') / 1000);
  assert.equal(s.description, 'One bottle of Rioja for dinner');
  assert.equal(s.humanConfirmsEachCart, false);
});

test('AP2 intents Kuasa cannot enforce are refused, not silently widened', () => {
  assert.match((scopeFromAp2Intent({ ...intent, merchants: ['Unknown shop'] }, (m) => accounts[m]) as { refused: string }).refused, /Unknown shop/);
  assert.match((scopeFromAp2Intent({ ...intent, intent_expiry: 'soon' }, (m) => accounts[m]) as { refused: string }).refused, /expiry/);
  assert.match((scopeFromAp2Intent({ ...intent, merchants: null }, (m) => accounts[m]) as { refused: string }).refused, /merchant/);
});
