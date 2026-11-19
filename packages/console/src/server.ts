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
import { bigintJson, cis8004GetMetadata, cis8004SetMetadata, connect, KuasaCover, KuasaRegistry, TESTNET, wallet } from '@kuasa/chain';
import { sha256Hex } from '@kuasa/core';

const ROOT = new URL('../../../.kuasa/', import.meta.url);
const PORT = Number(process.env.PORT ?? 4022);
const SHOP = process.env.KUASA_SHOP_URL ?? 'http://localhost:4021';
const INSURER = process.env.KUASA_INSURER_URL ?? 'http://localhost:4023';
/** Calls the insurer's console-only routes (localhost + header). */
const insurer = (path: string, init: RequestInit = {}) =>
  fetch(`${INSURER}${path}`, { ...init, headers: { 'x-kuasa-console': '1', 'content-type': 'application/json', ...(init.headers ?? {}) } });
type State = { registry: string; cover?: string; agents: Record<string, string>; mandates: Record<string, { id: string; owner: string; payer: string; issueTx: string; proofAnchorTx: string }> };
const loadState = (): State => JSON.parse(readFileSync(new URL('state.json', ROOT), 'utf8'));
const account = (name: string, n: number) => {
  const a = JSON.parse(readFileSync(new URL(`accounts/${name}.json`, ROOT), 'utf8')).accounts.find((x: { credNumber: number }) => x.credNumber === n);
  return wallet(a.address, a.key);
};

const grpc = connect();
const registry = new KuasaRegistry(grpc, BigInt(loadState().registry));
const app = express();
const json = (res: express.Response, body: unknown, status = 200) => res.status(status).type('json').send(JSON.stringify(body, bigintJson));

// Signing endpoints hold demo keys: only this console page may call them. The Host check blocks DNS
// rebinding; the custom header forces a CORS preflight that cross-site pages cannot pass.
app.use('/api', (req, res, next) => {
  const hostOk = [`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.get('host') ?? '');
  if (!hostOk || (req.method !== 'GET' && req.get('x-kuasa-console') !== '1')) return json(res, { error: 'forbidden' }, 403);
  next();
});

app.get('/', (_, res) => res.sendFile(fileURLToPath(new URL('console.html', import.meta.url))));

app.get('/api/state', async (_, res) => {
  const s = loadState();
  const mandates = await Promise.all(Object.entries(s.mandates).map(async ([name, m]) => {
    const [entry, doc] = await Promise.all([registry.view(m.owner, m.id), fetch(`${SHOP}/kuasa/mandate/${name}.json`).then((r) => r.json()).catch(() => null)]);
    const coverStatus = await cis8004GetMetadata(grpc, s.agents[name], 'kuasa:cover').catch(() => null);
    return { name, ...m, agentToken: s.agents[name], entry, doc, coverStatus };
  }));
  const shop = await fetch(`${SHOP}/kuasa-log`).then((r) => r.json()).catch(() => null);
  json(res, { registry: `<${s.registry},0>`, agentRegistry: '<12802,0>', explorer: TESTNET.explorer, mandates, shop });
});

/** Kuasa Cover: policies, pool, claims queue, disclosures (from the insurer). */
app.get('/api/cover', async (_req, res) => {
  const r = await insurer('/state').catch(() => null);
  return r?.ok ? res.type('json').send(await r.text()) : json(res, { offline: true });
});

/** The claims handler's decision. Payout happens only through this human action. */
app.post('/api/claims/:id/decision/:verdict', async (req, res) => {
  if (!/^d+$/.test(req.params.id) || !['approve', 'reject'].includes(req.params.verdict)) return json(res, { error: 'bad request' }, 400);
  const r = await insurer(`/claims/${req.params.id}/decision`, { method: 'POST', body: JSON.stringify({ approve: req.params.verdict === 'approve' }) }).catch(() => null);
  return r ? res.status(r.status).type('json').send(await r.text()) : json(res, { error: 'insurer offline' }, 502);
});

app.post('/api/claims/:id/assess', async (req, res) => {
  if (!/^d+$/.test(req.params.id)) return json(res, { error: 'bad request' }, 400);
  const r = await insurer(`/claims/${req.params.id}/assess`, { method: 'POST', body: '{}' }).catch(() => null);
  return r ? res.status(r.status).type('json').send(await r.text()) : json(res, { error: 'insurer offline' }, 502);
});

/** A human approves a drafted lawful-disclosure request before it is anchored on the claim. */
app.post('/api/disclosures/:id/approve', async (req, res) => {
  if (!/^d+$/.test(req.params.id)) return json(res, { error: 'bad request' }, 400);
  const r = await insurer(`/disclosures/${req.params.id}/approve`, { method: 'POST', body: '{}' }).catch(() => null);
  return r ? res.status(r.status).type('json').send(await r.text()) : json(res, { error: 'insurer offline' }, 502);
});

/** Owner publishes the agent's live Kuasa Cover in its CIS-8004 entry (metadata is owner-only). */
app.post('/api/publish-cover/:name', async (req, res) => {
  const s = loadState();
  const m = s.mandates[req.params.name];
  if (!m || !s.cover) return json(res, { error: 'unknown agent or no cover contract' }, 404);
  try {
    const v = await new KuasaCover(grpc, BigInt(s.cover)).coverOf(m.payer);
    if (v.policyId === null) return json(res, { error: 'no live cover for this agent' }, 400);
    const value = `policy=${v.policyId};limit=${v.periodRemaining};cover=${s.cover}.0;at=${Math.floor(Date.now() / 1000)}`;
    const r = await cis8004SetMetadata(grpc, s.agents[req.params.name], 'kuasa:cover', value, account(req.params.name, 0));
    json(res, { tx: r.hash, value });
  } catch (e) { json(res, { error: (e as Error).message }, 500); }
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
