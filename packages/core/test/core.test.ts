import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorize, canonicalJson, deriveClaims, mandateId, MandateSchema, unmetRequirements, yearsSince,
  type Mandate, type MandateState, type Order,
} from '../src/index.js';

import { AccountAddress } from '@concordium/web-sdk';
const addr = (n: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(n).buffer).address;
const PAYER = addr(2);
const SHOP = addr(3);
const OWNER = addr(1);

const mandate: Mandate = MandateSchema.parse({
  v: 1,
  network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  principal: { kind: 'person', account: OWNER },
  agent: { registry: { index: '12802', subindex: '0', tokenId: '7' }, payer: PAYER },
  scope: {
    asset: 'EUDemo', maxPerOrder: '50000000', maxTotal: '100000000',
    categories: ['wine', 'groceries'], validFrom: 1000, validUntil: 2000,
  },
  proof: { auditRecordUri: 'https://example.org/a.json', auditRecordSha256: 'a'.repeat(64) },
  createdAt: 1000,
});

const state: MandateState = {
  owner: OWNER, status: 'active', spent: 0n, maxTotal: 100000000n, validUntil: 2000, payer: PAYER, docSha256: 'h',
};
const order: Order = { payer: PAYER, merchant: SHOP, asset: 'EUDemo', amount: 24000000n, category: 'wine', now: 1500 };
const claims = { ageOver: 18, residency: ['DK'] };
const req = { minAge: 18, residencyIn: ['DK', 'DE', 'NL'] };
const run = (o: Partial<Parameters<typeof authorize>[0]> = {}) =>
  authorize({ mandate, docSha256: 'h', state, claims, requirements: req, order, ...o });

test('happy path is authorized', () => assert.deepEqual(run(), { ok: true }));

test('each guardrail rejects', () => {
  const cases: [Partial<Parameters<typeof authorize>[0]>, RegExp][] = [
    [{ state: null }, /not registered/],
    [{ docSha256: 'x' }, /does not match/],
    [{ state: { ...state, owner: SHOP } }, /not issued by the principal/],
    [{ state: { ...state, maxTotal: 10n ** 12n } }, /budget exceeds mandate document/],
    [{ claims: { ageOver: NaN, residency: ['DK'] } }, /age>=18/],
    [{ state: { ...state, status: 'revoked' } }, /revoked/],
    [{ order: { ...order, now: 2001 } }, /expired/],
    [{ order: { ...order, payer: SHOP } }, /payer is not the mandated agent/],
    [{ order: { ...order, asset: 'CCD' } }, /asset CCD not allowed/],
    [{ order: { ...order, amount: 60000000n } }, /per-order limit/],
    [{ state: { ...state, spent: 90000000n } }, /remaining mandate budget/],
    [{ order: { ...order, category: 'vape' } }, /category "vape"/],
    [{ claims: { ageOver: 17, residency: ['DK'] } }, /age>=18/],
    [{ claims: { ageOver: 30, residency: ['US'] } }, /residency/],
  ];
  for (const [o, re] of cases) {
    const d = run(o);
    assert.equal(d.ok, false, `expected rejection for ${re}`);
    assert.match((d as { reasons: string[] }).reasons.join('; '), re);
  }
});

test('merchant allowlist', () => {
  const m = { ...mandate, scope: { ...mandate.scope, merchants: [OWNER] } };
  assert.match((run({ mandate: m }) as { reasons: string[] }).reasons.join(), /allowlist/);
});

test('claims from statements', () => {
  const at = new Date(Date.UTC(2026, 10, 17));
  const c = deriveClaims([
    { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20081117' },
    { type: 'AttributeInSet', attributeTag: 'countryOfResidence', set: ['DK', 'DE'] },
    { type: 'AttributeValue', attributeTag: 'lei', attributeValue: '5493001KJTIIGC8Y1R12' },
  ], at);
  assert.equal(c.ageOver, 18);
  assert.deepEqual(c.residency, ['DK', 'DE']);
  assert.equal(c.lei, '5493001KJTIIGC8Y1R12');
  assert.equal(yearsSince('20081118', at), 17); // one day short
  // SDK addMinimumAge(18) on 2026-11-19 emits upper = 20081120 (exclusive): proves 18 today
  const today = new Date(Date.UTC(2026, 10, 19));
  const age = (upper: string) => deriveClaims([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper }], today).ageOver;
  assert.equal(age('20081120'), 18);
  assert.equal(age('20081121'), 17); // could be born 2008-11-20: turns 18 tomorrow
  // malformed date bounds are ignored, never turned into an age
  assert.equal(deriveClaims([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '0', upper: 'abc' }], at).ageOver, undefined);
  assert.equal(deriveClaims([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '0', upper: '20080231' }], at).ageOver, undefined);
  // a proven set must be a subset of the allowed set
  assert.deepEqual(unmetRequirements({ residency: ['DK', 'US'] }, { residencyIn: ['DK'] }).length, 1);
  assert.deepEqual(unmetRequirements({}, { business: true }), ['business identity (LEI) not proven']);
});

test('mandate id is canonical', async () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  const { scope, ...rest } = mandate;
  const reordered = JSON.parse(JSON.stringify({ scope, ...rest }));
  assert.equal(await mandateId(mandate), await mandateId(reordered));
  assert.match(await mandateId(mandate), /^[0-9a-f]{64}$/);
});

test('registry codec round-trips', async () => {
  const { encodeViewResult, decodeViewResult, encodeIssue } = await import('../src/registry.js');
  const entry = {
    owner: OWNER, payer: PAYER, agentRegistry: { index: 12802n, subindex: 0n }, agentToken: '7',
    uri: 'https://kuasa.example/m/7', maxTotal: 100n, spent: 60n, validUntilMs: 10_000n, revoked: false,
    recorders: [SHOP], receipts: 1n, incidents: 0n,
  };
  assert.deepEqual(decodeViewResult(encodeViewResult(entry)), entry);
  assert.equal(decodeViewResult(encodeViewResult(null)), null);
  // id(32) + payer(32) + contract(16) + "7"(4+1) + uri(4+25) + u64 + u64 + vec(4+32)
  const issue = encodeIssue({ id: 'ab'.repeat(32), payer: PAYER, agentRegistry: entry.agentRegistry, agentToken: '7', uri: entry.uri, maxTotal: 100n, validUntilMs: 10_000n, recorders: [SHOP] });
  assert.equal(issue.length, 32 + 32 + 16 + 5 + 29 + 8 + 8 + 36);
  assert.throws(() => decodeViewResult(Uint8Array.of(1, 2, 3)), /unexpected end/);
});
