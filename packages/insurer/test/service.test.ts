import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountAddress } from '@concordium/web-sdk';
import type { Claim, Mandate, MandateEntry, Policy, RegistryEvent } from '@kuasa/core';
import { InsurerService, type InsurerDeps } from '../src/service.js';

const addr = (n: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(n).buffer).address;
const [OWNER, PAYER, SHOP, TREASURY, OPERATOR] = [1, 2, 3, 4, 5].map(addr);
const EUR = 1_000_000n;
const h = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

const mandate = {
  v: 1, network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  principal: { kind: 'person', account: OWNER },
  agent: { registry: { index: '12802', subindex: '0', tokenId: 'ee04' }, payer: PAYER },
  scope: { asset: 'EUDemo', maxPerOrder: String(50n * EUR), maxTotal: String(150n * EUR), categories: ['wine', 'insurance'], merchants: [SHOP, TREASURY], validFrom: 0, validUntil: 4_000_000_000 },
  proof: { auditRecordUri: 'https://k.example/p.json', auditRecordSha256: 'a'.repeat(64) },
  createdAt: 0,
} as Mandate;

const entry = (over: Partial<MandateEntry> = {}): MandateEntry => ({
  owner: OWNER, payer: PAYER, agentRegistry: { index: 12802n, subindex: 0n }, agentToken: 'ee04', uri: '', maxTotal: 150n * EUR,
  spent: 0n, validUntilMs: 4_000_000_000_000n, revoked: false, recorders: [OPERATOR], receipts: 0n, incidents: 0n, ...over,
});

function harness(over: Partial<InsurerDeps> = {}) {
  const calls: string[] = [];
  let mEntry = entry();
  const policies = new Map<bigint, Policy>();
  const claims = new Map<bigint, Claim>();
  const events = new Map<string, { at: number; events: RegistryEvent[] }>();
  const disclosures: object[] = [];
  const deps: InsurerDeps = {
    now: () => 1_000_000,
    sleep: async () => {},
    loadMandate: async () => ({ mandate, id: h(7) }),
    mandateEntry: async () => mEntry,
    identity: { claims: async () => ({ ok: true, claims: { ageOver: 30, residency: ['DK'] } }) },
    cover: {
      issuePolicy: async (p) => { calls.push('issuePolicy'); const id = BigInt(policies.size); policies.set(id, { ...p, validFromMs: 1_000_000n, paidOut: 0n, status: 'Active' }); return { hash: 'tx', summary: {}, id }; },
      policy: async (id) => policies.get(id) ?? null,
      claim: async (id) => claims.get(id) ?? null,
      assess: async (id, ok) => { calls.push(`assess:${id}:${ok}`); return { hash: 'tx', summary: {} }; },
      decide: async (id, approve) => { calls.push(`decide:${id}:${approve}`); return { hash: 'tx', summary: {} }; },
      recordPayout: async (id, tx, amount) => { calls.push(`recordPayout:${id}:${amount}`); return { hash: 'tx', summary: {} }; },
      markFraud: async (id) => { calls.push(`markFraud:${id}`); return { hash: 'tx', summary: {} }; },
    },
    registryEvents: async (tx) => events.get(tx) ?? null,
    treasuryBalance: async () => 1_000n * EUR,
    pay: async (to, amount) => { calls.push(`pay:${to}:${amount}`); return 'payout-tx'; },
    saveDisclosure: async (doc) => { disclosures.push(doc); return h(13); },
    ...over,
  };
  const svc = new InsurerService(deps);
  return { svc, calls, policies, claims, events, disclosures, setEntry: (e: MandateEntry) => { mEntry = e; } };
}

const quoteOk = async (svc: InsurerService) => {
  const q = await svc.quote({ mandateUrl: 'https://k.example/m.json', limit: 100n * EUR, days: 30 });
  assert.ok(!('refused' in q), 'refused' in q ? q.refused : '');
  return q;
};

test('buy aborts when amount != fresh quote', async () => {
  const t = harness();
  const q = await quoteOk(t.svc);
  assert.equal(await t.svc.checkPurchase(q.quoteId, PAYER, q.premium), null);
  assert.match((await t.svc.checkPurchase(q.quoteId, PAYER, q.premium + 1n))!, /premium/);
  assert.match((await t.svc.checkPurchase(q.quoteId, SHOP, q.premium))!, /payer/);
  t.setEntry(entry({ incidents: 1n })); // risk changed after quoting
  assert.match((await t.svc.checkPurchase(q.quoteId, PAYER, q.premium))!, /premium/);
  assert.match((await t.svc.checkPurchase('nope', PAYER, q.premium))!, /quote/);
});

test('quote refuses revoked mandates and limits above the mandate budget', async () => {
  const t = harness();
  assert.ok('refused' in await t.svc.quote({ mandateUrl: 'x', limit: 151n * EUR, days: 30 }));
  t.setEntry(entry({ revoked: true }));
  assert.ok('refused' in await t.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30 }));
});

test('premium settled, issuance failed -> unissued + retry', async () => {
  let fail = true;
  const t = harness();
  const real = t.svc['deps'].cover.issuePolicy;
  t.svc['deps'].cover.issuePolicy = async (p, w) => { if (fail) throw new Error('chain down'); return real(p, w); };
  const q = await quoteOk(t.svc);
  assert.equal(await t.svc.issue(q.quoteId, h(9)), null);
  assert.equal(t.svc.state().unissued.length, 1);
  fail = false;
  await t.svc.retryUnissued();
  assert.equal(t.svc.state().unissued.length, 0);
  assert.equal(t.svc.state().policies.length, 1);
});

