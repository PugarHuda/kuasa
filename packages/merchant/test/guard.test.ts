import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountAddress } from '@concordium/web-sdk';
import { canonicalJson, type CoverView, type Mandate, mandateId, type MandateEntry, sha256Hex } from '@kuasa/core';
import { KuasaGuard, ORDER_HEADER } from '../src/guard.js';
import type { AgentRegistry, CoverCheck } from '../src/foundations.js';

const addr = (n: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(n).buffer).address;
const [OWNER, PAYER, SHOP, RECORDER] = [1, 2, 3, 4].map(addr);

const mandate: Mandate = {
  v: 1, network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  principal: { kind: 'person', account: OWNER },
  agent: { registry: { index: '12802', subindex: '0', tokenId: '7' }, payer: PAYER },
  scope: { asset: 'EUDemo', maxPerOrder: '50000000', maxTotal: '100000000', categories: ['wine'], validFrom: 0, validUntil: 4_000_000_000 },
  proof: { auditRecordUri: 'https://k.example/proof.json', auditRecordSha256: 'a'.repeat(64) },
  createdAt: 0,
};

function makeGuard(entry: Partial<MandateEntry> | null, claims = { ageOver: 30, residency: ['DK'] }, extra: Partial<ConstructorParameters<typeof KuasaGuard>[0]> = {}) {
  const base: MandateEntry = {
    owner: OWNER, payer: PAYER, agentRegistry: { index: 12802n, subindex: 0n }, agentToken: '7', uri: 'https://k.example/m.json',
    maxTotal: 100000000n, spent: 0n, validUntilMs: 4_000_000_000_000n, revoked: false, recorders: [RECORDER], receipts: 0n, incidents: 0n,
  };
  return new KuasaGuard({
    grpc: {} as never, network: 'Testnet',
    registry: { view: async () => (entry === null ? null : { ...base, ...entry }) } as never,
    offers: { 'GET /wine/:sku': { category: 'wine', requirements: { minAge: 18, residencyIn: ['DK', 'DE'] } } },
    recorder: { address: AccountAddress.fromBase58(RECORDER), signer: {} as never },
    fetchText: async (u) => (u.endsWith('m.json') ? canonicalJson(mandate) : '{}'),
    verifyProof: async () => ({ ok: true, claims }),
    ...extra,
  });
}

const buy = (g: KuasaGuard, o: Partial<Parameters<KuasaGuard['decide']>[0]> = {}) =>
  g.decide({ mandateUrl: 'https://k.example/m.json', route: 'GET /wine/:sku', payer: PAYER, payTo: SHOP, asset: 'EUDemo', amount: 24000000n, ...o });

test('authorises an in-scope purchase and returns the mandate id', async () => {
  const d = await buy(makeGuard({}));
  assert.equal(d.ok, true);
  assert.equal(d.mandateId, await mandateId(mandate));
});

test('rejects with readable reasons', async () => {
  const reasons = async (g: KuasaGuard, o = {}) => ((await buy(g, o)) as { reasons: string[] }).reasons.join('; ');
  assert.match(await reasons(makeGuard({}), { mandateUrl: undefined }), /no mandate presented/);
  assert.match(await reasons(makeGuard({}), { route: 'GET /vape' }), /no Kuasa offer/);
  assert.match(await reasons(makeGuard(null)), /not registered/);
  assert.match(await reasons(makeGuard({ revoked: true })), /revoked/);
  assert.match(await reasons(makeGuard({}, { ageOver: 16, residency: ['DK'] })), /age>=18/);
  assert.match(await reasons(makeGuard({ recorders: [OWNER] })), /record receipts/);
  assert.match(await reasons(makeGuard({}), { payer: SHOP }), /payer is not the mandated agent/);
});

test('x402 hook aborts before verification when the mandate says no', async () => {
  const g = makeGuard({ revoked: true });
  const out = await g.beforeVerify({
    paymentPayload: { payload: { signedTransaction: { header: { sender: PAYER } } } },
    requirements: { payTo: SHOP, asset: 'EUDemo', amount: '24000000' },
    transportContext: { request: { routePattern: 'GET /wine/:sku', adapter: { getHeader: (n: string) => (n === 'x-kuasa-mandate' ? 'https://k.example/m.json' : undefined) } } },
  });
  assert.equal(out?.abort, true);
  assert.match(out!.message!, /revoked/);
});

