/**
 * Operator bond discount, live: the teen agent asks for a period quote, its payer bonds the agent with
 * 10 CCD on kuasa-cover v3 (postBond), and the same quote comes back with the 0.9 "operator bond"
 * factor. Quotes only: nothing is bought. Needs shop and insurer running.
 */
import { readFileSync } from 'node:fs';
import { KuasaAgent } from '@kuasa/agent';
import { connect, KuasaCover, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { cover: string };
const cover = new KuasaCover(connect(), BigInt(st.cover));
const teen = KuasaAgent.fromDemo('teen');
const payer = loadProfile('teen').accounts.find((a) => a.credNumber === 1)!;
const brief = (q: { premium?: string; factors?: { name: string; multiplier: number }[]; refused?: string }) => q.refused ?? { premium: q.premium, factors: q.factors?.map((f) => `${f.name} x${f.multiplier}`) };

const LIMIT = 20_000_000n;
console.log('1. quote before the bond', show(brief(await teen.coverQuote(LIMIT, 30))), 'bond', show(await cover.bondOf(payer.address)));
if (((await cover.bondOf(payer.address))?.amount ?? 0n) < 10_000_000n) {
  const tx = await cover.postBond(payer.address, 10_000_000n, wallet(payer.address, payer.key));
  console.log('2. payer bonded the agent with 10 CCD (postBond)', tx.hash, show(await cover.bondOf(payer.address)));
}
console.log('3. quote after the bond ', show(brief(await teen.coverQuote(LIMIT, 30))));