async function filedClaim(t: ReturnType<typeof harness>, withEvidence: boolean, id: bigint) {
  const q = await quoteOk(t.svc);
  const pid = await t.svc.issue(q.quoteId, h(9));
  t.claims.set(id, { policyId: pid!, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: h(12), orders: [h(10 + Number(id))], status: { tag: 'Filed' }, payout: 0n });
  if (withEvidence) t.events.set(`r${id}`, { at: 1_000_500, events: [{ type: 'Receipt', owner: OWNER, id: h(7), order: h(10 + Number(id)), paymentTx: h(9), amount: 24n * EUR, spent: 24n * EUR }] });
  return t.svc.assessClaim(id, [`r${id}`]);
}

test('approve pays the agent payer and records the payout', async () => {
  const t = harness();
  const a = await filedClaim(t, true, 0n);
  assert.equal(a.ok, true);
  const d = await t.svc.decide(0n, true);
  assert.equal(d.paid, 'payout-tx');
  assert.ok(t.calls.includes(`pay:${PAYER}:${23n * EUR}`));
  assert.ok(t.calls.includes(`recordPayout:0:${23n * EUR}`));
});

test('approve with empty pool does not pay', async () => {
  const t = harness({ treasuryBalance: async () => 0n });
  await filedClaim(t, true, 0n);
  const d = await t.svc.decide(0n, true);
  assert.equal(d.paid, undefined);
  assert.match(d.reason!, /insufficient pool/);
  assert.ok(t.calls.includes('decide:0:true'), 'the human decision is still recorded');
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')));
});

test('second no-evidence rejection drafts a disclosure; only a human approval anchors it', async () => {
  const t = harness();
  const a1 = await filedClaim(t, false, 0n);
  assert.deepEqual([a1.ok, a1.noEvidence], [false, true]);
  assert.ok(t.calls.includes('decide:0:false'), 'no-evidence claims are rejected without paying');
  await filedClaim(t, false, 1n);
  assert.equal(t.disclosures.length, 0, 'nothing anchored without a human');
  assert.equal(t.svc.state().pendingDisclosures.length, 1);
  assert.equal(t.svc.state().pendingDisclosures[0].account, PAYER, 'attributed to the claimant');
  await t.svc.approveDisclosure(1n);
  assert.equal(t.disclosures.length, 1);
  assert.ok(t.calls.includes('markFraud:1'));
  assert.equal(t.svc.state().pendingDisclosures.length, 0);
});

test('merchant claims without evidence count against the merchant, not the owner', async () => {
  const t = harness();
  for (const id of [0n, 1n]) {
    const q = await quoteOk(t.svc);
    const pid = await t.svc.issue(q.quoteId, h(9));
    t.claims.set(id, { policyId: pid!, claimant: SHOP, kind: 'MerchantLoss', amount: 24n * EUR, evidence: h(12), orders: [h(20 + Number(id))], status: { tag: 'Filed' }, payout: 0n });
    await t.svc.assessClaim(id, []);
  }
  assert.deepEqual(t.svc.state().fraudCounts, { [SHOP]: 2 });
  assert.equal(t.svc.state().pendingDisclosures[0].account, SHOP);
});

test('concurrent approvals pay once', async () => {
  const t = harness();
  await filedClaim(t, true, 0n);
  await Promise.all([t.svc.decide(0n, true), t.svc.decide(0n, true), t.svc.decide(0n, true)]);
  assert.equal(t.calls.filter((c) => c.startsWith('pay:')).length, 1);
});

test('a failed payout record is retried without paying again', async () => {
  let failRecord = true;
  const t = harness();
  const real = t.svc['deps'].cover.recordPayout;
  t.svc['deps'].cover.recordPayout = async (...args) => { if (failRecord) throw new Error('chain down'); return real(...args); };
  await filedClaim(t, true, 0n);
  const d = await t.svc.decide(0n, true);
  assert.equal(d.paid, 'payout-tx');
  assert.match(d.reason ?? '', /record/);
  failRecord = false;
  await t.svc.decide(0n, true);
  assert.equal(t.calls.filter((c) => c.startsWith('pay:')).length, 1);
  assert.ok(t.calls.includes(`recordPayout:0:${23n * EUR}`));
});

test('a claim is assessed only once (no griefing by re-assessment)', async () => {
  const t = harness();
  await filedClaim(t, true, 0n);
  await assert.rejects(t.svc.assessClaim(0n, []), /already assessed/);
  assert.deepEqual(t.svc.state().fraudCounts, {});
});

test('state survives a restart (snapshot + restore)', async () => {
  let saved = '';
  const t = harness({ persist: (s) => { saved = s; } });
  await filedClaim(t, true, 0n);
  assert.ok(saved.length > 0, 'persisted after changes');
  const restarted = new InsurerService({ ...t.svc['deps'], persist: undefined }, saved);
  assert.equal(restarted.state().policies.length, 1);
  const d = await restarted.decide(0n, true);
  assert.equal(d.paid, 'payout-tx', 'a claim assessed before the restart can still be decided');
});
