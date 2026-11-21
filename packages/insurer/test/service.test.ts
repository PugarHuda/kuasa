import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountAddress } from '@concordium/web-sdk';
import { type Claim, type ClaimEvidence, evidenceHash, type Mandate, type MandateEntry, type Policy, type RegistryEvent } from '@kuasa/core';
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
  const events = new Map<string, { at: number; events: RegistryEvent[]; sender?: string }>();
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
    verifyDelivery: async (d, signer) => d.signer === signer && d.sig === 'ok',
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

test('market: an insurer prices over the shared risk model (priceBps), shown as a factor and re-checked at purchase', async () => {
  const base = await quoteOk(harness().svc);
  const t = harness({ priceBps: 9_000n });
  const q = await quoteOk(t.svc);
  assert.equal(q.premium, (base.premium * 9_000n + 5_000n) / 10_000n);
  assert.ok(q.factors.some((f) => f.name === 'insurer pricing' && f.multiplier === 0.9));
  assert.equal(await t.svc.checkPurchase(q.quoteId, PAYER, q.premium), null);
});

test('quote refuses revoked mandates and limits above the mandate budget', async () => {
  const t = harness();
  assert.ok('refused' in await t.svc.quote({ mandateUrl: 'x', limit: 151n * EUR, days: 30 }));
  t.setEntry(entry({ revoked: true }));
  assert.ok('refused' in await t.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30 }));
});

test('underwriting capacity: no quote that leaves live limits unbacked by the pool (re-checked at purchase)', async () => {
  let cap = { pool: 200n * EUR, exposure: 120n * EUR };
  const t = harness({ capacity: async () => cap });
  assert.match((await t.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30 }) as { refused: string }).refused, /no underwriting capacity/);
  const ok = await t.svc.quote({ mandateUrl: 'x', limit: 80n * EUR, days: 30 }); // exactly backed
  assert.ok(!('refused' in ok));
  const order = await t.svc.quote({ mandateUrl: 'x', limit: 0n, days: 1, order: { ref: h(3), amount: 81n * EUR } });
  assert.match((order as { refused: string }).refused, /no underwriting capacity/);
  cap = { pool: 200n * EUR, exposure: 150n * EUR }; // another policy sold meanwhile
  assert.match((await t.svc.checkPurchase((ok as { quoteId: string }).quoteId, PAYER, (ok as { premium: bigint }).premium))!, /no underwriting capacity/);
  const down = harness({ capacity: async () => { throw new Error('rpc'); } });
  assert.match((await down.svc.quote({ mandateUrl: 'x', limit: 10n * EUR, days: 30 }) as { refused: string }).refused, /capacity unavailable/);
});

test('no second period policy while one is live (re-checked at purchase); order cover still sold', async () => {
  let live: bigint | null = null;
  const t = harness({ coverOf: async () => ({ periodRemaining: live === null ? 0n : 100n * EUR, policyId: live }) });
  const q = await quoteOk(t.svc);
  live = 4n; // another quote got paid meanwhile
  assert.match((await t.svc.checkPurchase(q.quoteId, PAYER, q.premium))!, /already has period cover \(policy #4\)/);
  assert.ok('refused' in await t.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30 }));
  const o = await t.svc.quote({ mandateUrl: 'x', limit: 20n * EUR, days: 1, order: { ref: h(3), amount: 20n * EUR } });
  assert.ok(!('refused' in o), 'refused' in o ? o.refused : '');
  // two open period quotes paid concurrently: only the first reservation goes through
  live = null;
  const [a, b] = [await quoteOk(t.svc), await quoteOk(t.svc)];
  const [ra, rb] = await Promise.all([t.svc.checkPurchase(a.quoteId, PAYER, a.premium), t.svc.checkPurchase(b.quoteId, PAYER, b.premium)]);
  assert.equal(ra, null);
  assert.match(rb!, /already being bought/);
  t.svc.releaseQuote(a.quoteId); // a's payment failed: b may go ahead
  assert.equal(await t.svc.checkPurchase(b.quoteId, PAYER, b.premium), null);
  const down = harness({ coverOf: async () => { throw new Error('502'); } });
  assert.match((await down.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30 }) as { refused: string }).refused, /unavailable/);
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

/** WI10 evidence: the shop (recorder) signed a delivery note showing another item was shipped. */
const wrongItemEvidence = async (order: string, paymentTx = h(9), signer = SHOP) => {
  const doc: ClaimEvidence = { v: 2, reason: 'WI10', paymentTxs: [paymentTx], note: '', delivery: [{ note: { v: 1, order, paymentTx, ordered: '/shop/wine/rioja', shipped: '/shop/vape/mint', at: 1 }, signer, sig: 'ok' }] };
  return { doc, hash: await evidenceHash(doc) };
};
const receiptEvent = (order: string) => ({ at: 1_000_500, sender: SHOP, events: [{ type: 'Receipt' as const, owner: OWNER, id: h(7), order, paymentTx: h(9), amount: 24n * EUR, spent: 24n * EUR }] });

async function filedClaim(t: ReturnType<typeof harness>, withEvidence: boolean, id: bigint, kind: 'WrongItem' | 'MerchantLoss' = 'WrongItem') {
  if (kind === 'MerchantLoss') t.setEntry(entry({ incidents: 1n }));
  const q = await quoteOk(t.svc);
  const pid = await t.svc.issue(q.quoteId, h(9));
  const ev = kind === 'WrongItem' ? await wrongItemEvidence(h(10 + Number(id))) : undefined;
  t.claims.set(id, { policyId: pid!, claimant: PAYER, kind, amount: 24n * EUR, evidence: ev?.hash ?? h(12), orders: [h(10 + Number(id))], status: { tag: 'Filed' }, payout: 0n });
  if (withEvidence) t.events.set(`r${id}`, receiptEvent(h(10 + Number(id))));
  return t.svc.assessClaim(id, [`r${id}`], ev?.doc);
}

