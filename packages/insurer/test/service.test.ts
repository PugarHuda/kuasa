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
    verifyPayer: async () => true,
    cover: {
      issuePolicy: async (p) => { calls.push('issuePolicy'); const id = BigInt(policies.size); policies.set(id, { ...p, validFromMs: 1_000_000n, paidOut: 0n, status: 'Active' }); return { hash: 'tx', summary: {}, id }; },
      policy: async (id) => policies.get(id) ?? null,
      claim: async (id) => claims.get(id) ?? null,
      assess: async (id, ok) => { calls.push(`assess:${id}:${ok}`); return { hash: 'tx', summary: {} }; },
      decide: async (id, approve) => { calls.push(`decide:${id}:${approve}`); const c = claims.get(id); if (c) c.status = { tag: approve ? 'Approved' : 'Rejected' }; return { hash: 'tx', summary: {} }; },
      recordPayout: async (id, tx, amount) => { calls.push(`recordPayout:${id}:${amount}`); const c = claims.get(id); if (c) c.status = { tag: 'Paid', payoutTx: tx }; const p = c && policies.get(c.policyId); if (p) p.paidOut += amount; return { hash: 'tx', summary: {} }; },
      policyByPremiumTx: async (tx) => { for (const [id, p] of policies) if (p.premiumTx === tx) return id; return null; },
      markFraud: async (id) => { calls.push(`markFraud:${id}`); return { hash: 'tx', summary: {} }; },
    },
    registryEvents: async (tx) => events.get(tx) ?? null,
    treasuryBalance: async () => 1_000n * EUR,
    pay: async (to, amount) => { calls.push(`pay:${to}:${amount}`); return 'payout-tx'; },
    txOutcome: async () => 'success',
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
  t.svc.releaseQuote(q.quoteId); // a successful check reserves the quote; pretend that payment failed
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

test('a paid-but-unissued premium survives a restart and is issued on retry', async () => {
  let saved = '';
  let fail = true;
  const t = harness({ persist: (s) => { saved = s; } });
  const real = t.svc['deps'].cover.issuePolicy;
  t.svc['deps'].cover.issuePolicy = async (p, w) => { if (fail) throw new Error('chain down'); return real(p, w); };
  const q = await quoteOk(t.svc);
  await t.svc.issue(q.quoteId, h(9));
  fail = false;
  const restarted = new InsurerService({ ...t.svc['deps'] }, saved);
  await restarted.retryUnissued();
  assert.equal(restarted.state().unissued.length, 0);
  assert.equal(restarted.state().policies.length, 1, 'the premium became a policy, not silently dropped');
});

test('a rejected claim is never paid, even if approve is clicked afterwards', async () => {
  const t = harness();
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, false);
  await assert.rejects(t.svc.decide(0n, true), /rejected/);
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')));
});

test('an unconfirmed payout is checked, never sent twice', async () => {
  let outcome: 'pending' | 'success' = 'pending';
  const t = harness({ txOutcome: async () => outcome });
  await filedClaim(t, true, 0n);
  const d1 = await t.svc.decide(0n, true);
  assert.match(d1.reason ?? '', /in flight/);
  outcome = 'success';
  const d2 = await t.svc.decide(0n, true);
  assert.equal(d2.paid, 'payout-tx');
  assert.equal(t.calls.filter((c) => c.startsWith('pay:')).length, 1);
  assert.ok(t.calls.includes(`recordPayout:0:${23n * EUR}`));
});

test('a failed payout transfer may be sent again', async () => {
  let outcome: 'failed' | 'success' = 'failed';
  const t = harness({ txOutcome: async () => outcome });
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, true);
  outcome = 'success';
  const d = await t.svc.decide(0n, true);
  assert.equal(d.paid, 'payout-tx');
  assert.equal(t.calls.filter((c) => c.startsWith('pay:')).length, 2);
});

test('one premium never produces two policies', async () => {
  const t = harness();
  const real = t.svc['deps'].cover.issuePolicy;
  let first = true;
  t.svc['deps'].cover.issuePolicy = async (p, w) => { const r = await real(p, w); if (first) { first = false; throw new Error('finalization wait failed'); } return r; };
  const q = await quoteOk(t.svc);
  const id = await t.svc.issue(q.quoteId, h(9));
  assert.equal(id, 0n);
  assert.equal(t.policies.size, 1);
  assert.equal(t.calls.filter((c) => c === 'issuePolicy').length, 1);
});

