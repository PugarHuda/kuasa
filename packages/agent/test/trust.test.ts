import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountAddress } from '@concordium/web-sdk';
import { KuasaAgent } from '../src/client.js';

const addr = (n: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(n).buffer).address;
const [PAYER, SHOP, OTHER] = [addr(2), addr(3), addr(9)];
const card = { name: 'shop', kuasa: { payTo: SHOP, agentToken: 'ab' } };

function agent(a: { owner: string; active: boolean } | null, c: unknown = card) {
  return new KuasaAgent({
    shopUrl: 'http://localhost:4021', mandateUrl: 'http://localhost:4021/m.json', payer: PAYER, payerKey: '11'.repeat(32),
    scope: { asset: 'EUDemo', maxPerOrder: '50000000', merchants: [SHOP] },
    agents: { agentOf: async () => a },
    fetchJson: async () => c,
  });
}

test('refuses shop whose payTo has no active agent', async () => {
  assert.equal(await agent({ owner: SHOP, active: true }).verifyShop(), null);
  assert.match((await agent(null).verifyShop())!, /not registered/);
  assert.match((await agent({ owner: SHOP, active: false }).verifyShop())!, /not active/);
  assert.match((await agent({ owner: OTHER, active: true }).verifyShop())!, /not owned/);
  assert.match((await agent({ owner: SHOP, active: true }, {}).verifyShop())!, /agent card/);
});

test('payment-time policy only pays the verified payTo for that counterparty', async () => {
  const { paymentAllowed } = await import('../src/client.js');
  const scope = { asset: 'EUDemo', maxPerOrder: '50000000', merchants: [SHOP, OTHER] };
  const req = (payTo: string) => ({ network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27', asset: 'EUDemo', amount: '24000000', payTo });
  assert.equal(paymentAllowed(scope, SHOP, req(SHOP)), true);
  assert.equal(paymentAllowed(scope, SHOP, req(OTHER)), false, 'another allow-listed merchant is not the verified shop');
  assert.equal(paymentAllowed(scope, undefined, req(SHOP)), false, 'fail closed without a verified counterparty');
});

test('insurer payments must match the quoted premium exactly', async () => {
  const { paymentAllowed } = await import('../src/client.js');
  const scope = { asset: 'EUDemo', maxPerOrder: '50000000', merchants: [SHOP] };
  const req = (amount: string) => ({ network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27', asset: 'EUDemo', amount, payTo: SHOP });
  assert.equal(paymentAllowed(scope, SHOP, req('1749600'), 1749600n), true);
  assert.equal(paymentAllowed(scope, SHOP, req('1749601'), 1749600n), false, 'insurer asks more than quoted');
  assert.equal(paymentAllowed(scope, SHOP, req('24000000')), true, 'no expected amount: mandate limits only');
});
