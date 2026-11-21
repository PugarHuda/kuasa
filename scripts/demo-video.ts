/**
 * Demo mode for recording: the strongest flow, step by step, with a headline per step and pauses
 * between them. Every chain call retries a busy node (withRetry), so the run survives HTTP 429s.
 *   1. the market: insurers found on-chain, two quotes compared (nothing bought)
 *   2. portable reputation: Kuasa Re prices Alice from other insurers' ERC-8004 feedback on Ethereum
 *   3. a fully parametric claim: Alice's agent pays twice, the insurer detects it, pauses the agent,
 *      files the claim itself, pays it after the objection window, and posts the outcome to ERC-8004
 * Usage: tsx demo-video.ts [--skip-claim]. Needs shop (4021), Kuasa Cover (4023), Kuasa Re (4024), console (4022).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { KuasaAgent } from '@kuasa/agent';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = async (title: string, line: string) => { console.log(`\n=== ${title} ===\n${line}`); await sleep(1500); };
type Q = { premium?: string; refused?: string; factors?: { name: string; multiplier: number }[] };
const fmt = (q: Q) => q.refused ?? `${Number(q.premium) / 1e6} EUDemo  [${(q.factors ?? []).map((f) => `${f.name} x${f.multiplier}`).join(', ')}]`;

await say('1. The insurance market', 'Bob\'s agent finds insurers on-chain (CIS-8004 directory, each entry owned by its pool) and keeps those its mandate allows.');
const { agent: bob, market } = await KuasaAgent.fromDemoMarket('bob');
for (const m of market) console.log(`   ${m.name}  <${m.cover},0>  pool ${m.pool.slice(0, 8)}…  price x${m.price / 10_000}`);
for (const o of await bob.marketQuotes(5_000_000n, 30)) console.log(`   quote from ${o.at}: ${fmt(o.quote as Q)}`);

await say('2. Portable reputation', 'Kuasa Re never insured Alice, but reads what other insurers reported about her agent on Ethereum\'s ERC-8004 registry.');
const alice = KuasaAgent.fromDemo('alice');
console.log('   Kuasa Re quote for Alice:', fmt(await alice.coverQuote(1_000_000n, 30, undefined, undefined, false, 'http://localhost:4024') as Q));

if (!process.argv.includes('--skip-claim')) {
  await say('3. A fully parametric claim', 'Alice\'s agent pays twice for the same loaf. Nobody files anything: watch the insurer do it.');
  const progress = new URL('../.kuasa/erc8004.json', import.meta.url);
  const before = existsSync(progress) ? Object.keys(JSON.parse(readFileSync(progress, 'utf8')).posted).length : 0;
  spawnSync(process.execPath, ['--import', 'tsx', 'v3-demo.ts', '--steps=parametric'], { stdio: 'inherit', cwd: new URL('.', import.meta.url) });
  await say('   ...and the outcome travels', 'The paid claim is posted to the agent\'s ERC-8004 reputation on Ethereum Sepolia by the insurer, automatically.');
  for (let i = 0; i < 18; i++) {
    const posted = existsSync(progress) ? JSON.parse(readFileSync(progress, 'utf8')).posted as Record<string, { tx: string }> : {};
    const keys = Object.keys(posted);
    if (keys.length > before) { const k = keys.at(-1)!; console.log(`   ${k}: https://sepolia.etherscan.io/tx/${posted[k].tx}`); break; }
    await sleep(10_000);
  }
}
console.log('\nEverything above is on-chain: https://kuasa-explorer.vercel.app (market, claim timeline, premium calculator).');
process.exit(0);
