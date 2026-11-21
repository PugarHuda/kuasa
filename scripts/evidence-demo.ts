/**
 * Evidence-based claims and the insurer's circuit breaker, live on testnet:
 *   0. Alice's agent is insured under her AP2 Intent Mandate ("bread for the week": SKU bread only).
 *   1. WI10 wrong item: the warehouse mis-picks a bread order. The agent files with the shop's signed
 *      delivery note (signed by the account that recorded the receipt on-chain). A human decides.
 *   2. AM20 outside the intent: a prompt-injected agent buys Rioja, inside the Kuasa mandate but not
 *      in the user's intent. Filed with the delivery note; a human decides (the goods were delivered).
 *   3. AM10 parametric: the agent pays twice for bread. The insurer spots the pair on-chain, pauses the
 *      agent at every guard (the next purchase is refused), the agent files the detection in one call,
 *      it is paid automatically after the objection window, and the owner resumes the agent.
 * Needs shop (4021), insurer (4023) and console (4022) running.
 * Usage: tsx evidence-demo.ts [--steps=policy,wi10,am20,am10]
 */
import { readFileSync } from 'node:fs';
import { KuasaAgent } from '@kuasa/agent';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { connect, KuasaCover, wallet } from '@kuasa/chain';
import { signAp2Intent } from '@kuasa/merchant';
import { loadProfile } from './lib/identity.js';

const SHOP = process.env.KUASA_SHOP_URL ?? 'http://localhost:4021';
const INSURER = process.env.KUASA_INSURER_URL ?? 'http://localhost:4023';
const CONSOLE = process.env.KUASA_CONSOLE_URL ?? 'http://localhost:4022';
const EUR = 1_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const alice = KuasaAgent.fromDemo('alice');
const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { cover: string; mandates: Record<string, { payer: string }> };
const payer = st.mandates.alice.payer;
const paid = (r: { ok: boolean; paymentTx?: string; reasons?: string[] }) => { if (!r.ok || !r.paymentTx) throw new Error(`purchase refused: ${show(r)}`); return r.paymentTx; };

const steps = process.argv.find((a) => a.startsWith('--steps='))?.slice(8).split(',') ?? ['policy', 'wi10', 'am20', 'am10'];
let wi: { claimId?: string; assessment?: unknown } = {};
let am20: { claimId?: string; assessment?: unknown } = {};

if (steps.includes('policy')) {
  // 0. one live period policy per agent: cancel the current one (refunded pro rata), insure under the AP2 intent
  const cover = new KuasaCover(connect(), BigInt(st.cover));
  const live = (await cover.coverOf(payer)).policyId;
  const owner = loadProfile('alice').accounts.find((a) => a.credNumber === 0)!;
  if (live !== null) {
    console.log('0. cancelled policy', String(live), (await cover.cancelPolicy(live, wallet(owner.address, owner.key))).hash);
  }
  // the user (mandate principal) authorises the intent with their own account key
  const ap2 = await signAp2Intent({ user_cart_confirmation_required: false, natural_language_description: 'Bread for the week', merchants: ['Kuasa demo shop', 'Kuasa Cover'], skus: ['/shop/groceries/bread'], intent_expiry: '2027-01-31T00:00:00Z' }, owner.address, buildBasicAccountSigner(owner.key));
  console.log('   insured under the AP2 intent:', show(await alice.coverBuy(50n * EUR, 30, ap2)));
  for (let i = 0; i < 30 && (await cover.coverOf(payer)).policyId === live; i++) await sleep(3000);
}

// 1. WI10: the warehouse packs mint e-liquid for a bread order
if (steps.includes('wi10')) {
await fetch(`${SHOP}/demo/mispick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: '/shop/groceries/bread', ship: '/shop/vape/mint' }) });
const bread = paid(await alice.buy('/shop/groceries/bread') as never);
console.log('1. bread ordered (mis-picked)', bread);
await alice.receiptOf(bread);
console.log('   delivery note', show((await alice.deliveryNote(bread)).note));
wi = await alice.fileClaim('WrongItem', [bread], 3n * EUR, 'received mint e-liquid instead of bread', undefined, 'WI10') as { claimId?: string; assessment?: unknown };
console.log('   WI10 claim', wi.claimId, show(wi.assessment));
}

// 2. AM20: a page the agent read told it to buy wine; the user only intended bread
if (steps.includes('am20')) {
const wine = paid(await alice.buy('/shop/wine/rioja') as never);
console.log('2. Rioja bought after a prompt injection', wine);
await alice.receiptOf(wine);
am20 = await alice.fileClaim('AgentMistake', [wine], 24n * EUR, 'a product page instructed the agent to add wine; the user asked for bread only', undefined, 'AM20') as { claimId?: string; assessment?: unknown };
console.log('   AM20 claim', am20.claimId, show(am20.assessment));
}

// 3. AM10 parametric: duplicate bread, nobody files anything by hand
if (steps.includes('am10')) {
const two = await alice.buyTwice('/shop/groceries/bread');
console.log('3. bread paid twice', show([two.first, two.second].map((x) => (x as { paymentTx?: string }).paymentTx)));
let det = await alice.detections();
// the hold is in force once its CIS-8004 write has finalized (that is what merchants read)
for (let i = 0; i < 40 && !(det.detections.some((d) => d.status === 'open') && (det.hold as { published?: boolean } | null)?.published); i++) { await sleep(5000); det = await alice.detections(); }
console.log('   insurer detected it on-chain:', show(det));
const refused = await alice.buy('/shop/groceries/bread') as { ok: boolean; reasons?: string[] };
console.log('   next purchase while paused:', show(refused));
const filed = await alice.claimDetected();
console.log('   agent filed the detection:', show(filed));
const claimId = (filed[0] as { claimId?: string })?.claimId;

for (let i = 0; i < 60; i++) {
  const s = await (await fetch(`${INSURER}/state`, { headers: { 'x-kuasa-console': '1' } })).json() as { claims: { claimId: string; paid?: string; autoApproveTx?: string }[] };
  const c = s.claims.find((x) => String(x.claimId) === String(claimId));
  if (c?.paid) { console.log('   paid automatically after the objection window', c.paid, 'autoApprove', c.autoApproveTx); break; }
  await sleep(10_000);
}
console.log('   owner resumes the agent:', show(await (await fetch(`${CONSOLE}/api/resume/alice`, { method: 'POST', headers: { 'x-kuasa-console': '1' } })).json()));
for (let i = 0; i < 12; i++) {
  const r = await alice.buy('/shop/groceries/bread') as { ok: boolean; paymentTx?: string; reasons?: string[] };
  if (r.ok) { console.log('   purchases work again', r.paymentTx); break; }
  await sleep(5000);
}
}
console.log(`claims for a human in the console: WI10 #${wi.claimId}, AM20 #${am20.claimId}`);