test('an order paid under one policy cannot be paid again under another', async () => {
  const t = harness();
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, true);
  const q = await quoteOk(t.svc);
  const pid = await t.svc.issue(q.quoteId, h(8));
  t.claims.set(5n, { policyId: pid!, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: h(12), orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  const a = await t.svc.assessClaim(5n, ['r0']);
  assert.equal(a.ok, false);
  assert.match(a.reason, /already paid/);
});

test('a revoked mandate after the premium settled needs a refund, not endless retries', async () => {
  const t = harness();
  const q = await quoteOk(t.svc);
  t.setEntry(entry({ revoked: true }));
  assert.equal(await t.svc.issue(q.quoteId, h(9)), null);
  assert.equal(t.calls.filter((c) => c === 'issuePolicy').length, 0, 'never submitted');
  assert.equal(t.svc.state().needsRefund.length, 1);
  await t.svc.retryUnissued();
  assert.equal(t.calls.filter((c) => c === 'issuePolicy').length, 0);
});

test('blocked payouts keep their reason; an exhausted limit is final', async () => {
  const t = harness({ treasuryBalance: async () => 0n });
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, true);
  assert.match(t.svc.state().claims[0].payoutBlocked ?? '', /insufficient pool/);
  const u = harness();
  await filedClaim(u, true, 0n);
  u.policies.get(0n)!.paidOut = 100n * EUR;
  await u.svc.decide(0n, true);
  assert.match(u.svc.state().claims[0].payoutBlocked ?? '', /limit exhausted/);
  assert.equal(u.svc.state().claims[0].final, true);
});

test('a quote backs exactly one premium payment', async () => {
  const t = harness();
  const q = await quoteOk(t.svc);
  const [a, b] = await Promise.all([t.svc.checkPurchase(q.quoteId, PAYER, q.premium), t.svc.checkPurchase(q.quoteId, PAYER, q.premium)]);
  assert.deepEqual([a, b].filter((x) => x === null).length, 1);
  assert.match([a, b].find((x) => x !== null)!, /already being paid/);
  t.svc.releaseQuote(q.quoteId); // the reserved payment failed
  assert.equal(await t.svc.checkPurchase(q.quoteId, PAYER, q.premium), null);
});

test('expired quotes are purged and the store is bounded (refused at the cap)', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, maxQuotes: 3 });
  for (let i = 0; i < 3; i++) await quoteOk(t.svc);
  const extra = await t.svc.quote({ mandateUrl: 'https://k.example/m.json', limit: 100n * EUR, days: 30 });
  assert.ok('refused' in extra);
  assert.equal(t.svc.quoteCount(), 3);
  now += 11 * 60_000;
  await quoteOk(t.svc);
  assert.equal(t.svc.quoteCount(), 1, 'expired ones purged');
});

test('a stale premium reservation expires', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now });
  const q = await quoteOk(t.svc);
  assert.equal(await t.svc.checkPurchase(q.quoteId, PAYER, q.premium), null);
  now += 3 * 60_000; // verification failed upstream; no settle hook ever fired
  assert.equal(await t.svc.checkPurchase(q.quoteId, PAYER, q.premium), null, 'reservation released after its TTL');
});

test('at the per-payer cap new quotes are refused; existing ones are never evicted', async () => {
  const t = harness({ maxQuotesPerPayer: 2 });
  const first = await quoteOk(t.svc);
  await quoteOk(t.svc);
  const third = await t.svc.quote({ mandateUrl: 'https://k.example/m.json', limit: 100n * EUR, days: 30 });
  assert.match('refused' in third ? third.refused : '', /too many open quotes/);
  assert.ok(t.svc.quoteOf(first.quoteId), 'a third party cannot push out existing quotes');
});

test('a second payment for an already issued quote goes to refund, not a second policy', async () => {
  const t = harness();
  const q = await quoteOk(t.svc);
  t.svc.markSettled(q.quoteId);
  assert.equal(await t.svc.issue(q.quoteId, h(9)), 0n);
  assert.equal(await t.svc.issue(q.quoteId, h(8), q), null);
  assert.equal(t.policies.size, 1);
  assert.match(t.svc.state().needsRefund[0].reason, /already issued/);
});

test('a settled quote keeps its reservation past the TTL', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now });
  const q = await quoteOk(t.svc);
  assert.equal(await t.svc.checkPurchase(q.quoteId, PAYER, q.premium), null);
  t.svc.markSettled(q.quoteId);
  now += 5 * 60_000;
  assert.match((await t.svc.checkPurchase(q.quoteId, PAYER, q.premium)) ?? '', /already being paid|unknown/);
});

test('quotes need a valid payer proof', async () => {
  const t = harness({ verifyPayer: async () => false });
  const q = await t.svc.quote({ mandateUrl: 'https://k.example/m.json', limit: 100n * EUR, days: 30 });
  assert.match('refused' in q ? q.refused : '', /payer proof/);
});

test('consumed quotes do not count toward the per-payer cap', async () => {
  const t = harness({ maxQuotesPerPayer: 2 });
  for (let i = 0; i < 4; i++) {
    const q = await quoteOk(t.svc);
    t.svc.markSettled(q.quoteId);
    assert.notEqual(await t.svc.issue(q.quoteId, h(30 + i)), null);
  }
  assert.equal(t.svc.quoteCount(), 0, 'issued quotes are removed');
});
