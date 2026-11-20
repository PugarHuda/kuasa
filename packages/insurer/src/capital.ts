/**
 * Capital providers (the mutual / Nexus pattern): anyone can put EUDemo into the pool and share its
 * result. Premiums and claim payouts are split pro rata to each provider's balance at that moment.
 * Capital backs live cover, so a withdrawal is refused if the pool would no longer cover every live
 * limit (pool - amount < exposure). Integer arithmetic; rounding remainders go to the largest balance.
 */
type Account = { provider: string; deposited: bigint; premiums: bigint; losses: bigint; withdrawn: bigint; lots?: { amount: bigint; at: number }[] };

/** A capital deposit is an EUDemo transfer into the pool whose memo is the CBOR text "kuasa capital". */
export function isCapitalMemo(hex: string | undefined) {
  if (!hex || !/^[0-9a-f]*$/i.test(hex)) return false;
  const b = Buffer.from(hex, 'hex');
  const [len, start] = b[0] >= 0x60 && b[0] <= 0x77 ? [b[0] - 0x60, 1] : b[0] === 0x78 ? [b[1], 2] : [-1, 0];
  return len >= 0 && b.length === start + len && b.subarray(start).toString('utf8') === 'kuasa capital';
}
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

  /** A verified transfer into the pool (each transaction counts once). */
  deposit(provider: string, amount: bigint, tx: string, at = 0) {
    if (this.txs.has(tx)) throw new Error('deposit already recorded');
    if (amount <= 0n) throw new Error('deposit must be positive');
    this.txs.add(tx);
    const a = this.accounts.get(provider) ?? { provider, deposited: 0n, premiums: 0n, losses: 0n, withdrawn: 0n };
    a.deposited += amount;
    a.lots = [...(a.lots ?? []), { amount, at }];
    this.accounts.set(provider, a);
  }

  private split(amount: bigint, field: 'premiums' | 'losses') {
    const live = [...this.accounts.values()].filter((a) => balanceOf(a) > 0n);
    const total = live.reduce((s, a) => s + balanceOf(a), 0n);
    if (total === 0n || amount === 0n) return;
    let given = 0n;
    const shares = live.map((a) => { const x = (amount * balanceOf(a)) / total; given += x; return [a, x] as const; });
    for (const [a, x] of shares) a[field] += x;
    const largest = live.reduce((m, a) => (balanceOf(a) > balanceOf(m) ? a : m));
    largest[field] += amount - given; // rounding remainder
  }

  onPremium(amount: bigint) { this.split(amount, 'premiums'); }
  onPayout(amount: bigint) { this.split(amount, 'losses'); }

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
