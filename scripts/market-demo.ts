/**
 * The Kuasa insurance market, live: two insurers (Kuasa Cover <13105,0> and Kuasa Re <13108,0>, each its
 * own instance of the same kuasa-cover v3 module, own operator, own pool, own price) quote the same
 * cover for the teen agent; the agent buys from the cheaper one; the shop counts cover from either.
 * The teen's mandate names both insurers' pools (the owner decides who the agent may pay).
 * Usage: tsx market-demo.ts. Needs shop (4021), Kuasa Cover (4023) and Kuasa Re (4024) running.
 */
import { readFileSync } from 'node:fs';
import { KuasaAgent } from '@kuasa/agent';
import { connect, KuasaCover } from '@kuasa/chain';

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { cover: string; market: { name: string; cover: string }[]; mandates: Record<string, { payer: string }> };
const { agent: teen } = await KuasaAgent.fromDemoMarket('teen'); // insurers from the on-chain market directory
const payer = st.mandates.teen.payer;
const LIMIT = 20_000_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// one public node serves both insurers: retry while no insurer could quote (nothing is paid in that case)
type Bought = Awaited<ReturnType<typeof teen.coverBuyBest>>;
const attempt = () => teen.coverBuyBest(LIMIT, 30).catch((e) => ({ ok: false as const, reasons: [(e as Error).message], offers: [] }) as Bought);
let bought = await attempt();
for (let i = 0; i < 6 && !bought.ok && !(bought as { paymentTx?: string }).paymentTx; i++) { await sleep(20_000); bought = await attempt(); }
console.log('1. quotes for 20 EUDemo, 30 days:');
for (const o of bought.offers) console.log(`   ${o.at}: ${o.quote.refused ?? `${o.quote.premium} (${(o.quote as { factors?: { name: string; multiplier: number }[] }).factors?.map((f) => `${f.name} x${f.multiplier}`).join(', ')})`}`);
console.log('2. bought from the cheapest:', show({ ok: bought.ok, insurer: (bought as { insurer?: string }).insurer, premium: (bought as { premium?: string }).premium, policy: (bought as { policy?: unknown }).policy, paymentTx: (bought as { paymentTx?: string }).paymentTx, reasons: (bought as { reasons?: string[] }).reasons }));

const grpc = connect();
const views = await Promise.all([st.cover, ...st.market.map((m) => m.cover)].map(async (c) => ({ cover: `<${c},0>`, view: await new KuasaCover(grpc, BigInt(c)).coverOf(payer) })));
console.log('3. the teen agent on each insurer (the shop adds period cover up):', show(views));
process.exit(0);
