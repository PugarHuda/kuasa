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

test('new capital is locked up before it can leave, and a failed payment rolls a withdrawal back', () => {
  const l = new CapitalLedger();
  const day = 86_400_000;
  l.deposit('lp', 30n * EUR, 'tx-1', 0);
  const pool = { pool: 100n * EUR, exposure: 0n };
  assert.throws(() => l.withdraw('lp', 1n * EUR, pool, day, 7 * day), /locked/);
  l.withdraw('lp', 10n * EUR, pool, 8 * day, 7 * day);
  l.unwithdraw('lp', 10n * EUR);
  assert.equal(l.balances()[0].balance, 30n * EUR, 'rolled back');
});

test('capital memo: only transfers marked "kuasa capital" are deposits', async () => {
  const { isCapitalMemo } = await import('../src/capital.js');
  assert.equal(isCapitalMemo('6d6b75617361206361706974616c'), true);
  assert.equal(isCapitalMemo('78186b7561736120636f76657220706f6f6c206361706974616c'), false, 'a different text');
  assert.equal(isCapitalMemo(undefined), false);
});

test('a transaction reserved as a premium can never become a capital deposit', () => {
  const l = new CapitalLedger();
  l.reserve('premium-tx');
  assert.throws(() => l.deposit('lp', 5n * 1_000_000n, 'premium-tx'), /already recorded/);
  assert.equal(new CapitalLedger(l.snapshot()).snapshot().txs.includes('premium-tx'), true, 'persisted');
});

test('risk-specific staking: class capital pays its class first, earns 1.5x weight, and one provider backs one class', async () => {
  const { capitalClassOf } = await import('../src/capital.js');
  const memo = (t: string) => Buffer.from([0x60 + t.length, ...Buffer.from(t)]).toString('hex');
  assert.equal(capitalClassOf(memo('kuasa capital')), 'general');
  assert.equal(capitalClassOf(memo('kuasa capital:WI')), 'WI');
  assert.equal(capitalClassOf(memo('kuasa capital:XX')), null);
  const l = new CapitalLedger();
  l.deposit('general', 60n * EUR, 'a');
  l.deposit('wi', 20n * EUR, 'b', 0, 'WI');
  assert.throws(() => l.deposit('wi', 1n * EUR, 'c'), /backs WI/);
  l.onPremium(9n * EUR); // weights 60x2 : 20x3 = 2 : 1
  const b1 = Object.fromEntries(l.balances().map((x) => [x.provider, x]));
  assert.equal(b1.general.premiums, 6n * EUR);
  assert.equal(b1.wi.premiums, 3n * EUR);
  l.onPayout(5n * EUR, 'WI'); // wrong-item loss: the WI backers pay first
  l.onPayout(4n * EUR, 'AM'); // nobody backs AM: shared pro rata (66 : 18)
  const b2 = Object.fromEntries(l.balances().map((x) => [x.provider, x]));
  assert.equal(b2.wi.losses, 5n * EUR + (4n * EUR * 18n) / 84n);
  l.onPayout(40n * EUR, 'WI'); // beyond the WI capital: the rest is shared
  const b3 = Object.fromEntries(l.balances().map((x) => [x.provider, x]));
  assert.equal(b3.wi.balance, 0n, 'first loss exhausted');
  assert.equal(b3.general.balance + b3.wi.balance, 80n * EUR + 9n * EUR - 49n * EUR);
});