test('market, contribution: each insurer pays only what other insurers have not paid of the same loss (syndicated shares still pay)', async () => {
  const full = await filedClaim(harness({ otherInsurersPaid: async () => 0n }), true, 0n);
  assert.equal(full.ok, true, full.reason);
  const share = await filedClaim(harness({ otherInsurersPaid: async (payer) => (payer === PAYER ? 20n * EUR : 0n) }), true, 0n); // 24 lost, 20 paid elsewhere
  assert.equal(share.ok, true, share.reason);
  assert.equal(share.payout, 4n * EUR);
  const done = await filedClaim(harness({ otherInsurersPaid: async () => 24n * EUR }), true, 0n);
  assert.match(done.reason, /paid in full by another insurer/);
  const down = harness({ otherInsurersPaid: async () => { throw new Error('node busy'); } });
  await assert.rejects(filedClaim(down, true, 0n), /node busy/, 'fails closed when another book is unreadable');
  // another insurer pays part of it after our assessment: we pay only the rest
  let elsewhere = 0n;
  const late = harness({ otherInsurersPaid: async () => elsewhere });
  assert.equal((await filedClaim(late, true, 0n)).ok, true);
  elsewhere = 20n * EUR;
  await late.svc.decide(0n, true);
  assert.deepEqual(late.calls.filter((c) => c.startsWith('pay:')), [`pay:${PAYER}:${4n * EUR}`]);
});

test('market, contribution is bounded by the verified loss, not the amount claimed (no double recovery by overclaiming)', async () => {
  const t = harness({ otherInsurersPaid: async () => 20n * EUR });
  await quoteOk(t.svc);
  const q = await quoteOk(t.svc);
  const pid = await t.svc.issue(q.quoteId, h(9));
  const ev = await wrongItemEvidence(h(10));
  // receipt says 24 (receiptEvent default); the agent claims 30
  t.claims.set(0n, { policyId: pid!, claimant: PAYER, kind: 'WrongItem', amount: 30n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  t.events.set('r0', receiptEvent(h(10)));
  const a = await t.svc.assessClaim(0n, ['r0'], ev.doc);
  assert.ok(!a.ok || a.payout <= 4n * EUR, `payout ${a.payout} must not exceed loss 24 minus 20 paid elsewhere`);
});

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

test('tiered autonomy: a small positive claim is paid automatically after the objection window', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 25n * EUR, autoPayDelayMs: 120_000 });
  await filedClaim(t, true, 0n, 'MerchantLoss');
  assert.equal(t.svc.state().claims[0].autoPayAt, now + 120_000);
  await t.svc.runAutoPay();
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')), 'nothing before the window closes');
  now += 121_000;
  await t.svc.runAutoPay();
  assert.ok(t.calls.includes(`pay:${PAYER}:${23n * EUR}`));
  assert.equal(t.svc.state().claims[0].decidedBy, 'auto');
});

test('tiered autonomy: claims above the limit wait for a human', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 10n * EUR, autoPayDelayMs: 120_000 });
  await filedClaim(t, true, 0n, 'MerchantLoss');
  assert.equal(t.svc.state().claims[0].autoPayAt, undefined);
  now += 1_000_000;
  await t.svc.runAutoPay();
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')));
});

test('tiered autonomy: a held claim goes to a human; claimants with rejected claims are never auto-paid', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 25n * EUR, autoPayDelayMs: 120_000 });
  await filedClaim(t, true, 0n, 'MerchantLoss');
  t.svc.hold(0n);
  now += 200_000;
  await t.svc.runAutoPay();
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')), 'held');
  assert.equal((await t.svc.decide(0n, true)).paid, 'payout-tx', 'the human can still approve');

  const u = harness({ now: () => now, autoPayLimit: 25n * EUR, autoPayDelayMs: 120_000 });
  await filedClaim(u, false, 0n, 'MerchantLoss');
  await filedClaim(u, true, 1n, 'MerchantLoss');
  assert.equal(u.svc.state().claims.find((c) => c.claimId === 1n)?.autoPayAt, undefined);
});

test('tiered autonomy: a fraud flag raised during the objection window cancels the automatic payout', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 25n * EUR, autoPayDelayMs: 120_000 });
  await filedClaim(t, true, 0n, 'MerchantLoss');
  assert.ok(t.svc.state().claims[0].autoPayAt);
  await filedClaim(t, false, 1n, 'MerchantLoss'); // same agent files a claim with no evidence meanwhile
  now += 200_000;
  await t.svc.runAutoPay();
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')), 'flagged parties are never auto-paid');
  assert.equal(t.svc.state().claims.find((c) => c.claimId === 0n)?.autoPayAt, undefined, 'handed to a human');
});

test('a cancelled policy gets the unused premium back, pro rata, once; none after a paid claim', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now });
  const q = await quoteOk(t.svc);
  t.svc.markSettled(q.quoteId);
  const id = (await t.svc.issue(q.quoteId, h(9)))!;
  const p = t.policies.get(id)!;
  const span = Number(p.validUntilMs - p.validFromMs);
  now = Number(p.validFromMs) + span / 4; // a quarter used
  p.status = 'Cancelled';
  await t.svc.refundCancelled();
  const expected = (p.premium * 3n) / 4n;
  assert.ok(t.calls.includes(`pay:${PAYER}:${expected}`), t.calls.join(' '));
  await t.svc.refundCancelled();
  assert.equal(t.calls.filter((c) => c.startsWith('pay:')).length, 1, 'refunded once');
  assert.equal(t.svc.state().refunds[0].amount, expected);

  const u = harness({ now: () => now });
  const q2 = await quoteOk(u.svc);
  u.svc.markSettled(q2.quoteId);
  const id2 = (await u.svc.issue(q2.quoteId, h(9)))!;
  const p2 = u.policies.get(id2)!;
  p2.paidOut = 5n * EUR;
  p2.status = 'Cancelled';
  await u.svc.refundCancelled();
  assert.ok(!u.calls.some((c) => c.startsWith('pay:')), 'no refund once a claim was paid');
});

