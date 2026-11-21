/**
 * Kuasa Cover risk engine: a transparent, rule-based premium. Illustrative rates, not actuarial
 * advice. Every input comes from chain data or a verified proof, read by the insurer service.
 *
 * All arithmetic is integer: multipliers are basis points (10_000 = x1.0), amounts are atomic.
 */

export type RiskInput = {
  /** Cover limit (atomic units of the payment asset). */
  limit: bigint;
  days: number;
  mandate: { maxPerOrder: bigint; categories: string[]; merchants?: string[] };
  /** Age + residency proven in a verified Verify & Access record bound to the agent. */
  provenAgeAndResidency: boolean;
  ownerKind: 'person' | 'business';
  /** Incidents filed against the mandate (on-chain counter). */
  incidents: number;
  /** Receipts recorded under the mandate (on-chain counter). */
  receipts: number;
  /** Claims already paid to this agent across its policies (on-chain, cover contract). */
  paidClaims?: number;
  /** Per-order top-up cover instead of period cover. */
  order?: { amount: bigint };
  /** v3: the agent's operator posted a CCD bond on the cover contract (slashed on proven fraud). */
  bonded?: boolean;
  /** Orders this mandate placed in the insurer's recent on-chain window (order velocity, Radar-style). */
  recentOrders?: number;
};

export type Factor = { name: string; multiplier: number; reason: string };
export type Quote = { premium: bigint; factors: Factor[] };

const BPS = 10_000n;
const BASE_BPS_PER_30_DAYS = 200n; // 2% of the limit
const CATEGORY_BPS = new Map<string, bigint>([['groceries', 10_000n], ['insurance', 10_000n], ['wine', 12_000n], ['vape', 14_000n]]);
const TOP_UP_BPS = 150n; // 1.5% of the order
const TOP_UP_MIN = 100_000n; // 0.10 in a 6-decimal asset

export function quote(input: RiskInput): Quote | { refused: string } {
  if (input.order) {
    if (input.order.amount <= 0n) return { refused: 'order amount must be positive' };
    const pct = (input.order.amount * TOP_UP_BPS) / BPS;
    const base = pct > TOP_UP_MIN ? pct : TOP_UP_MIN;
    const factors: Factor[] = [{ name: 'order top-up', multiplier: 1, reason: '1.5% of the order, minimum 0.10' }];
    // Per-order risk scoring: an agent buying fast (a loop, an injection) is riskier per order.
    const n = input.recentOrders ?? 0;
    if (n >= 3) {
      const v = BPS + 2_500n * BigInt(n - 2) > 20_000n ? 20_000n : BPS + 2_500n * BigInt(n - 2);
      factors.push({ name: 'order velocity', multiplier: Number(v) / 10_000, reason: `${n} orders on this mandate in the last minutes` });
      return { premium: (base * v + BPS / 2n) / BPS, factors };
    }
    return { premium: base, factors };
  }
  if (input.limit <= 0n) return { refused: 'limit must be positive' };
  if (!Number.isInteger(input.days) || input.days <= 0 || input.days > 365) return { refused: 'days must be 1..365' };

  const unknown = input.mandate.categories.find((c) => !CATEGORY_BPS.has(c));
  if (unknown !== undefined) return { refused: `unknown category: ${unknown}` };

  const applied: { name: string; bps: bigint; reason: string }[] = [];
  applied.push({ name: 'base', bps: BPS, reason: '2% of the limit per 30 days' });

  // tightness = maxPerOrder / limit, compared in integers (x4 <= limit means <= 0.25)
  const tight = input.mandate.maxPerOrder * 4n <= input.limit ? 8_000n : input.mandate.maxPerOrder * 2n <= input.limit ? 9_000n : BPS;
  applied.push({ name: 'mandate tightness', bps: tight, reason: 'smaller per-order limit relative to cover limits single-order losses' });

  if (input.mandate.merchants?.length) applied.push({ name: 'merchant allowlist', bps: 9_000n, reason: 'agent may only pay listed merchants' });

  const cat = input.mandate.categories.reduce((m, c) => (CATEGORY_BPS.get(c)! > m ? CATEGORY_BPS.get(c)! : m), BPS);
  applied.push({ name: 'category', bps: cat, reason: `riskiest category in mandate: ${input.mandate.categories.join(', ')}` });

  if (input.provenAgeAndResidency) applied.push({ name: 'proven attributes', bps: 9_000n, reason: 'owner proved age and residency with a ZK proof bound to the agent' });
  if (input.bonded) applied.push({ name: 'operator bond', bps: 9_000n, reason: 'the agent operator bonded the agent with CCD, slashed on proven fraud' });
  if (input.ownerKind === 'business') applied.push({ name: 'business owner', bps: 8_500n, reason: 'LEI-verified business principal' });
  if (input.incidents > 0) applied.push({ name: 'incidents', bps: BPS + 2_500n * BigInt(input.incidents), reason: `${input.incidents} incident(s) on the mandate` });
  const paid = input.paidClaims ?? 0;
  if (paid > 0) {
    const c = BPS + 2_000n * BigInt(paid);
    applied.push({ name: 'claims history', bps: c > 20_000n ? 20_000n : c, reason: `${paid} paid claim(s) on this agent (experience rating)` });
  }
  const steps = BigInt(Math.floor(input.receipts / 5));
  if (steps > 0n && paid === 0) {
    const h = BPS - 500n * steps;
    applied.push({ name: 'claim-free history', bps: h < 7_000n ? 7_000n : h, reason: `${input.receipts} receipts without claims` });
  }

  let num = input.limit * BASE_BPS_PER_30_DAYS * BigInt(input.days);
  let den = BPS * 30n;
  for (const f of applied) {
    num *= f.bps;
    den *= BPS;
  }
  const premium = (num * 2n + den) / (den * 2n); // round half up
  return { premium, factors: applied.map((f) => ({ name: f.name, multiplier: Number(f.bps) / 10_000, reason: f.reason })) };
}
