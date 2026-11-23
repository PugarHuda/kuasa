/**
 * One process for a 512 MB host (Render free): restores .kuasa from Postgres, runs the shop (4021) and
 * Kuasa Cover (4023) on localhost, and serves on $PORT:
 *   GET  /health  keep-alive target
 *   POST /try     the live parametric-claim demo (scripts/try.ts), streamed as text
 *   POST /mcp     the Kuasa MCP server over HTTP, as Bob's agent: point any MCP client (Claude) at it
 *   GET  /stats   live numbers: both insurers' pool and exposure (read from chain), live runs today, uptime
 *   POST /vp/request, /vp/verify   Verify & Access V1 with the visitor's own Concordium wallet (wallet.html)
 *   POST /owner/*  owner actions signed in the visitor's wallet, sponsored by Kuasa (owner.html)
 *   GET  /audit-record?payer=  one agent's audit record (policies, claims, decisions, transactions)
 * Kuasa Re (4024) runs in the same process too: its server module is loaded a second time under another
 * URL with its own configuration (only server.ts reads the environment; libraries are shared).
 * ponytail: one run at a time, one per IP per 15 minutes, 36 a day: each run spends testnet EUDemo.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as sdk from '@concordium/web-sdk';
import { connect } from '@kuasa/chain';
import { restore, startSync } from './state-sync.js';

const PUBLIC_PORT = Number(process.env.PORT ?? 10000);
const ORIGINS = (process.env.KUASA_TRY_ORIGINS ?? 'https://kuasa-explorer.vercel.app').split(',');

if (process.env.DATABASE_URL && !(await restore())) throw new Error('no saved .kuasa in the database: seed it with state-sync.ts --push');
process.env.HOST = '127.0.0.1';
process.env.PORT = '4021';
await import('../packages/shop/src/server.ts');
process.env.PORT = '4023';
await import('../packages/insurer/src/server.ts');
// Kuasa Re: the same module under another URL, so its top level runs again with Re's settings
delete process.env.KUASA_JURORS;
Object.assign(process.env, { PORT: '4024', KUASA_PROFILE: 'insurer2', KUASA_COVER_INDEX: '13108', KUASA_STATE_FILE: 'insurer2-state.json', KUASA_CAPITAL_FILE: 'capital2.json', KUASA_INSURER_URL: 'http://localhost:4024', KUASA_PRICE_BPS: '8500', KUASA_WATCH_MS: '30000' });
await import(new URL('../packages/insurer/src/server.ts?insurer=re', import.meta.url).href);
if (process.env.DATABASE_URL) startSync();
const { runTry } = await import('./try.js');
// bring your own agent: Claude (or any MCP client) drives Bob's insured agent against the hosted shop and insurers
const { KuasaAgent } = await import('../packages/agent/src/client.ts');
const { serveHttp } = await import('../packages/agent/src/mcp-server.ts');
const bobAgent = KuasaAgent.fromDemo('bob', 'http://localhost:4021', 'http://localhost:4023');
const SPEND_DAILY = 40; // purchases, premiums and claims through /mcp per day (the mandate caps the budget too)
let spendDay = '', spent = 0;
const spend = (tool: string) => {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== spendDay) { spendDay = d; spent = 0; }
  if (spent >= SPEND_DAILY) return `today's ${SPEND_DAILY} paid actions on the hosted demo are used up (${tool} refused); read-only tools still work`;
  spent++;
  return null;
};

const DAILY = 36;
// wallet proofs: each request and each audit anchor is a testnet transaction from the verifier, so cap them
const { anchorWalletRequest, checkWalletPresentation } = await import('./lib/wallet-vp.js');
const VP_DAILY = 30;
const { prepareOwnerTx, agentsOf, getTestEudemo, preparePremium, issueOwnerCover } = await import('./lib/owner-tx.js');
const eudemoGiven = new Set<string>();
const OWNER_DAILY = 60;
let ownerDay = '', ownerToday = 0;
const ownerLastByIp = new Map<string, number>();
let vpDay = '', vpToday = 0;
const vpRequests = new Map<string, { at: number; request: unknown; account: string; tries: number }>(); // random session -> request, 30 min
const vpLastByIp = new Map<string, number>();
/**
 * The visitor's address. Render sits behind Cloudflare: X-Forwarded-For is "client, cf-edge, render-lb", so
 * its last entry is an internal balancer that changes per request (useless as a key), and its first entry
 * can be forged. Cloudflare overwrites CF-Connecting-IP with the address it saw, so that is the key.
 */
