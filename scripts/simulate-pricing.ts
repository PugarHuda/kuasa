/**
 * Monte Carlo check of the Kuasa Cover premium: for the demo profile (wine + groceries agent,
 * 100 EUDemo cover, 30 days) simulate many agent-months and compare expected claims to the premium
 * the risk engine charges. The mistake rates are assumptions, not data: the table shows at which
 * per-order mistake rate the pricing breaks even. Usage: tsx simulate-pricing.ts [agentMonths]
 */
import { assess, quote } from '@kuasa/cover';

const EUR = 1_000_000n;
const N = Number(process.argv[2] ?? 20_000);
const q = quote({ limit: 100n * EUR, days: 30, mandate: { maxPerOrder: 50n * EUR, categories: ['groceries', 'wine', 'insurance'], merchants: ['shop'] }, provenAgeAndResidency: true, ownerKind: 'person', incidents: 0, receipts: 0 });
if ('refused' in q) throw new Error(q.refused);
const premium = Number(q.premium) / 1e6;

// seeded PRNG so the published table is reproducible
let seed = 42;
const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const poisson = (l: number) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rnd(); } while (p > L); return k - 1; };
const ORDERS = [3, 3, 3, 24, 24, 60]; // bread, bread, bread, rioja, rioja, case (EUDemo)

function month(mistakeRate: number) {
  let paid = 0n;
  const orders = poisson(8);
  for (let i = 0; i < orders; i++) {
    if (rnd() >= mistakeRate) continue;
    const amount = BigInt(ORDERS[Math.floor(rnd() * ORDERS.length)]) * EUR;
    // a duplicate order: two receipts, same amount, 30 s apart; assessed by the real assessor
    const a = assess({
      claim: { kind: 'AgentMistake', amount, orders: ['a', 'b'] },
      policy: { validFromMs: 0, validUntilMs: 30 * 86_400_000, limit: 100n * EUR, paidOut: paid, deductible: EUR, mandateId: 'm', owner: 'o' },
      receipts: [{ order: 'a', amount, at: 1000, mandateId: 'm', owner: 'o', paymentTx: 'x' }, { order: 'b', amount, at: 31_000, mandateId: 'm', owner: 'o', paymentTx: 'y' }],
      priorPaidOrders: [], incidentFiled: false,
    });
    if (a.ok) paid += a.payout;
  }
  return Number(paid) / 1e6;
}

console.log(`premium ${premium} EUDemo per agent-month (100 EUDemo cover), ${N} simulated agent-months, ~8 orders/month\n`);
console.log('mistake rate per order | expected claims | loss ratio | p99 month');
for (const r of [0.0025, 0.005, 0.01, 0.02, 0.05]) {
  const xs = Array.from({ length: N }, () => month(r)).sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / N;
  console.log(`${(r * 100).toFixed(2).padStart(6)}% | ${mean.toFixed(3).padStart(8)} | ${((mean / premium) * 100).toFixed(0).padStart(5)}% | ${xs[Math.floor(N * 0.99)].toFixed(0)}`);
}
process.exit(0);
