/**
 * Usage: tsx src/cli.ts <alice|teen> <command> [args]   (amounts in whole EUDemo)
 *   catalog | mandate | quote <path> | buy <path> | rogue-buy <path> | buy-twice <path>
 *   cover-quote <limit> [days] | cover-buy <limit> [days] | cover-status | buy-covered <path>
 *   claim <AgentMistake|WrongItem|MerchantLoss> <amount> <paymentTx...>
 */
import type { ClaimKind } from '@kuasa/core';
import { KuasaAgent } from './client.js';

const [name = 'alice', cmd = 'catalog', ...args] = process.argv.slice(2);
const agent = KuasaAgent.fromDemo(name);
const eur = (s: string | undefined) => BigInt(Math.round(Number(s ?? 0) * 1e6));

const run: Record<string, () => Promise<unknown>> = {
  catalog: () => agent.catalog(),
  mandate: () => agent.mandate(),
  quote: () => agent.quote(args[0]),
  buy: () => agent.buy(args[0]),
  'rogue-buy': () => agent.buy(args[0], true),
  'buy-twice': () => agent.buyTwice(args[0]),
  'buy-covered': () => agent.buyCovered(args[0]),
  'cover-quote': () => agent.coverQuote(eur(args[0]), Number(args[1] ?? 30)),
  'cover-buy': () => agent.coverBuy(eur(args[0]), Number(args[1] ?? 30)),
  'cover-status': () => agent.coverStatus(),
  claim: () => agent.fileClaim(args[0] as ClaimKind, args.slice(2), eur(args[1])),
};
if (!run[cmd]) {
  console.error(`unknown command ${cmd}; one of ${Object.keys(run).join(', ')}`);
  process.exit(2);
}
console.log(JSON.stringify(await run[cmd](), (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
process.exit(0);
