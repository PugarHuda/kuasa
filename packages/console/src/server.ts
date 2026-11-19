/**
 * Kuasa Console + Incident Desk (demo). Reads mandates straight from the on-chain registry,
 * shows the shop's live guard decisions, and lets the owner revoke / the merchant file an incident.
 *
 * DEMO ONLY: it signs with the testnet keys in .kuasa/accounts, so it binds to localhost.
 * In production the owner revokes from their own wallet; nothing here needs custody.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { bigintJson, connect, KuasaRegistry, TESTNET, wallet } from '@kuasa/chain';
import { sha256Hex } from '@kuasa/core';

const ROOT = new URL('../../../.kuasa/', import.meta.url);
const PORT = Number(process.env.PORT ?? 4022);
const SHOP = process.env.KUASA_SHOP_URL ?? 'http://localhost:4021';
type State = { registry: string; agents: Record<string, string>; mandates: Record<string, { id: string; owner: string; payer: string; issueTx: string; proofAnchorTx: string }> };
const loadState = (): State => JSON.parse(readFileSync(new URL('state.json', ROOT), 'utf8'));
const account = (name: string, n: number) => {
  const a = JSON.parse(readFileSync(new URL(`accounts/${name}.json`, ROOT), 'utf8')).accounts.find((x: { credNumber: number }) => x.credNumber === n);
  return wallet(a.address, a.key);
};

const grpc = connect();
const registry = new KuasaRegistry(grpc, BigInt(loadState().registry));
const app = express();
const json = (res: express.Response, body: unknown, status = 200) => res.status(status).type('json').send(JSON.stringify(body, bigintJson));

app.get('/', (_, res) => res.sendFile(fileURLToPath(new URL('console.html', import.meta.url))));

app.get('/api/state', async (_, res) => {
  const s = loadState();
  const mandates = await Promise.all(Object.entries(s.mandates).map(async ([name, m]) => {
    const [entry, doc] = await Promise.all([registry.view(m.owner, m.id), fetch(`${SHOP}/kuasa/mandate/${name}.json`).then((r) => r.json()).catch(() => null)]);
    return { name, ...m, agentToken: s.agents[name], entry, doc };
  }));
  const shop = await fetch(`${SHOP}/kuasa-log`).then((r) => r.json()).catch(() => null);
  json(res, { registry: `<${s.registry},0>`, agentRegistry: '<12802,0>', explorer: TESTNET.explorer, mandates, shop });
});

/** Owner revokes: signed by the owner account (#0). Effective for every merchant on the next check. */
app.post('/api/revoke/:name', async (req, res) => {
  const m = loadState().mandates[req.params.name];
  if (!m) return json(res, { error: 'unknown mandate' }, 404);
  try {
    const reason = await sha256Hex(`revoked from Kuasa console at ${new Date().toISOString()}`);
    json(res, { tx: (await registry.revoke(m.id, reason, account(req.params.name, 0))).hash });
  } catch (e) { json(res, { error: (e as Error).message }, 500); }
});

/** Merchant files an incident with an evidence hash (the receipts it holds). */
app.post('/api/incident/:name', async (req, res) => {
  const m = loadState().mandates[req.params.name];
  if (!m) return json(res, { error: 'unknown mandate' }, 404);
  try {
    const shop = await fetch(`${SHOP}/kuasa-log`).then((r) => r.json()).catch(() => ({}));
    const evidence = await sha256Hex(JSON.stringify({ mandate: m.id, receipts: (shop.receipts ?? []).filter((r: { mandate: string }) => r.mandate === m.id) }));
    json(res, { tx: (await registry.reportIncident(m.owner, m.id, evidence, account('merchant', 1))).hash, evidence });
  } catch (e) { json(res, { error: (e as Error).message }, 500); }
});

app.listen(PORT, '127.0.0.1', () => console.log(`[console] http://localhost:${PORT}`));
