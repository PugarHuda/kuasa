/**
 * Premium giveback (Lemonade style), live: Carol's agent buys 7 days of period cover (10 EUDemo) and makes
 * no claim. When the policy ends, the insurer returns 10% of the premium to the payer (and the outcome
 * counts as claim-free reputation). Run once to buy; the insurer pays the giveback itself after expiry.
 * Usage: tsx giveback-demo.ts. Needs shop (4021) and Kuasa Cover (4023).
 */
import { KuasaAgent } from '@kuasa/agent';

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const carol = KuasaAgent.fromDemo('carol');
const r = await carol.coverBuy(10_000_000n, 7) as { ok: boolean; premium?: string; policy?: { policyId: string; until: number }; paymentTx?: string; reasons?: string[] };
console.log('7-day cover for Carol\'s agent:', show({ ok: r.ok, premium: r.premium, policy: r.policy?.policyId, until: r.policy ? new Date(r.policy.until).toISOString() : undefined, paymentTx: r.paymentTx, reasons: r.reasons }));
setTimeout(() => process.exit(0), 100);