test('refunds never double up with claims: no refund while a claim is live, no payout after a refund', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now });
  await filedClaim(t, true, 0n); // policy 0, claim 0 assessed ok, not decided yet
  const p = t.policies.get(0n)!;
  now = Number(p.validFromMs) + 1000;
  p.status = 'Cancelled';
  await t.svc.refundCancelled();
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')), 'a live claim blocks the refund');

  const u = harness({ now: () => now });
  await filedClaim(u, true, 0n);
  u.claims.get(0n)!.status = { tag: 'Assessed', ok: true } as never;
  // the claim is rejected later -> the refund may go ahead; then an approval must not pay
  await u.svc.decide(0n, false);
  u.policies.get(0n)!.status = 'Cancelled';
  await u.svc.refundCancelled();
  assert.equal(u.calls.filter((c) => c.startsWith('pay:')).length, 1, 'refund after the claim was rejected');
  await assert.rejects(u.svc.decide(0n, true), /rejected/);
});

test('concurrent refund runs pay once', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now });
  const q = await quoteOk(t.svc);
  t.svc.markSettled(q.quoteId);
  const id = (await t.svc.issue(q.quoteId, h(9)))!;
  t.policies.get(id)!.status = 'Cancelled';
  now += 1000;
  await Promise.all([t.svc.refundCancelled(), t.svc.refundCancelled()]);
  assert.equal(t.calls.filter((c) => c.startsWith('pay:')).length, 1);
});

test('a claim on a refunded policy is never paid', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now });
  const q = await quoteOk(t.svc);
  t.svc.markSettled(q.quoteId);
  const id = (await t.svc.issue(q.quoteId, h(9)))!;
  t.policies.get(id)!.status = 'Cancelled';
  now += 1000;
  await t.svc.refundCancelled();
  // a claim filed before the cancellation shows up late
  const ev = await wrongItemEvidence(h(15));
  t.claims.set(5n, { policyId: id, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(15)], status: { tag: 'Filed' }, payout: 0n });
  t.events.set('r5', receiptEvent(h(15)));
  await t.svc.assessClaim(5n, ['r5'], ev.doc);
  const d = await t.svc.decide(5n, true);
  assert.equal(d.paid, undefined);
  assert.match(d.reason ?? '', /refunded/);
  assert.equal(t.calls.filter((c) => c.startsWith('pay:')).length, 1, 'only the refund');
});

test('appeal: re-filing the orders of a rejected claim is an appeal, always decided by a human', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 50n * EUR, autoPayDelayMs: 120_000 });
  await filedClaim(t, true, 0n); // WrongItem on order h(10)
  await t.svc.decide(0n, false); // a human rejected it
  // the agent re-files the same order with more evidence
  const ev = await wrongItemEvidence(h(10));
  t.claims.set(1n, { policyId: 0n, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(1n, ['r0'], ev.doc);
  const rec = t.svc.state().claims.find((c) => c.claimId === 1n)!;
  assert.equal(rec.appealOf, 0n);
  assert.equal(rec.autoPayAt, undefined, 'appeals are never paid automatically');
  now += 1_000_000;
  await t.svc.runAutoPay();
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')));
  assert.equal((await t.svc.decide(1n, true)).paid, 'payout-tx', 'a human can uphold the appeal');
});

test('WI10 evidence counts only if its hash is the on-chain evidence and the receipt recorder signed the note', async () => {
  const t = harness();
  assert.equal((await filedClaim(t, true, 0n)).ok, true);
  const ev = await wrongItemEvidence(h(11));
  const q = await quoteOk(t.svc);
  const pid = (await t.svc.issue(q.quoteId, h(8)))!;
  t.events.set('r1', receiptEvent(h(11)));
  t.claims.set(1n, { policyId: pid, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: h(12), orders: [h(11)], status: { tag: 'Filed' }, payout: 0n });
  assert.match((await t.svc.assessClaim(1n, ['r1'], ev.doc)).reason, /delivery note/, 'evidence swapped after filing is ignored');
  const forged = await wrongItemEvidence(h(11), h(9), OWNER); // signed by someone other than the recorder
  t.claims.set(2n, { policyId: pid, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: forged.hash, orders: [h(11)], status: { tag: 'Filed' }, payout: 0n });
  assert.match((await t.svc.assessClaim(2n, ['r1'], forged.doc)).reason, /delivery note/, 'only the receipt recorder can sign');
});

test('AM20 (outside the AP2 intent) uses the SKUs the policy was bought under and is never paid automatically', async () => {
  const t = harness({
    autoPayLimit: 50n * EUR, ap2Merchant: (name: string) => ({ 'Kuasa demo shop': SHOP, 'Kuasa Cover': TREASURY } as Record<string, string>)[name],
    verifyAp2Owner: async (i, owner) => owner === OWNER && (i as { user_authorization?: string }).user_authorization === 'signed-by-owner',
  });
  const ap2 = { user_cart_confirmation_required: false, natural_language_description: 'a loaf of bread', merchants: ['Kuasa demo shop', 'Kuasa Cover'], skus: ['/shop/groceries/bread'], intent_expiry: '2099-01-01T00:00:00Z', user_authorization: 'signed-by-owner' };
  const q = await t.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30, ap2 });
  assert.ok(!('refused' in q), 'refused' in q ? q.refused : '');
  const pid = (await t.svc.issue(q.quoteId, h(9)))!;
  const doc: ClaimEvidence = { v: 2, reason: 'AM20', paymentTxs: [h(9)], note: 'a page told the agent to buy wine', delivery: [{ note: { v: 1, order: h(10), paymentTx: h(9), ordered: '/shop/wine/rioja', shipped: '/shop/wine/rioja', at: 1 }, signer: SHOP, sig: 'ok' }] };
  t.events.set('r0', receiptEvent(h(10)));
  t.claims.set(0n, { policyId: pid, claimant: PAYER, kind: 'AgentMistake', amount: 24n * EUR, evidence: await evidenceHash(doc), orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  t.setEntry(entry({ receipts: 5n })); // four earlier orders nobody disputed
  const a = await t.svc.assessClaim(0n, ['r0'], doc);
  assert.equal(a.ok, true, a.reason);
  assert.match(a.reason, /^AM20/);
  assert.equal(t.svc.state().claims[0].autoPayAt, undefined);
  assert.equal(t.svc.state().claims[0].reason, 'AM20');
  assert.deepEqual(t.svc.state().claims[0].compelling, { priorUndisputed: 4, qualifies: true }, 'Stripe CE 3.0: habitual purchases, shown to the human');
});