function clientIp(req: import('node:http').IncomingMessage) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').map((x) => x.trim()).at(-3) ?? 'unknown';
}
async function readJson(req: import('node:http').IncomingMessage, max: number): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > max) return null; chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
/** The demo agent's EUDemo balance, read from the chain at most once a minute. */
let balance = { at: 0, eudemo: 0 };
async function agentBalance() {
  if (Date.now() - balance.at < 60_000) return balance.eudemo;
  const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { mandates: Record<string, { payer: string }> };
  const info = await connect().getAccountInfo(sdk.AccountAddress.fromBase58(st.mandates.alice.payer));
  const t = (info as unknown as { accountTokens?: { id: unknown; state: { balance: { value: bigint | string } } }[] }).accountTokens?.find((x) => String(x.id) === 'EUDemo');
  balance = { at: Date.now(), eudemo: Number(BigInt(t?.state.balance.value ?? 0)) / 1e6 };
  return balance.eudemo;
}
let running = false;
const lastByIp = new Map<string, number>();
let day = '', today = 0;
createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  if (ORIGINS.includes(origin)) res.setHeader('access-control-allow-origin', origin);
  if (req.method === 'OPTIONS') { res.setHeader('access-control-allow-methods', 'POST'); res.setHeader('access-control-allow-headers', 'content-type'); res.end(); return; }
  if (req.method === 'POST' && (req.url === '/owner/prepare' || req.url === '/owner/agents' || req.url === '/owner/status' || req.url === '/owner/eudemo' || req.url === '/owner/cover')) {
    // owner actions signed in the owner's wallet; Kuasa sponsors the fee (each is a testnet transaction, so capped)
    res.setHeader('content-type', 'application/json');
    const fail = (code: number, error: string) => { res.statusCode = code; res.end(JSON.stringify({ error })); };
    if (!ORIGINS.includes(origin)) return fail(403, 'owner actions start from https://kuasa-explorer.vercel.app/owner.html');
    const body = await readJson(req, 60_000);
    if (!body || typeof body.account !== 'string') return fail(400, 'account (base58) required');
    try {
      if (req.url === '/owner/agents') { res.end(JSON.stringify({ agents: await agentsOf(body.account) })); return; }
      if (req.url === '/owner/status') {
        if (typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash)) return fail(400, 'hash: 64 hex characters');
        const s = await connect().getBlockItemStatus(sdk.TransactionHash.fromHexString(body.hash));
        const sum = s.status === 'finalized' ? (s.outcome.summary as unknown as Record<string, unknown>) : null;
        res.end(JSON.stringify({ status: s.status, rejected: !!sum && (sum.transactionType === 'failed' || 'rejectReason' in sum) }));
        return;
      }
      const d = new Date().toISOString().slice(0, 10);
      if (d !== ownerDay) { ownerDay = d; ownerToday = 0; }
      if (ownerToday >= OWNER_DAILY) return fail(429, `today's ${OWNER_DAILY} sponsored owner actions on the hosted demo are used up`);
      const ip = clientIp(req);
      if (Date.now() - (ownerLastByIp.get(ip) ?? 0) < 15_000) return fail(429, 'one owner action per 15 seconds from the same address');
      ownerLastByIp.set(ip, Date.now()); if (ownerLastByIp.size > 5000) ownerLastByIp.clear();
      ownerToday++;
      if (req.url === '/owner/eudemo') {
        if (eudemoGiven.has(body.account)) return fail(429, 'this account already received test EUDemo from the hosted demo');
        if (typeof body.presentation !== 'string') return fail(400, 'presentation: the EU-nationality proof from the wallet (JSON string)');
        const r = await getTestEudemo(connect(), body.account, body.presentation);
        eudemoGiven.add(body.account);
        res.end(JSON.stringify(r)); return;
      }
      if (req.url === '/owner/cover') {
        res.end(JSON.stringify(await issueOwnerCover(connect(), body.account, String(body.mandateId), String(body.agentToken), String(body.premiumTx)))); return;
      }
      if (body.action === 'premium') { res.end(JSON.stringify(await preparePremium(connect(), body.account, String(body.mandateId)))); return; }
      res.end(JSON.stringify(await prepareOwnerTx(connect(), body.account, String(body.action), { agentToken: typeof body.agentToken === 'string' ? body.agentToken : undefined, mandateId: typeof body.mandateId === 'string' ? body.mandateId : undefined })));
    } catch (e) { fail(400, (e as Error).message.slice(0, 300)); }
    return;
  }
  if (req.method === 'POST' && (req.url === '/vp/request' || req.url === '/vp/verify')) {
    res.setHeader('content-type', 'application/json');
    const fail = (code: number, error: string) => { res.statusCode = code; res.end(JSON.stringify({ error })); };
    const body = await readJson(req, 200_000);
    if (!body) return fail(400, 'bad or oversized JSON');
    const grpc = connect();
    try {
      if (req.url === '/vp/request') {
        const d = new Date().toISOString().slice(0, 10);
        if (d !== vpDay) { vpDay = d; vpToday = 0; }
        if (!ORIGINS.includes(origin)) return fail(403, 'wallet proofs start from https://kuasa-explorer.vercel.app/wallet.html');
        const ip = clientIp(req);
        if (Date.now() - (vpLastByIp.get(ip) ?? 0) < 60_000) return fail(429, 'one wallet proof request per minute from the same address');
        if (vpToday >= VP_DAILY) return fail(429, `today's ${VP_DAILY} wallet proofs on the hosted demo are used up`);
        if (typeof body.account !== 'string') return fail(400, 'account (base58) required');
        vpLastByIp.set(ip, Date.now());
        if (vpLastByIp.size > 5000) vpLastByIp.clear();
        vpToday++;
        const agentToken = typeof body.agentToken === 'string' ? body.agentToken : undefined;
        // a proof bound to an agent only for the account that owns it (and it is not revoked) in the Agent Registry
        if (agentToken && !(await agentsOf(body.account)).some((a) => a.tokenHex === agentToken && a.status !== 'Revoked')) return fail(403, 'that agent is not yours in the Agent Registry');
        const r = await anchorWalletRequest(grpc, body.account, agentToken);
        for (const [k, v] of vpRequests) if (Date.now() - v.at > 30 * 60_000) vpRequests.delete(k);
        const session = crypto.randomUUID(); // unguessable: only the page that asked can answer
        vpRequests.set(session, { at: Date.now(), request: r.request, account: body.account, tries: 0 });
        res.end(JSON.stringify({ ...r, session }));
      } else {
        const held = typeof body.session === 'string' ? vpRequests.get(body.session) : undefined;
        if (!held) return fail(404, 'unknown or expired request: ask for a new one');
        // claim the session before any async work: concurrent answers cannot both anchor an audit record
        vpRequests.delete(body.session as string);
        const r = await checkWalletPresentation(grpc, held.request, body.presentation, held.account).catch((e) => ({ verified: false as const, error: (e as Error).message.slice(0, 300) }));
        if (!r.verified && ++held.tries < 3) vpRequests.set(body.session as string, held); // a failed answer may retry, 3 times
        res.end(JSON.stringify(r));
      }
    } catch (e) { fail(400, (e as Error).message.slice(0, 300)); }
    return;
  }
  if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return; }
  if (req.method === 'GET' && req.url === '/stats') {
    // public, read-only: what the hosted insurers hold and owe right now, from their own solvency views
    const get = (u: string) => fetch(u, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json()).catch(() => null);
    const [kuasaCover, kuasaRe] = await Promise.all([get('http://localhost:4023/solvency'), get('http://localhost:4024/solvency')]);
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');
    res.end(JSON.stringify({ at: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()), liveRunsToday: day === new Date().toISOString().slice(0, 10) ? today : 0, paidActionsTodayViaMcp: spendDay === new Date().toISOString().slice(0, 10) ? spent : 0, insurers: { kuasaCover, kuasaRe } }, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/audit-record?')) {
    // public, read-only: one agent's audit record from Kuasa Cover (policies, claims, decisions, transactions)
    const q = new URL(req.url, 'http://x').searchParams.get('payer') ?? '';
    const r = await fetch(`http://localhost:4023/audit-record?payer=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    res.statusCode = r?.status ?? 502;
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');
    res.end(r ? await r.text() : JSON.stringify({ error: 'insurer unavailable' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/status') {
    const eudemo = await agentBalance().catch(() => null);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ running, runsLeftToday: Math.max(0, DAILY - (day === new Date().toISOString().slice(0, 10) ? today : 0)), agentEUDemo: eudemo }));
    return;
  }
  if (req.url === '/mcp') {
    if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end('stateless MCP: POST only'); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > 64_000) { res.statusCode = 413; res.end('too large'); return; } chunks.push(c as Buffer); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.statusCode = 400; res.end('bad json'); return; }
    await serveHttp(bobAgent, spend, req, res, body).catch((e) => { if (!res.headersSent) { res.statusCode = 500; res.end((e as Error).message); } });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/try') { res.statusCode = 404; res.end('not found'); return; }
  const ip = clientIp(req);
  const now = Date.now();
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; today = 0; }
  const wait = running ? 'a run is in progress, try again in a few minutes'
    : now - (lastByIp.get(ip) ?? 0) < 15 * 60_000 ? 'one run per 15 minutes from the same address'
    : today >= DAILY ? "today's live runs are used up (each one spends testnet EUDemo). The same flow, recorded on-chain: https://kuasa-explorer.vercel.app/evidence.html" : '';
  if (wait) { res.statusCode = 429; res.end(wait); return; }
  running = true; lastByIp.set(ip, now); today++;
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  try { await runTry((line) => res.write(`${line}\n`)); }
  catch (e) { res.write(`stopped: ${(e as Error).message}\n`); }
  finally { running = false; res.end(); }
}).listen(PUBLIC_PORT, () => console.log(`[render] public on :${PUBLIC_PORT}`));