test('parallel purchases cannot overspend the budget', async () => {
  const g = makeGuard({ maxTotal: 50000000n });
  const pay = (nonce: number) => g.beforeVerify({
    paymentPayload: { payload: { signedTransaction: { header: { sender: PAYER, nonce } } } },
    requirements: { payTo: SHOP, asset: 'EUDemo', amount: '30000000' },
    transportContext: { request: { routePattern: 'GET /wine/:sku', adapter: { getHeader: (n: string) => (n === 'x-kuasa-mandate' ? 'https://k.example/m.json' : undefined) } } },
  });
  const [a, b] = await Promise.all([pay(1), pay(2)]);
  assert.equal([a, b].filter((r) => r?.abort).length, 1, 'exactly one of two 30-unit buys fits a 50-unit budget');
  assert.equal((await pay(1))?.reason, 'kuasa_duplicate_payment');
});

test('ssrf guard rejects non-public targets', async () => {
  const { safeFetchText, isPrivate } = await import('../src/safe-fetch.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivate(ip), ip);
  assert.ok(!isPrivate('8.8.8.8'));
  await assert.rejects(safeFetchText('http://example.com/m.json'), /only https/);
  await assert.rejects(safeFetchText('https://169.254.169.254/latest'), /non-public/);
});

const agents = (a: { owner: string; active: boolean } | null): AgentRegistry => ({ agentOf: async () => a });
const cover = (v: Partial<CoverView>, seen: (string | undefined)[] = []): CoverCheck => ({
  coverOf: async (_payer, order) => { seen.push(order); return { periodRemaining: 0n, orderLimit: 0n, policyId: null, ...v }; },
});
const coveredWine = { 'GET /wine/:sku': { category: 'wine', requirements: { minAge: 18, residencyIn: ['DK', 'DE'], minCover: 20000000n } } };

test('rejects agent token not active / owner != principal', async () => {
  const why = async (a: { owner: string; active: boolean } | null) => ((await buy(makeGuard({}, undefined, { agents: agents(a) }))) as { reasons?: string[] }).reasons?.join('; ') ?? 'ok';
  assert.equal(await why({ owner: OWNER, active: true }), 'ok');
  assert.match(await why({ owner: OWNER, active: false }), /agent .*not active/);
  assert.match(await why({ owner: SHOP, active: true }), /agent .*not owned by the principal/);
  assert.match(await why(null), /agent .*not registered/);
});

test('minCover: refused without cover, allowed with period cover >= amount, allowed with order cover for header orderRef', async () => {
  const why = async (v: Partial<CoverView>, o = {}) => ((await buy(makeGuard({}, undefined, { offers: coveredWine, cover: cover(v) }), o)) as { reasons?: string[] }).reasons?.join('; ') ?? 'ok';
  assert.match(await why({}), /cover required/);
  assert.match(await why({ periodRemaining: 10000000n }), /cover required/);
  assert.equal(await why({ periodRemaining: 100000000n }), 'ok');
  const seen: (string | undefined)[] = [];
  const g = makeGuard({}, undefined, { offers: coveredWine, cover: cover({ orderLimit: 30000000n }, seen) });
  const ref = await g.issueOrderRef({ payer: PAYER, payTo: SHOP, route: 'GET /wine/:sku', amount: 24000000n });
  assert.equal((await buy(g, { orderRef: ref })).ok, true);
  assert.equal(seen.at(-1), ref);
});

test('receipt order binds orderRef', async () => {
  const orders: string[] = [];
  const g = makeGuard({}, undefined, {
    registry: { view: async () => ({ owner: OWNER, payer: PAYER, agentRegistry: { index: 12802n, subindex: 0n }, agentToken: '7', uri: '', maxTotal: 100000000n, spent: 0n, validUntilMs: 4_000_000_000_000n, revoked: false, recorders: [RECORDER], receipts: 0n, incidents: 0n }),
      recordReceipt: async (_o: string, _i: string, order: string) => { orders.push(order); return { hash: 'r' }; } } as never,
  });
  const ref = await g.issueOrderRef({ payer: PAYER, payTo: SHOP, route: 'GET /wine/:sku', amount: 24000000n });
  const payload = { signedTransaction: { header: { sender: PAYER, nonce: 9 } } };
  const requirements = { payTo: SHOP, asset: 'EUDemo', amount: '24000000' };
  const headers: Record<string, string> = { 'x-kuasa-mandate': 'https://k.example/m.json', [ORDER_HEADER]: ref };
  const out = await g.beforeVerify({ paymentPayload: { payload }, requirements, transportContext: { request: { routePattern: 'GET /wine/:sku', adapter: { getHeader: (n: string) => headers[n] } } } });
  assert.equal(out, undefined);
  await g.afterSettle({ paymentPayload: { payload }, requirements, result: { transaction: 'ab'.repeat(32) } });
  assert.deepEqual(orders, [await sha256Hex(ref + 'ab'.repeat(32))]);
  assert.equal(g.receipts[0].orderRef, ref);
});

test('unknown order reference is refused before payment', async () => {
  const g = makeGuard({});
  const headers: Record<string, string> = { 'x-kuasa-mandate': 'https://k.example/m.json', [ORDER_HEADER]: 'f'.repeat(64) };
  const out = await g.beforeVerify({
    paymentPayload: { payload: { signedTransaction: { header: { sender: PAYER, nonce: 1 } } } },
    requirements: { payTo: SHOP, asset: 'EUDemo', amount: '24000000' },
    transportContext: { request: { routePattern: 'GET /wine/:sku', adapter: { getHeader: (n: string) => headers[n] } } },
  });
  assert.match(out?.message ?? '', /order reference/);
});

const payWith = (g: KuasaGuard, nonce: number, headers: Record<string, string>) => g.beforeVerify({
  paymentPayload: { payload: { signedTransaction: { header: { sender: PAYER, nonce } } } },
  requirements: { payTo: SHOP, asset: 'EUDemo', amount: '24000000' },
  transportContext: { request: { routePattern: 'GET /wine/:sku', adapter: { getHeader: (n: string) => headers[n] } } },
});

test('parallel covered purchases cannot exceed period cover', async () => {
  const g = makeGuard({}, undefined, { offers: coveredWine, cover: cover({ periodRemaining: 30000000n }) });
  const h = { 'x-kuasa-mandate': 'https://k.example/m.json' };
  const [a, b] = await Promise.all([payWith(g, 1, h), payWith(g, 2, h)]);
  assert.equal([a, b].filter((r) => r?.abort).length, 1, 'only one 24-unit buy fits 30 units of cover');
});

test('an order reference cannot back two parallel payments', async () => {
  const g = makeGuard({});
  const ref = await g.issueOrderRef({ payer: PAYER, payTo: SHOP, route: 'GET /wine/:sku', amount: 24000000n });
  const h = { 'x-kuasa-mandate': 'https://k.example/m.json', [ORDER_HEADER]: ref };
  const [a, b] = await Promise.all([payWith(g, 1, h), payWith(g, 2, h)]);
  assert.equal([a, b].filter((r) => r?.abort).length, 1);
});

test('a rejected purchase gives its order reference back', async () => {
  const g = makeGuard({ revoked: true });
  const ref = await g.issueOrderRef({ payer: PAYER, payTo: SHOP, route: 'GET /wine/:sku', amount: 24000000n });
  const h = { 'x-kuasa-mandate': 'https://k.example/m.json', [ORDER_HEADER]: ref };
  assert.match((await payWith(g, 1, h))?.message ?? '', /revoked/);
  assert.match((await payWith(g, 2, h))?.message ?? '', /revoked/, 'still the mandate reason, not an unknown ref');
});

test('order references are bounded globally: refused at the cap', async () => {
  const g = makeGuard({}, undefined, { maxOrders: 2 });
  const first = await g.issueOrderRef({ payer: PAYER, payTo: SHOP, route: 'GET /wine/:sku', amount: 24000000n });
  await g.issueOrderRef({ payer: SHOP, payTo: SHOP, route: 'GET /wine/:sku', amount: 1n });
  await assert.rejects(g.issueOrderRef({ payer: OWNER, payTo: SHOP, route: 'GET /wine/:sku', amount: 1n }), /too many open order references/);
  const h = { 'x-kuasa-mandate': 'https://k.example/m.json', [ORDER_HEADER]: first };
  assert.equal(await payWith(g, 3, h), undefined, 'existing references are never pushed out');
});

test('order references are capped per payer: new ones refused, existing never evicted', async () => {
  const g = makeGuard({}, undefined, { maxOrdersPerPayer: 2 });
  const first = await g.issueOrderRef({ payer: PAYER, payTo: SHOP, route: 'GET /wine/:sku', amount: 24000000n });
  await g.issueOrderRef({ payer: PAYER, payTo: SHOP, route: 'GET /wine/:sku', amount: 24000000n });
  await assert.rejects(g.issueOrderRef({ payer: PAYER, payTo: SHOP, route: 'GET /wine/:sku', amount: 24000000n }), /too many open order references/);
  assert.equal(g.orderRefCount(PAYER), 2);
  const h = { 'x-kuasa-mandate': 'https://k.example/m.json', [ORDER_HEADER]: first };
  assert.equal(await payWith(g, 7, h), undefined, 'the first reference still works');
});

test('a payment that fails verification or is canceled releases its reservation', async () => {
  const g = makeGuard({ maxTotal: 50000000n });
  const payload = (nonce: number) => ({ signedTransaction: { header: { sender: PAYER, nonce } } });
  const pay = (nonce: number) => g.beforeVerify({
    paymentPayload: { payload: payload(nonce) },
    requirements: { payTo: SHOP, asset: 'EUDemo', amount: '30000000' },
    transportContext: { request: { routePattern: 'GET /wine/:sku', adapter: { getHeader: (n: string) => (n === 'x-kuasa-mandate' ? 'https://k.example/m.json' : undefined) } } },
  });
  assert.equal(await pay(1), undefined);
  await g.verifyFailed({ paymentPayload: { payload: payload(1) } }); // e.g. the facilitator answered 502
  assert.equal(await pay(1), undefined, 'the same signed payment can be retried');
  await g.afterVerify({ paymentPayload: { payload: payload(1) }, result: { isValid: false } });
  assert.equal(await pay(1), undefined, 'released after an invalid verification');
  await g.afterVerify({ paymentPayload: { payload: payload(1) }, result: { isValid: true } });
  assert.equal((await pay(1))?.reason, 'kuasa_duplicate_payment', 'a valid verification keeps it');
  await g.verifiedCanceled({ paymentPayload: { payload: payload(1) } });
  assert.equal(await pay(1), undefined, 'released when canceled before settlement');
});

test('insurer circuit breaker: a hold on the payer refuses every purchase; a cleared hold or none allows it; no answer fails closed', async () => {
  const why = async (holdOf: (p: string) => Promise<string | null>) => ((await buy(makeGuard({}, undefined, { holdOf }))) as { reasons?: string[] }).reasons?.join('; ') ?? 'ok';
  assert.match(await why(async () => 'hold;reason=duplicate-orders;at=1'), /paused by the insurer \(reason=duplicate-orders\)/);
  assert.equal(await why(async () => 'clear;by=owner;at=2'), 'ok');
  assert.equal(await why(async () => null), 'ok');
  assert.match(await why(async () => { throw new Error('502'); }), /hold check unavailable/);
});

test('an order reference survives a payment that failed before any money moved (verify failure), but is single-use once settled', async () => {
  const g = makeGuard({}, undefined, {
    registry: { view: async () => ({ owner: OWNER, payer: PAYER, agentRegistry: { index: 12802n, subindex: 0n }, agentToken: '7', uri: '', maxTotal: 100000000n, spent: 0n, validUntilMs: 4_000_000_000_000n, revoked: false, recorders: [RECORDER], receipts: 0n, incidents: 0n }),
      recordReceipt: async () => ({ hash: 'r' }) } as never,
  });
  const ref = await g.issueOrderRef({ payer: PAYER, payTo: SHOP, route: 'GET /wine/:sku', amount: 24000000n });
  const payload = (nonce: number) => ({ signedTransaction: { header: { sender: PAYER, nonce } } });
  const requirements = { payTo: SHOP, asset: 'EUDemo', amount: '24000000' };
  const headers: Record<string, string> = { 'x-kuasa-mandate': 'https://k.example/m.json', [ORDER_HEADER]: ref };
  const pay = (nonce: number) => g.beforeVerify({ paymentPayload: { payload: payload(nonce) }, requirements, transportContext: { request: { routePattern: 'GET /wine/:sku', adapter: { getHeader: (n: string) => headers[n] } } } });
  assert.equal(await pay(1), undefined);
  await g.verifyFailed({ paymentPayload: { payload: payload(1) } }); // e.g. the payer lacked funds
  assert.equal(await pay(2), undefined, 'the reference is usable again');
  await g.afterSettle({ paymentPayload: { payload: payload(2) }, requirements, result: { transaction: 'ab'.repeat(32) } });
  assert.match((await pay(3))?.message ?? '', /unknown or expired order reference/, 'settled: used up');
});