test('wrong-item claims are never paid automatically (a receipt cannot prove the item was wrong)', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 50n * EUR, autoPayDelayMs: 120_000 });
  await filedClaim(t, true, 0n); // WrongItem
  assert.equal(t.svc.state().claims[0].autoPayAt, undefined);
});

test('AP2: a quote with the user\'s AP2 Intent Mandate is refused if the Kuasa mandate is broader', async () => {
  const t = harness({ ap2Merchant: (name: string) => ({ 'Kuasa demo shop': SHOP, 'Kuasa Cover': TREASURY } as Record<string, string>)[name] });
  const intent = { user_cart_confirmation_required: false, natural_language_description: 'wine for dinner', merchants: ['Kuasa demo shop', 'Kuasa Cover'], intent_expiry: '2099-01-01T00:00:00Z' };
  const ok = await t.svc.quote({ mandateUrl: 'https://k.example/m.json', limit: 100n * EUR, days: 30, ap2: intent });
  assert.ok(!('refused' in ok), 'refused' in ok ? ok.refused : '');
  assert.ok(!('refused' in ok) && ok.factors.some((f) => f.name === 'AP2 intent'));
  const narrow = await t.svc.quote({ mandateUrl: 'https://k.example/m.json', limit: 100n * EUR, days: 30, ap2: { ...intent, merchants: ['Kuasa demo shop'] } });
  assert.match('refused' in narrow ? narrow.refused : '', /broader than the AP2 intent/);
  const early = await t.svc.quote({ mandateUrl: 'https://k.example/m.json', limit: 100n * EUR, days: 30, ap2: { ...intent, intent_expiry: '2001-01-01T00:00:00Z' } });
  assert.match('refused' in early ? early.refused : '', /AP2 intent/);
});

test('an earlier undecided claim on the same orders blocks auto-pay of a later one', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 50n * EUR, autoPayDelayMs: 120_000 });
  t.setEntry(entry({ incidents: 1n }));
  const q = await quoteOk(t.svc);
  const pid = (await t.svc.issue(q.quoteId, h(9)))!;
  t.events.set('r0', { at: 1_000_500, events: [{ type: 'Receipt', owner: OWNER, id: h(7), order: h(10), paymentTx: h(9), amount: 24n * EUR, spent: 24n * EUR }] });
  // claim 0: same order, loss at the deductible -> not ok, but not rejected by anyone yet
  t.claims.set(0n, { policyId: pid, claimant: PAYER, kind: 'MerchantLoss', amount: 1n * EUR, evidence: h(12), orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(0n, ['r0']);
  t.claims.set(1n, { policyId: pid, claimant: PAYER, kind: 'MerchantLoss', amount: 5n * EUR, evidence: h(13), orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(1n, ['r0']);
  const c1 = t.svc.state().claims.find((c) => c.claimId === 1n)!;
  assert.equal(c1.appealOf, 0n);
  assert.equal(c1.autoPayAt, undefined);
});

test('rejecting a claim cancels auto-pay of later claims on the same orders', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 50n * EUR, autoPayDelayMs: 120_000 });
  await filedClaim(t, true, 0n, 'MerchantLoss'); // claim 0 on order h(10), auto-pay scheduled
  // a second claim on another order is scheduled too; then claim 0's order shows up in claim 2 (unusual) — simulate overlap
  const rec0 = t.svc.state().claims[0];
  assert.ok(rec0.autoPayAt);
  t.claims.set(2n, { policyId: rec0.policyId, claimant: PAYER, kind: 'MerchantLoss', amount: 24n * EUR, evidence: h(14), orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(2n, ['r0']);
  await t.svc.decide(0n, false); // a human rejects claim 0
  const c2 = t.svc.state().claims.find((c) => c.claimId === 2n)!;
  assert.equal(c2.autoPayAt, undefined, 'overlapping claim handed to a human');
  now += 1_000_000;
  await t.svc.runAutoPay();
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')));
});

test('objections: a proven party to the claim can hold an automatic payout; a human then decides', async () => {
  let now = 1_000_000;
  let proofOk = true;
  const t = harness({ now: () => now, autoPayLimit: 25n * EUR, autoPayDelayMs: 120_000, verifyPayer: async () => proofOk });
  await filedClaim(t, true, 0n, 'MerchantLoss');
  await assert.rejects(t.svc.object(0n, { by: SHOP, reason: 'not my business', proof: {} }), /party to this claim/, 'strangers cannot hold payouts');
  proofOk = false;
  await assert.rejects(t.svc.object(0n, { by: OPERATOR, reason: 'never delivered', proof: {} }), /proof/);
  proofOk = true;
  await t.svc.object(0n, { by: OPERATOR, reason: 'the goods were returned unused', proof: {} }); // the mandate's recorder (the shop)
  const rec = t.svc.state().claims[0];
  assert.equal(rec.autoPayAt, undefined, 'held');
  assert.equal(rec.objections?.[0].by, OPERATOR);
  now += 1_000_000;
  await t.svc.runAutoPay();
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')));
  await assert.rejects(t.svc.object(0n, { by: OWNER, reason: 'late', proof: {} }), /no automatic payout pending/);
});

test('objections are limited per objector', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 25n * EUR, autoPayDelayMs: 120_000 });
  for (let i = 0n; i < 4n; i++) await filedClaim(t, true, i, 'MerchantLoss');
  for (let i = 0n; i < 3n; i++) await t.svc.object(i, { by: OPERATOR, reason: 'x', proof: {} });
  await assert.rejects(t.svc.object(3n, { by: OPERATOR, reason: 'x', proof: {} }), /too many objections/);
});

