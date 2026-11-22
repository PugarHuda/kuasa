/**
 * One process for a 512 MB host (Render free): restores .kuasa from Postgres, runs the shop (4021) and
 * Kuasa Cover (4023) on localhost, and serves on $PORT:
 *   GET  /health  keep-alive target
 *   POST /try     the live parametric-claim demo (scripts/try.ts), streamed as text
 * Kuasa Re stays registered on kuasa-market but is not run here (memory).
 * ponytail: one run at a time, one per IP per 15 minutes, 24 a day: each run spends testnet EUDemo.
 */
import { createServer } from 'node:http';
import { restore, startSync } from './state-sync.js';

const PUBLIC_PORT = Number(process.env.PORT ?? 10000);
const ORIGINS = (process.env.KUASA_TRY_ORIGINS ?? 'https://kuasa-explorer.vercel.app').split(',');

if (process.env.DATABASE_URL && !(await restore())) throw new Error('no saved .kuasa in the database: seed it with state-sync.ts --push');
process.env.HOST = '127.0.0.1';
process.env.PORT = '4021';
await import('../packages/shop/src/server.ts');
process.env.PORT = '4023';
await import('../packages/insurer/src/server.ts');
if (process.env.DATABASE_URL) startSync();
const { runTry } = await import('./try.js');

let running = false;
const lastByIp = new Map<string, number>();
let day = '', today = 0;
createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  if (ORIGINS.includes(origin)) res.setHeader('access-control-allow-origin', origin);
  if (req.method === 'OPTIONS') { res.setHeader('access-control-allow-methods', 'POST'); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return; }
  if (req.method !== 'POST' || req.url !== '/try') { res.statusCode = 404; res.end('not found'); return; }
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  const now = Date.now();
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; today = 0; }
  const wait = running ? 'a run is in progress, try again in a few minutes'
    : now - (lastByIp.get(ip) ?? 0) < 15 * 60_000 ? 'one run per 15 minutes from the same address'
    : today >= 24 ? 'the daily limit of live runs is reached; the recorded run is on the evidence page' : '';
  if (wait) { res.statusCode = 429; res.end(wait); return; }
  running = true; lastByIp.set(ip, now); today++;
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  try { await runTry((line) => res.write(`${line}\n`)); }
  catch (e) { res.write(`stopped: ${(e as Error).message}\n`); }
  finally { running = false; res.end(); }
}).listen(PUBLIC_PORT, () => console.log(`[render] public on :${PUBLIC_PORT}`));
