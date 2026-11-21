/**
 * Order velocity (Stripe Radar-style), live: the teen agent buys a loaf three times in a row; the
 * insurer's on-chain receipt watcher sees the orders, and the next per-order quote carries the
 * "order velocity" factor (x1.25 per order beyond two in the window, up to x2). Needs shop and insurer.
 */
import { KuasaAgent } from '@kuasa/agent';

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const teen = KuasaAgent.fromDemo('teen');
const BREAD = '/shop/groceries/bread';
const orderQuote = async () => {
  const q = await teen.quote(BREAD);
  const c = await teen.coverQuote(0n, 1, { ref: q.orderRef!, amount: BigInt(q.amount!) });
  return { premium: c.premium, factors: (c as { factors?: { name: string; multiplier: number }[] }).factors?.map((f) => `${f.name} x${f.multiplier}`) ?? c };
};
console.log('1. per-order quote before', show(await orderQuote()));
for (let i = 1; i <= 3; i++) {
  const r = await teen.buy(BREAD) as { ok: boolean; paymentTx?: string; reasons?: string[] };
  console.log(`2.${i} bought bread`, show({ ok: r.ok, paymentTx: r.paymentTx, reasons: r.reasons }));
}
for (let i = 0; i < 30; i++) {
  const q = await orderQuote();
  if (q.factors && Array.isArray(q.factors) && q.factors.some((f) => f.startsWith('order velocity'))) { console.log('3. per-order quote after', show(q)); process.exit(0); }
  await sleep(10_000);
}
console.log('3. no velocity factor yet', show(await orderQuote()));
