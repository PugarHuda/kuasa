import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solvency } from '../src/solvency.js';

const EUR = 1_000_000n;
const pol = (limit: bigint, paidOut: bigint, premium: bigint, until: number, status: 'Active' | 'Cancelled' = 'Active') => ({ limit, paidOut, premium, validUntilMs: BigInt(until), status });

test('exposure counts only live policies; the ratio says whether the pool can pay every live limit', () => {
  const s = solvency({
    pool: 150n * EUR, now: 1000,
    policies: [pol(100n * EUR, 23n * EUR, 2n * EUR, 2000), pol(50n * EUR, 0n, 1n * EUR, 500), pol(80n * EUR, 0n, 1n * EUR, 2000, 'Cancelled')],
    claims: [{ status: 'Approved' }, { status: 'Paid' }, { status: 'Filed' }],
  });
  assert.equal(s.exposure, 77n * EUR);
  assert.equal(s.livePolicies, 1);
  assert.equal(s.premiums, 4n * EUR);
  assert.equal(s.paidOut, 23n * EUR);
  assert.equal(s.openClaims, 2);
  assert.equal(s.coverage, 1.948);
  assert.equal(s.solvent, true);
  assert.equal(solvency({ pool: 10n * EUR, now: 1000, policies: [pol(100n * EUR, 0n, 0n, 2000)], claims: [] }).solvent, false);
  assert.equal(solvency({ pool: 0n, now: 0, policies: [], claims: [] }).coverage, null);
});
