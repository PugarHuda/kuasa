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