test('isPaying: a premium from this payer is settling', async () => {
  const t = harness();
  const q = await quoteOk(t.svc);
  assert.equal(t.svc.isPaying(PAYER), false);
  assert.equal(await t.svc.checkPurchase(q.quoteId, PAYER, q.premium), null);
  assert.equal(t.svc.isPaying(PAYER), true);
  assert.equal(t.svc.isPaying(SHOP), false);
});

test('v2: automatic approval goes through the contract; if the contract refuses, a human decides', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, autoPayLimit: 25n * EUR, autoPayDelayMs: 120_000 });
  const approved: bigint[] = [];
  t.svc['deps'].cover.autoApprove = async (id: bigint) => { approved.push(id); t.claims.get(id)!.status = { tag: 'Approved' }; return { hash: 'tx', summary: {} }; };
  await filedClaim(t, true, 0n, 'MerchantLoss');
  now += 200_000;
  await t.svc.runAutoPay();
  assert.deepEqual(approved, [0n]);
  assert.ok(!t.calls.includes('decide:0:true'), 'not the human decision entrypoint');
  assert.ok(t.calls.some((c) => c.startsWith('pay:')));

  const u = harness({ now: () => now, autoPayLimit: 25n * EUR, autoPayDelayMs: 120_000 });
  u.svc['deps'].cover.autoApprove = async () => { throw new Error('rejected: Unauthorized (objected)'); };
  await filedClaim(u, true, 0n, 'MerchantLoss');
  now += 200_000;
  await u.svc.runAutoPay();
  const rec = u.svc.state().claims[0];
  assert.equal(rec.held, true);
  assert.equal(rec.autoPayAt, undefined);
  assert.ok(!u.calls.some((c) => c.startsWith('pay:')));
});

test('parametric: a duplicate pair on an insured agent becomes a detection and a published hold; filing marks it, the owner lifts the hold', async () => {
  const holds: string[] = [];
  let failHold = true, insured = false;
  const t = harness({
    coverOf: async () => (insured ? { periodRemaining: 100n * EUR, policyId: 0n } : { periodRemaining: 0n, policyId: null }),
    hold: async (payer, reason) => { if (failHold) throw new Error('502'); holds.push(`hold:${payer}:${reason}`); },
    unhold: async (payer) => { holds.push(`clear:${payer}`); },
  });
  const q = await quoteOk(t.svc);
  const pid = (await t.svc.issue(q.quoteId, h(9)))!;
  insured = true;
  const seen = (order: number, at: number) => ({ owner: OWNER, mandateId: h(7), order: h(order), paymentTx: h(order + 50), amount: 3n * EUR, at, receiptTx: h(order + 100) });
  assert.deepEqual(await t.svc.onReceipts([seen(20, 1_000_000)]), []);
  const [d] = await t.svc.onReceipts([seen(21, 1_060_000)]);
  assert.deepEqual(d.orders, [h(20), h(21)]);
  assert.equal(d.payer, PAYER);
  assert.deepEqual(holds, [], 'publication failed');
  failHold = false;
  await t.svc.publishHolds();
  assert.deepEqual(holds, [`hold:${PAYER}:duplicate-orders`]);
  assert.deepEqual(await t.svc.onReceipts([seen(20, 1_000_000), seen(21, 1_060_000)]), [], 'the same receipts again find nothing new');
  // the agent files the detection (AM10): the insurer links the claim and the detection
  for (const o of [20, 21]) t.events.set(`r${o}`, { at: 1_000_500, sender: SHOP, events: [{ type: 'Receipt', owner: OWNER, id: h(7), order: h(o), paymentTx: h(o + 50), amount: 3n * EUR, spent: 3n * EUR }] });
  t.claims.set(0n, { policyId: pid, claimant: PAYER, kind: 'AgentMistake', amount: 3n * EUR, evidence: h(1), orders: d.orders, status: { tag: 'Filed' }, payout: 0n });
  assert.equal((await t.svc.assessClaim(0n, ['r20', 'r21'])).ok, true);
  assert.equal(t.svc.detectionsOf(PAYER)[0].status, 'filed');
  assert.equal(t.svc.detectionsOf(PAYER)[0].claimId, 0n);
  assert.equal(await t.svc.clearHold(PAYER), true);
  assert.equal(t.svc.holdOf(PAYER), null);
  assert.deepEqual(holds.at(-1), `clear:${PAYER}`);
});

test('parametric: duplicates of an uninsured agent are not ours to act on', async () => {
  const t = harness({ coverOf: async () => ({ periodRemaining: 0n, policyId: null }), hold: async () => { throw new Error('must not hold'); } });
  const seen = (order: number, at: number) => ({ owner: OWNER, mandateId: h(7), order: h(order), paymentTx: h(order + 50), amount: 3n * EUR, at, receiptTx: h(order + 100) });
  assert.deepEqual(await t.svc.onReceipts([seen(20, 1_000_000), seen(21, 1_060_000)]), []);
});

test('AM20 needs an owner-signed intent: SKUs the agent asserts on its own never become a claim baseline', async () => {
  const t = harness({ ap2Merchant: (name: string) => ({ 'Kuasa demo shop': SHOP, 'Kuasa Cover': TREASURY } as Record<string, string>)[name], verifyAp2Owner: async () => false });
  const ap2 = { user_cart_confirmation_required: false, natural_language_description: 'bread', merchants: ['Kuasa demo shop', 'Kuasa Cover'], skus: ['/shop/groceries/bread'], intent_expiry: '2099-01-01T00:00:00Z', user_authorization: 'forged' };
  const q = await t.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30, ap2 });
  assert.ok(!('refused' in q));
  assert.match(JSON.stringify(q.factors), /not signed by the owner/);
  const pid = (await t.svc.issue(q.quoteId, h(9)))!;
  assert.equal(t.svc.state().policies[0].skus, undefined);
  const doc: ClaimEvidence = { v: 2, reason: 'AM20', paymentTxs: [h(9)], note: '', delivery: [{ note: { v: 1, order: h(10), paymentTx: h(9), ordered: '/shop/wine/rioja', shipped: '/shop/wine/rioja', at: 1 }, signer: SHOP, sig: 'ok' }] };
  t.events.set('r0', receiptEvent(h(10)));
  t.claims.set(0n, { policyId: pid, claimant: PAYER, kind: 'AgentMistake', amount: 24n * EUR, evidence: await evidenceHash(doc), orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  assert.match((await t.svc.assessClaim(0n, ['r0'], doc)).reason, /owner-signed AP2 intent/);
});

