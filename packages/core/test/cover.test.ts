import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AccountAddress } from '@concordium/web-sdk';
import {
  decodeClaim, decodeCoverView, decodePolicy, decodeRegistryEvent, encodeAssess, encodeCoverQuery, encodeDecide,
  encodeFileClaim, encodeFraud, encodeIssuePolicy, encodePayout, type IssuePolicyParams,
} from '../src/index.js';

const V: Record<string, string> = JSON.parse(readFileSync(new URL('./cover-vectors.json', import.meta.url), 'utf8'));
const addr = (n: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(n).buffer).address;
const h = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const [OWNER, PAYER] = [addr(1), addr(2)];
const EUR = 1_000_000n;

const policy: IssuePolicyParams = {
  holder: OWNER, agentPayer: PAYER, agentToken: 'ee04', mandate: { owner: OWNER, id: h(7) },
  kind: 'period', limit: 100n * EUR, deductible: EUR, premium: 2n * EUR, premiumTx: h(9), validUntilMs: 50_000n,
};
const fileClaim = { policyId: 0n, kind: 'AgentMistake' as const, amount: 24n * EUR, evidence: h(12), orders: [h(10), h(11)] };

test('encoders match the contract wire format', () => {
  assert.equal(hex(encodeIssuePolicy(policy)), V.ISSUE_POLICY);
  assert.equal(hex(encodeIssuePolicy({ ...policy, kind: { order: h(10) } })), V.ISSUE_ORDER_POLICY);
  assert.equal(hex(encodeFileClaim(fileClaim)), V.FILE_CLAIM);
  assert.equal(hex(encodeAssess(3n, true, h(1))), V.ASSESS);
  assert.equal(hex(encodeDecide(3n, false)), V.DECIDE);
  assert.equal(hex(encodePayout(3n, h(2), 23n * EUR)), V.PAYOUT);
  assert.equal(hex(encodeFraud(3n, h(3))), V.FRAUD);
  assert.equal(hex(encodeCoverQuery(PAYER, h(10))), V.COVER_QUERY);
});

test('decoders read contract views', () => {
  assert.deepEqual(decodeCoverView(unhex(V.COVER_VIEW)), { periodRemaining: 100n * EUR, orderLimit: 0n, policyId: 0n });
  assert.deepEqual(decodePolicy(unhex(V.POLICY_VIEW)), {
    ...policy, validFromMs: 1_000n, paidOut: 0n, status: 'Active',
  });
  assert.deepEqual(decodeClaim(unhex(V.CLAIM_VIEW)), {
    policyId: 0n, claimant: PAYER, kind: 'AgentMistake', amount: 24n * EUR, evidence: h(12), orders: [h(10), h(11)],
    status: { tag: 'Filed' }, payout: 0n,
  });
  assert.equal(decodePolicy(unhex('00')), null);
});

test('decodeRegistryEvent reads a kuasa-registry Receipt event', () => {
  // tag 2, owner, id, order, payment_tx, amount u64, spent u64 (kuasa-registry Event::Receipt)
  const le = (n: bigint) => Buffer.from(Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn))).toString('hex');
  const raw = '02' + '01'.repeat(32) + h(7) + h(10) + h(9) + le(24n * EUR) + le(24n * EUR);
  assert.deepEqual(decodeRegistryEvent(unhex(raw)), {
    type: 'Receipt', owner: OWNER, id: h(7), order: h(10), paymentTx: h(9), amount: 24n * EUR, spent: 24n * EUR,
  });
  assert.equal(decodeRegistryEvent(unhex('09')), null, 'unknown tags are ignored');
});
