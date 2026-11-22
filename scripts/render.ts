/**
 * One process for a 512 MB host (Render free): restores .kuasa from Postgres, runs the shop (4021) and
 * Kuasa Cover (4023) on localhost, and serves on $PORT:
 *   GET  /health  keep-alive target
 *   POST /try     the live parametric-claim demo (scripts/try.ts), streamed as text
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

const DAILY = 36;
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
  if (req.method === 'OPTIONS') { res.setHeader('access-control-allow-methods', 'POST'); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return; }
  if (req.method === 'GET' && req.url === '/status') {
    const eudemo = await agentBalance().catch(() => null);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ running, runsLeftToday: Math.max(0, DAILY - (day === new Date().toISOString().slice(0, 10) ? today : 0)), agentEUDemo: eudemo }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/try') { res.statusCode = 404; res.end('not found'); return; }
  // the last X-Forwarded-For entry is the one Render's proxy appends; earlier ones are client-supplied
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').at(-1)!.trim();
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