test('an unknown reason code in the evidence is ignored and never stored (it would reach on-chain metadata)', async () => {
  const t = harness();
  const q = await quoteOk(t.svc);
  const pid = (await t.svc.issue(q.quoteId, h(9)))!;
  const doc = { v: 2, reason: 'AM10;by=human', paymentTxs: [h(9)], note: '' } as unknown as ClaimEvidence;
  t.events.set('r0', receiptEvent(h(10)));
  t.claims.set(0n, { policyId: pid, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: await evidenceHash(doc), orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(0n, ['r0'], doc);
  assert.equal(t.svc.state().claims[0].reason, undefined);
});

test('resuming an agent confirms its earlier purchases: they never trip the breaker again', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, coverOf: async () => ({ periodRemaining: 100n * EUR, policyId: 0n }), hold: async () => {}, unhold: async () => {} });
  const seen = (order: number, at: number) => ({ owner: OWNER, mandateId: h(7), order: h(order), paymentTx: h(order + 50), amount: 3n * EUR, at, receiptTx: h(order + 100) });
  assert.equal((await t.svc.onReceipts([seen(20, 1_000_000), seen(21, 1_010_000)])).length, 1);
  assert.equal((await t.svc.onReceipts([seen(22, 1_020_000)])).length, 0, 'one more purchase while paused (it slipped through)');
  now = 1_030_000;
  await t.svc.clearHold(PAYER);
  assert.equal((await t.svc.onReceipts([seen(23, 1_040_000)])).length, 0, 'pairs only with purchases the owner confirmed: nothing');
  assert.equal((await t.svc.onReceipts([seen(24, 1_050_000)])).length, 1, 'two new duplicates after the resume do trip it');
});

// ---- roadmap: v3 parametric filing, terms, merchant-paid cover, giveback ----

test('v3 parametric: the insurer files the detected duplicate itself and assesses it', async () => {
  const filed: string[] = [];
  let insured = false;
  const t = harness({ coverOf: async () => (insured ? { periodRemaining: 100n * EUR, policyId: 0n } : { periodRemaining: 0n, policyId: null }), hold: async () => {} });
  const q = await quoteOk(t.svc);
  const pid = (await t.svc.issue(q.quoteId, h(9)))!;
  insured = true;
  t.svc['deps'].cover.fileClaimFor = async (p) => {
    filed.push(p.orders.join(','));
    t.claims.set(3n, { policyId: p.policyId, claimant: PAYER, kind: 'AgentMistake', amount: p.amount, evidence: p.evidence, orders: p.orders, status: { tag: 'Filed' }, payout: 0n });
    return { hash: 'tx', id: 3n };
  };
  for (const o of [20, 21]) t.events.set(h(o + 100), { at: 1_000_500, sender: SHOP, events: [{ type: 'Receipt', owner: OWNER, id: h(7), order: h(o), paymentTx: h(o + 50), amount: 3n * EUR, spent: 3n * EUR }] });
  const seen = (order: number, at: number) => ({ owner: OWNER, mandateId: h(7), order: h(order), paymentTx: h(order + 50), amount: 3n * EUR, at, receiptTx: h(order + 100) });
  await t.svc.onReceipts([seen(20, 1_000_000), seen(21, 1_060_000)]);
  assert.deepEqual(filed, [`${h(20)},${h(21)}`]);
  const d = t.svc.detectionsOf(PAYER)[0];
  assert.equal(d.status, 'filed');
  assert.equal(d.filedBy, 'insurer');
  const c = t.svc.state().claims.find((x) => x.claimId === 3n)!;
  assert.equal(c.assessment.ok, true, c.assessment.reason);
  assert.equal(c.reason, 'AM10');
  assert.equal(pid, 0n);
});

test('v3 terms: the owner-signed intent is anchored on the policy; incidents halve the automatic limit', async () => {
  const terms: unknown[] = [];
  const t = harness({
    autoPayLimit: 10n * EUR, ap2Merchant: (name: string) => ({ 'Kuasa demo shop': SHOP, 'Kuasa Cover': TREASURY } as Record<string, string>)[name],
    verifyAp2Owner: async () => true,
  });
  t.svc['deps'].cover.setTerms = async (id, x) => { terms.push([id, x]); return { hash: 'terms-tx' }; };
  const ap2 = { user_cart_confirmation_required: false, natural_language_description: 'bread', merchants: ['Kuasa demo shop', 'Kuasa Cover'], skus: ['/shop/groceries/bread'], intent_expiry: '2099-01-01T00:00:00Z', user_authorization: 'sig' };
  const q = await t.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30, ap2 });
  assert.ok(!('refused' in q));
  await t.svc.issue(q.quoteId, h(9));
  for (let i = 0; i < 50 && !t.svc.state().policies[0].terms; i++) await new Promise((r) => setTimeout(r, 5));
  const [[id, x]] = terms as [bigint, { autoPayLimit: bigint; intent: string }][];
  assert.equal(id, 0n);
  assert.equal(x.autoPayLimit, 10n * EUR);
  assert.match(x.intent, /^[0-9a-f]{64}$/);
  assert.equal(t.svc.state().policies[0].terms?.tx, 'terms-tx');
  // an agent with incidents gets half the automatic limit
  const t2 = harness({ autoPayLimit: 10n * EUR });
  const seen2: { autoPayLimit: bigint }[] = [];
  t2.svc['deps'].cover.setTerms = async (_id, y) => { seen2.push(y); return { hash: 'x' }; };
  t2.setEntry(entry({ incidents: 1n }));
  await t2.svc.issue((await quoteOk(t2.svc)).quoteId, h(9));
  for (let i = 0; i < 50 && !seen2.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen2[0].autoPayLimit, 5n * EUR);
});

