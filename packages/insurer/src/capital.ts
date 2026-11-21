/**
 * Capital providers (the mutual / Nexus pattern): anyone can put EUDemo into the pool and share its
 * result. Premiums and claim payouts are split pro rata to each provider's balance at that moment.
 * Capital backs live cover, so a withdrawal is refused if the pool would no longer cover every live
 * limit (pool - amount < exposure). Integer arithmetic; rounding remainders go to the largest balance.
 */
/**
 * Risk-specific staking (Nexus Mutual's pattern): a provider may back one risk class, named by the
 * reason-code family of the claims it pays for: AM (agent mistakes), WI (wrong items), ML (merchant
 * loss). Class capital is first loss for its class and earns premiums at 1.5x weight for it.
 */
export type RiskClass = 'AM' | 'WI' | 'ML';
export const RISK_CLASSES: RiskClass[] = ['AM', 'WI', 'ML'];
type Account = { provider: string; deposited: bigint; premiums: bigint; losses: bigint; withdrawn: bigint; lots?: { amount: bigint; at: number }[]; class?: RiskClass };

const memoText = (hex: string | undefined) => {
  if (!hex || !/^[0-9a-f]*$/i.test(hex)) return null;
  const b = Buffer.from(hex, 'hex');
  const [len, start] = b[0] >= 0x60 && b[0] <= 0x77 ? [b[0] - 0x60, 1] : b[0] === 0x78 ? [b[1], 2] : [-1, 0];
  return len >= 0 && b.length === start + len ? b.subarray(start).toString('utf8') : null;
};
/** A capital deposit is an EUDemo transfer into the pool with the memo "kuasa capital" (general) or "kuasa capital:AM|WI|ML". */
export function capitalClassOf(hex: string | undefined): RiskClass | 'general' | null {
  const t = memoText(hex);
  if (t === 'kuasa capital') return 'general';
  const m = t?.match(/^kuasa capital:(AM|WI|ML)$/);
  return m ? (m[1] as RiskClass) : null;
}
export const isCapitalMemo = (hex: string | undefined) => capitalClassOf(hex) !== null;
const balanceOf = (a: Account) => a.deposited + a.premiums - a.losses - a.withdrawn;

export class CapitalLedger {
  private accounts = new Map<string, Account>();
  private txs = new Set<string>();

  constructor(snapshot?: { accounts: Account[]; txs: string[] }) {
    for (const a of snapshot?.accounts ?? []) this.accounts.set(a.provider, { ...a });
    for (const t of snapshot?.txs ?? []) this.txs.add(t);
  }

  snapshot() {
    return { accounts: [...this.accounts.values()].map((a) => ({ ...a })), txs: [...this.txs] };
  }

  /** Marks a transaction as used (e.g. a premium payment) so it can never be booked as capital. */
  reserve(tx: string) { this.txs.add(tx); }

  /** A verified transfer into the pool (each transaction counts once). A provider backs one class (or none) for good. */
  deposit(provider: string, amount: bigint, tx: string, at = 0, cls?: RiskClass) {
    if (this.txs.has(tx)) throw new Error('deposit already recorded');
    if (amount <= 0n) throw new Error('deposit must be positive');
    const prev = this.accounts.get(provider);
    if (prev && prev.class !== cls) throw new Error(`this provider backs ${prev.class ?? 'the general pool'}; use another account for a different class`);
    this.txs.add(tx);
    const a = prev ?? { provider, deposited: 0n, premiums: 0n, losses: 0n, withdrawn: 0n, ...(cls ? { class: cls } : {}) };
    a.deposited += amount;
    a.lots = [...(a.lots ?? []), { amount, at }];
    this.accounts.set(provider, a);
  }

  /** Splits `amount` over `among` by weighted balance; returns what could not be placed (nobody to carry it). */
  private split(amount: bigint, field: 'premiums' | 'losses', among = [...this.accounts.values()], weight = (_a: Account) => 2n) {
    const live = among.filter((a) => balanceOf(a) > 0n);
    const w = (a: Account) => balanceOf(a) * weight(a);
    const total = live.reduce((s, a) => s + w(a), 0n);
    if (total === 0n || amount === 0n) return amount;
    let given = 0n;
    const shares = live.map((a) => { const x = (amount * w(a)) / total; given += x; return [a, x] as const; });
    for (const [a, x] of shares) a[field] += x;
    const largest = live.reduce((m, a) => (w(a) > w(m) ? a : m));
    largest[field] += amount - given; // rounding remainder
    return 0n;
  }

  /** Premiums: pro rata to balance, class capital weighted 1.5x (it carries first loss). */
  onPremium(amount: bigint) { this.split(amount, 'premiums', undefined, (a) => (a.class ? 3n : 2n)); }

  /**
   * A payout. With a class, that class's capital pays first, up to its balance; the rest (and any
   * payout without a class, e.g. refunds) is shared by everyone pro rata.
   */
  onPayout(amount: bigint, cls?: RiskClass) {
    let rest = amount;
    if (cls) {
      const backers = [...this.accounts.values()].filter((a) => a.class === cls && balanceOf(a) > 0n);
      const room = backers.reduce((s, a) => s + balanceOf(a), 0n);
      const first = rest < room ? rest : room;
      if (first > 0n) { this.split(first, 'losses', backers); rest -= first; }
    }
    if (rest > 0n) this.split(rest, 'losses');
  }

  /** lockupMs: capital deposited more recently than this cannot leave (no just-in-time premium capture). */
  withdraw(provider: string, amount: bigint, pool: { pool: bigint; exposure: bigint }, now = Date.now(), lockupMs = 0) {
    const a = this.accounts.get(provider);
    if (!a || amount <= 0n || amount > balanceOf(a)) throw new Error("amount exceeds this provider's balance");
    const locked = (a.lots ?? []).filter((l) => l.at > now - lockupMs).reduce((sum, l) => sum + l.amount, 0n);
    if (amount > balanceOf(a) - locked) throw new Error(`capital deposited in the last ${Math.round(lockupMs / 86_400_000)} days is locked`);
    if (pool.pool - amount < pool.exposure) throw new Error('withdrawal would leave live exposure uncovered');
    a.withdrawn += amount;
  }

  /** The payment for a withdrawal failed: put it back. */
  unwithdraw(provider: string, amount: bigint) {
    const a = this.accounts.get(provider);
    if (a) a.withdrawn -= amount;
  }

  balances() {
    return [...this.accounts.values()].map((a) => ({ ...a, balance: balanceOf(a) }));
  }
}
