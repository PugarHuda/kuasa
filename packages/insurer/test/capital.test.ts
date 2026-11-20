import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapitalLedger } from '../src/capital.js';

const EUR = 1_000_000n;

test('capital providers share premiums and losses pro rata, and cannot withdraw below live exposure', () => {
  const l = new CapitalLedger();
  l.deposit('insurer', 75n * EUR, 'tx-a');
  l.deposit('lp', 25n * EUR, 'tx-b');
  assert.throws(() => l.deposit('lp', 1n, 'tx-b'), /already recorded/);
  l.onPremium(4n * EUR); // 3 / 1
  l.onPayout(8n * EUR); // 6 / 2
  const b = Object.fromEntries(l.balances().map((x) => [x.provider, x]));
  assert.equal(b.insurer.balance, 72n * EUR);
  assert.equal(b.lp.balance, 24n * EUR);
  assert.equal(b.lp.premiums, 1n * EUR);
  assert.equal(b.lp.losses, 2n * EUR);
  // pool 96, exposure 80: at most 16 can leave
  assert.throws(() => l.withdraw('lp', 20n * EUR, { pool: 96n * EUR, exposure: 80n * EUR }), /exposure/);
  assert.throws(() => l.withdraw('lp', 30n * EUR, { pool: 200n * EUR, exposure: 0n }), /balance/);
  l.withdraw('lp', 10n * EUR, { pool: 96n * EUR, exposure: 80n * EUR });
  assert.equal(l.balances().find((x) => x.provider === 'lp')!.balance, 14n * EUR);
  const snap = new CapitalLedger(l.snapshot());
  assert.deepEqual(snap.balances(), l.balances(), 'round-trips');
});