test('buyer-chosen terms: maxAutoPay only tightens the automatic limit (0 = every claim to a human), and the insurer honours it off-chain too', async () => {
  const run = async (maxAutoPay: bigint) => {
    const t = harness({ autoPayLimit: 10n * EUR });
    const seen: { autoPayLimit: bigint }[] = [];
    t.svc['deps'].cover.setTerms = async (_id, y) => { seen.push(y); return { hash: 'x' }; };
    const q = await t.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30, maxAutoPay });
    assert.ok(!('refused' in q));
    await t.svc.issue(q.quoteId, h(9));
    for (let i = 0; i < 50 && !t.svc.state().policies[0].terms; i++) await new Promise((r) => setTimeout(r, 5));
    return { t, limit: seen[0]?.autoPayLimit };
  };
  assert.equal((await run(0n)).limit, 0n);
  assert.equal((await run(4n * EUR)).limit, 4n * EUR);
  assert.equal((await run(50n * EUR)).limit, 10n * EUR, 'cannot loosen the insurer rule');
  const { t } = await run(0n);
  await filedClaim(t, true, 0n);
  assert.equal(t.svc.state().claims[0].autoPayAt, undefined, 'the buyer asked for a human on every claim');
  const v2 = harness({ autoPayLimit: 10n * EUR }); // no setTerms on this contract
  const q2 = await v2.svc.quote({ mandateUrl: 'x', limit: 100n * EUR, days: 30, maxAutoPay: 0n });
  assert.ok(!('refused' in q2));
  await v2.svc.issue(q2.quoteId, h(9));
  await filedClaim(v2, true, 0n);
  assert.equal(v2.svc.state().claims[0].autoPayAt, undefined, 'honoured off-chain even where the contract has no terms');
});

