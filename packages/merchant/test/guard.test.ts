import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountAddress } from '@concordium/web-sdk';
import { canonicalJson, type Mandate, mandateId, type MandateEntry } from '@kuasa/core';
import { KuasaGuard } from '../src/guard.js';

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

function makeGuard(entry: Partial<MandateEntry> | null, claims = { ageOver: 30, residency: ['DK'] }) {
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
    transportContext: { request: { routePattern: 'GET /wine/:sku', adapter: { getHeader: () => 'https://k.example/m.json' } } },
  });
  assert.equal(out?.abort, true);
  assert.match(out!.message!, /revoked/);
});
