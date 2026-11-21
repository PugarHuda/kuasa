/**
 * Owner rules (Stripe Radar rules, for agents), live: Bob, the holder of a policy on his agent, signs a
 * rule with the insurer: pause the agent above 5 EUDemo of spend in an hour. The agent buys a 24 EUDemo
 * bottle; the insurer's block watcher sees the receipt and pauses it through the circuit breaker every
 * shop honours; the next purchase is refused; Bob resumes the agent and removes the rule.
 * Usage: tsx rules-demo.ts. Needs shop (4021), Kuasa Cover (4023), console (4022).
 */
import { readFileSync } from 'node:fs';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { KuasaAgent } from '@kuasa/agent';
import { makePayerProof } from '@kuasa/merchant';
import { loadProfile } from './lib/identity.js';

const INSURER = 'http://localhost:4023';
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { mandates: Record<string, { payer: string }> };
const payer = st.mandates.bob.payer;
const owner = loadProfile('bob').accounts.find((a) => a.credNumber === 0)!;
const rule = async (max: bigint) => (await fetch(`${INSURER}/rules/${payer}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await makePayerProof(owner.address, buildBasicAccountSigner(owner.key), INSURER)) }, body: JSON.stringify({ maxSpendPerHour: String(max) }) })).json();

console.log('1. Bob signs a rule: pause my agent above 5 EUDemo per hour ->', show(await rule(5_000_000n)));
const bob = KuasaAgent.fromDemo('bob');
type Buy = { ok: boolean; paymentTx?: string; reasons?: string[] };
// the x402 facilitator sometimes fails a lookup on a busy node: nothing was paid then, so try again
const buy = async (path: string) => { for (let i = 0; ; i++) { const r = await bob.buy(path) as Buy; if (r.ok || i >= 4 || !/lookup_failed|429|UNAVAILABLE|unavailable/i.test(show(r.reasons))) return r; await sleep(5_000); } };
const wine = await buy('/shop/wine/rioja');
console.log('2. the agent buys a 24 EUDemo bottle ->', show({ ok: wine.ok, paymentTx: wine.paymentTx, reasons: wine.reasons }));
let held: unknown = null;
for (let i = 0; i < 60 && !held; i++) { await sleep(5_000); // the block watcher may lag a busy node held = (await (await fetch(`${INSURER}/detections/${payer}`)).json() as { hold: unknown }).hold; }
console.log('3. the insurer paused the agent ->', show(held));
await sleep(8_000); // the hold is published on the insurer's CIS-8004 entry
const bread = await buy('/shop/groceries/bread');
console.log('4. the next purchase ->', show({ ok: bread.ok, reasons: bread.reasons }));
console.log('5. Bob resumes his agent ->', show(await (await fetch('http://localhost:4022/api/resume/bob', { method: 'POST', headers: { 'x-kuasa-console': '1' } })).json()));
console.log('   and removes the rule ->', show(await rule(0n)));
process.exit(0);