test('escalation: an appeal of a panel decision goes to a human at the insurer, not to the panel again', async () => {
  const [J1, J2, J3] = [addr(31), addr(32), addr(33)];
  const t = harness({ jurors: [J1, J2, J3] });
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, false);
  const ev = await wrongItemEvidence(h(10));
  t.claims.set(1n, { policyId: 0n, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(1n, ['r0'], ev.doc);
  await t.svc.panelVote(1n, J1, false);
  await t.svc.panelVote(1n, J2, false); // the panel rejects the appeal
  t.claims.set(2n, { policyId: 0n, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(2n, ['r0'], ev.doc);
  assert.notEqual(t.svc.state().claims.find((c) => c.claimId === 2n)!.appealOf, undefined);
  await assert.rejects(t.svc.panelVote(2n, J3, true), /escalated/);
  assert.equal(t.svc.openAppeals().find((a) => a.claimId === 2n)!.escalated, true);
});

test('merchant-paid cover: the sponsor signs and pays; the policy covers the agent; nobody else may pay', async () => {
  const proofs: string[] = [];
  const t = harness({ verifyPayer: async (who) => { proofs.push(who); return who === SHOP; } });
  const q = await t.svc.quote({ mandateUrl: 'x', limit: 20n * EUR, days: 1, order: { ref: h(3), amount: 20n * EUR }, sponsor: SHOP });
  assert.ok(!('refused' in q), 'refused' in q ? q.refused : '');
  assert.deepEqual(proofs, [SHOP]);
  assert.match((await t.svc.checkPurchase(q.quoteId, OWNER, q.premium))!, /only the sponsor/);
  assert.match((await t.svc.checkPurchase(q.quoteId, PAYER, q.premium))!, /only the sponsor/, 'not even the agent: the refund would go to the sponsor');
  assert.equal(await t.svc.checkPurchase(q.quoteId, SHOP, q.premium), null);
  await t.svc.issue(q.quoteId, h(9));
  assert.equal(t.svc.state().policies[0].payer, PAYER, 'the agent is insured');
  assert.equal(t.svc.state().policies[0].sponsor, SHOP, 'refunds and givebacks go back to the sponsor');
});

test('giveback: a claim-free policy that ended returns a share of its premium, once', async () => {
  let now = 1_000_000;
  const t = harness({ now: () => now, givebackBps: 1_000n });
  const q = await quoteOk(t.svc);
  await t.svc.issue(q.quoteId, h(9));
  await t.svc.givebackExpired();
  assert.ok(!t.calls.some((c) => c.startsWith('pay:')), 'still running');
  now += 31 * 86_400_000;
  await t.svc.givebackExpired();
  await t.svc.givebackExpired();
  const pays = t.calls.filter((c) => c.startsWith('pay:'));
  assert.deepEqual(pays, [`pay:${PAYER}:${q.premium / 10n}`]);
  // a policy with a claim gets nothing back
  const t2 = harness({ now: () => now, givebackBps: 1_000n });
  await filedClaim(t2, true, 0n);
  now += 62 * 86_400_000;
  await t2.svc.givebackExpired();
  assert.ok(!t2.calls.some((c) => c.startsWith('pay:')));
});

test('appeals panel: independent jurors vote; a majority decides the appeal like a human would; parties cannot judge', async () => {
  const [J1, J2, J3] = [addr(31), addr(32), addr(33)];
  const t = harness({ jurors: [J1, J2, J3, PAYER] });
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, false); // a human rejected it
  const ev = await wrongItemEvidence(h(10));
  t.claims.set(1n, { policyId: 0n, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(1n, ['r0'], ev.doc);
  await assert.rejects(t.svc.panelVote(0n, J1, true), /only appeals/);
  await assert.rejects(t.svc.panelVote(1n, addr(40), true), /not a juror/);
  await assert.rejects(t.svc.panelVote(1n, PAYER, true), /party to the claim/);
  assert.equal((await t.svc.panelVote(1n, J1, true)).decided, false);
  await assert.rejects(t.svc.panelVote(1n, J1, true), /already voted/);
  assert.equal((await t.svc.panelVote(1n, J2, false)).decided, false);
  const r = await t.svc.panelVote(1n, J3, true); // 3 of 4 jurors needed: J1, J3 yes ... not yet
  assert.equal(r.decided, false);
  assert.deepEqual(t.svc.openAppeals().map((a) => a.claimId), [1n]);
});

test('staked panel: jurors need capital in the pool; jurors against the verdict pay those with it; stakes locked while voting', async () => {
  const [J1, J2, J3, J4, J5] = [addr(31), addr(32), addr(33), addr(34), addr(35)];
  const stakes = new Map([[J1, 10n * EUR], [J2, 10n * EUR], [J3, 10n * EUR], [J4, 10n * EUR], [J5, 2n * EUR]]);
  const settled: { from: string; to: string; amount: bigint }[][] = [];
  const t = harness({ jurors: [J1, J2, J3, J4, J5], jurorStake: (j) => stakes.get(j) ?? 0n, jurorMinStake: 5n * EUR, jurorPenalty: EUR, settlePanel: (m) => settled.push(m) });
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, false);
  const ev = await wrongItemEvidence(h(10));
  t.claims.set(1n, { policyId: 0n, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(1n, ['r0'], ev.doc);
  await assert.rejects(t.svc.panelVote(1n, J5, true), /at least 5000000 of capital staked/);
  await t.svc.panelVote(1n, J1, true);
  await t.svc.panelVote(1n, J2, false);
  assert.equal(t.svc.jurorBusy(J2), true);
  await t.svc.panelVote(1n, J3, true);
  const r = await t.svc.panelVote(1n, J4, true); // 3 of 5: approved
  assert.equal(r.decided, true);
  assert.deepEqual(settled, [[{ from: J2, to: J1, amount: 333_334n }, { from: J2, to: J3, amount: 333_333n }, { from: J2, to: J4, amount: 333_333n }]]);
  assert.equal(t.svc.jurorBusy(J2), false);
  assert.equal(t.svc.state().claims.find((c) => c.claimId === 1n)!.panelSettlement!.length, 3);
});

test('staked panel: a vote arriving while the majority decision is in flight neither decides nor settles again', async () => {
  const [J1, J2, J3] = [addr(31), addr(32), addr(33)];
  const settled: unknown[] = [];
  const t = harness({ jurors: [J1, J2, J3], jurorStake: () => 10n * EUR, jurorMinStake: 5n * EUR, jurorPenalty: EUR, settlePanel: (m) => settled.push(m) });
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, false);
  const ev = await wrongItemEvidence(h(10));
  t.claims.set(1n, { policyId: 0n, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(1n, ['r0'], ev.doc);
  await t.svc.panelVote(1n, J1, true);
  const [a, b] = await Promise.allSettled([t.svc.panelVote(1n, J2, true), t.svc.panelVote(1n, J3, false)]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.match(String((b as PromiseRejectedResult).reason), /already decided/);
  assert.equal(settled.length, 0, 'nobody voted against the verdict, and nothing settled twice');
  assert.equal(t.calls.filter((c) => c.startsWith('pay:')).length, 1);
});

test('staked panel: jurors stay locked until the settlement runs; a failed payout still settles the standing verdict', async () => {
  const [J1, J2, J3] = [addr(31), addr(32), addr(33)];
  const settled: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const t = harness({ jurors: [J1, J2, J3], jurorStake: () => 10n * EUR, jurorMinStake: 5n * EUR, jurorPenalty: EUR, settlePanel: (m) => settled.push(m),
    pay: async () => { await gate; throw new Error('node down'); } });
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, false);
  const ev = await wrongItemEvidence(h(10));
  t.claims.set(1n, { policyId: 0n, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(1n, ['r0'], ev.doc);
  await t.svc.panelVote(1n, J1, false);
  await t.svc.panelVote(1n, J2, true);
  const deciding = t.svc.panelVote(1n, J3, true).catch((e) => e);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(t.svc.jurorBusy(J1), true, 'the verdict is set but J1 has not paid its penalty yet');
  release();
  await deciding;
  assert.equal(settled.length, 1);
  assert.equal(t.svc.jurorBusy(J1), false);
});

test('staked panel with minimum stake 0: an unstaked juror may vote but neither pays nor receives a penalty', async () => {
  const [J1, J2, J3] = [addr(31), addr(32), addr(33)];
  const stakes = new Map([[J2, 10n * EUR], [J3, 10n * EUR]]); // J1 holds no capital
  const settled: { from: string; to: string; amount: bigint }[][] = [];
  const t = harness({ jurors: [J1, J2, J3], jurorStake: (j) => stakes.get(j) ?? 0n, jurorMinStake: 0n, jurorPenalty: EUR, settlePanel: (m) => settled.push(m) });
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, false);
  const ev = await wrongItemEvidence(h(10));
  t.claims.set(1n, { policyId: 0n, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(1n, ['r0'], ev.doc);
  await t.svc.panelVote(1n, J2, false);
  await t.svc.panelVote(1n, J1, true);
  await t.svc.panelVote(1n, J3, true); // approved; J2 against
  assert.deepEqual(settled, [[{ from: J2, to: J3, amount: EUR }]]);
});

test('appeals panel: a majority approves and the appeal is paid', async () => {
  const [J1, J2, J3] = [addr(31), addr(32), addr(33)];
  const t = harness({ jurors: [J1, J2, J3] });
  await filedClaim(t, true, 0n);
  await t.svc.decide(0n, false);
  const ev = await wrongItemEvidence(h(10));
  t.claims.set(1n, { policyId: 0n, claimant: PAYER, kind: 'WrongItem', amount: 24n * EUR, evidence: ev.hash, orders: [h(10)], status: { tag: 'Filed' }, payout: 0n });
  await t.svc.assessClaim(1n, ['r0'], ev.doc);
  await t.svc.panelVote(1n, J1, true);
  const r = await t.svc.panelVote(1n, J2, true);
  assert.equal(r.decided, true);
  assert.equal('paid' in r && r.paid, 'payout-tx');
  assert.equal(t.svc.state().claims.find((c) => c.claimId === 1n)!.decidedBy, 'panel');
  assert.deepEqual(t.svc.openAppeals(), []);
});
