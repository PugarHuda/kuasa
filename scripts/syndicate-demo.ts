/**
 * Syndicated cover, live (Nexus Mutual v2 capacity allocation, Lloyd's following market): Bob's agent
 * needs more period cover than any single insurer can carry. It reads each insurer's free capacity from
 * its public /solvency, fills it cheapest first, and buys one policy per insurer; the shop adds the
 * shares up. Usage: tsx syndicate-demo.ts [limit EUDemo, default 90]. Needs shop, Kuasa Cover, Kuasa Re.
 */
import { readFileSync } from 'node:fs';
import { KuasaAgent } from '@kuasa/agent';
import { connect, KuasaCover } from '@kuasa/chain';

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { cover: string; market: { url: string; cover: string }[]; mandates: Record<string, { payer: string }> };
const LIMIT = BigInt(process.argv[2] ?? '90') * 1_000_000n;
const { agent: bob, market } = await KuasaAgent.fromDemoMarket('bob'); // insurers from the on-chain market directory
for (const at of market.map((m) => m.url)) {
  const s = await (await fetch(`${at}/solvency`)).json() as { pool: string; exposure: string };
  console.log(`1. ${at}: pool ${s.pool}, live limits ${s.exposure}, free ${BigInt(s.pool) - BigInt(s.exposure)}`);
}
const r = await bob.coverBuySyndicated(LIMIT, 30);
console.log(`2. syndicated ${LIMIT} for 30 days:`, show(r));
const grpc = connect();
const views = await Promise.all([st.cover, ...st.market.map((m) => m.cover)].map(async (c) => ({ cover: `<${c},0>`, view: await new KuasaCover(grpc, BigInt(c)).coverOf(st.mandates.bob.payer) })));
console.log('3. Bob\'s agent on each insurer (the shop adds them up):', show(views));
process.exit(0);
