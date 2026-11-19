import type { Wallet } from '@kuasa/chain';
import { canonicalJson, type Claim, type IssuePolicyParams, type Mandate, type MandateEntry, type Policy, type RegistryEvent, sha256Hex } from '@kuasa/core';
import { assess, type Assessment, quote, type Quote, type RiskInput } from '@kuasa/cover';
import type { IdentitySource } from '@kuasa/merchant';

const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
const QUOTE_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const DEDUCTIBLE = 1_000_000n; // 1.00 in a 6-decimal asset
const FRAUD_THRESHOLD = 2;

type TxResult = { hash: string };

/** Everything the service touches outside itself; injected so it is testable without a chain. */
export type InsurerDeps = {
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Fetches and validates a mandate document; returns it with its id (sha256). */
  loadMandate(url: string): Promise<{ mandate: Mandate; id: string }>;
  mandateEntry(owner: string, id: string): Promise<MandateEntry | null>;
  identity: IdentitySource;
  cover: {
    issuePolicy(p: IssuePolicyParams, operator?: Wallet): Promise<TxResult & { id: bigint | null }>;
    policy(id: bigint): Promise<Policy | null>;
    claim(id: bigint): Promise<Claim | null>;
    assess(claimId: bigint, ok: boolean, reasonHex: string, operator?: Wallet): Promise<TxResult>;
    decide(claimId: bigint, approve: boolean, operator?: Wallet): Promise<TxResult>;
    recordPayout(claimId: bigint, payoutTx: string, amount: bigint, operator?: Wallet): Promise<TxResult>;
    markFraud(claimId: bigint, disclosureHex: string, operator?: Wallet): Promise<TxResult>;
  };
  /** kuasa-registry events of a finalized transaction, with block time. */
  registryEvents(tx: string): Promise<{ at: number; events: RegistryEvent[] } | null>;
  treasuryBalance(): Promise<bigint>;
  /** Pays from the treasury; returns the transaction hash. */
  pay(to: string, amount: bigint, memo: string): Promise<string>;
  /** Stores a lawful-disclosure request document; returns its sha256 (hex). */
  saveDisclosure(doc: object): Promise<string>;
  operator?: Wallet;
  /** Called with a JSON snapshot after every state change (persist it; restore via the constructor). */
  persist?: (snapshot: string) => void;
};

/** JSON with bigints tagged, so a snapshot round-trips exactly. */
const toSnapshot = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x));
const fromSnapshot = (s: string) => JSON.parse(s, (_k, x) => (x && typeof x === 'object' && typeof x.$big === 'string' && Object.keys(x).length === 1 ? BigInt(x.$big) : x));

export type QuoteRequest = { mandateUrl: string; limit: bigint; days: number; order?: { ref: string; amount: bigint } };
export type StoredQuote = Quote & {
  quoteId: string; request: QuoteRequest; mandateId: string; owner: string; payer: string; token: string; expires: number;
};
type ClaimRecord = {
  claimId: bigint; policyId: bigint; holder: string; claimant: string; recipient: string; assessment: Assessment; receiptTxs: string[]; orders: string[];
  paid?: string; amountPaid?: bigint; recordPending?: boolean; decided?: boolean; busy?: Promise<{ decided: true; paid?: string; reason?: string }>;
};
type Disclosure = { claimId: string; account: string; doc: object };

/**
 * Kuasa Cover insurer: prices cover from on-chain facts, issues policies after the premium is
 * paid over x402, assesses claims against on-chain receipts and pays approved claims from the
 * treasury. Every payout needs a human decision (`decide`).
 */
export class InsurerService {
  private quotes = new Map<string, StoredQuote>();
  private policies: { policyId: bigint; quoteId: string; premiumTx: string; holder: string; payer: string; limit: bigint; until: number; kind: string }[] = [];
  /** Premiums that settled but whose policy is not on-chain yet; the quote travels with them. */
  private unissued: { quoteId: string; premiumTx: string; error: string; quote?: StoredQuote }[] = [];
  private claims = new Map<bigint, ClaimRecord>();
  private fraud = new Map<string, number>();
  private pendingDisclosures: Disclosure[] = [];
  private disclosures: { claimId: string; account: string; hash: string }[] = [];
  private payouts: { claimId: string; to: string; amount: bigint; tx: string }[] = [];
  private premiumsIn = 0n;

  constructor(private deps: InsurerDeps, snapshot?: string) {
    if (snapshot) {
      const s = fromSnapshot(snapshot);
      this.policies = s.policies ?? [];
      this.unissued = s.unissued ?? [];
      this.claims = new Map((s.claims ?? []).map((c: ClaimRecord) => [c.claimId, c]));
      this.fraud = new Map(Object.entries(s.fraud ?? {}));
      this.pendingDisclosures = s.pendingDisclosures ?? [];
      this.disclosures = s.disclosures ?? [];
      this.payouts = s.payouts ?? [];
      this.premiumsIn = s.premiumsIn ?? 0n;
    }
  }

  /** Everything except live quotes and in-flight locks. */
  private save() {
    this.deps.persist?.(toSnapshot({
      policies: this.policies, unissued: this.unissued, claims: [...this.claims.values()].map(({ busy, ...r }) => r),
      fraud: Object.fromEntries(this.fraud), pendingDisclosures: this.pendingDisclosures, disclosures: this.disclosures,
      payouts: this.payouts, premiumsIn: this.premiumsIn,
    }));
  }

  private sleep = (ms: number) => (this.deps.sleep ?? ((m) => new Promise((r) => setTimeout(r, m))))(ms);

  /** Prices cover. The quote is held for 10 minutes and must still match at purchase time. */
  async quote(req: QuoteRequest): Promise<StoredQuote | { refused: string }> {
    const fresh = await this.price(req);
    if ('refused' in fresh) return fresh;
    const quoteId = await sha256Hex(canonicalJson({ ...req, limit: String(req.limit), order: req.order && { ...req.order, amount: String(req.order.amount) }, at: this.deps.now(), n: Math.random() }));
    const stored: StoredQuote = { ...fresh, quoteId, request: req, expires: this.deps.now() + QUOTE_TTL_MS };
    this.quotes.set(quoteId, stored);
    return stored;
  }

  private async price(req: QuoteRequest): Promise<Omit<StoredQuote, 'quoteId' | 'request' | 'expires'> | { refused: string }> {
    let m: Mandate, id: string;
    try {
      ({ mandate: m, id } = await this.deps.loadMandate(req.mandateUrl));
    } catch {
      return { refused: 'mandate document unavailable or invalid' };
    }
    const e = await this.deps.mandateEntry(m.principal.account, id);
    if (!e || e.revoked || e.owner !== m.principal.account || e.payer !== m.agent.payer) return { refused: 'mandate not active on-chain' };
    if (Number(e.validUntilMs) < this.deps.now()) return { refused: 'mandate expired' };
    if (req.limit > e.maxTotal) return { refused: 'cover limit exceeds the mandate budget' };
    const proof = await this.deps.identity.claims(m, id);
    const proven = proof.ok && (proof.claims.ageOver ?? 0) >= 18 && !!proof.claims.residency?.length && proof.claims.residency.every((c) => EU.includes(c));
    const input: RiskInput = {
      limit: req.limit, days: req.days,
      mandate: { maxPerOrder: BigInt(m.scope.maxPerOrder), categories: m.scope.categories, merchants: m.scope.merchants },
      provenAgeAndResidency: proven, ownerKind: m.principal.kind, incidents: Number(e.incidents), receipts: Number(e.receipts),
      order: req.order && { amount: req.order.amount },
    };
    const q = quote(input);
    if ('refused' in q) return q;
    return { ...q, mandateId: id, owner: m.principal.account, payer: m.agent.payer, token: m.agent.registry.tokenId };
  }

  /** x402 before-verify check for a premium payment: returns a refusal reason or null. */
  async checkPurchase(quoteId: string, payer: string, amount: bigint): Promise<string | null> {
    const q = this.quotes.get(quoteId);
    if (!q || q.expires < this.deps.now()) return 'unknown or expired quote';
    if (payer !== q.payer) return 'payer is not the agent this quote is for';
    const fresh = await this.price(q.request);
    if ('refused' in fresh) return fresh.refused;
    if (fresh.premium !== q.premium || amount !== q.premium) return 'premium changed; request a new quote';
    return null;
  }

  /** After the premium settled: write the policy on-chain (3 attempts; kept as unissued otherwise). */
  async issue(quoteId: string, premiumTx: string, stored?: StoredQuote): Promise<bigint | null> {
    const q = stored ?? this.quotes.get(quoteId);
    if (!q) {
      // Paid but the quote is gone: never drop it silently; keep it visible for a manual refund.
      this.unissued.push({ quoteId, premiumTx, error: 'quote missing: needs manual policy or refund' });
      this.save();
      return null;
    }
    const days = q.request.order ? 1 : q.request.days;
    const params: IssuePolicyParams = {
      holder: q.owner, agentPayer: q.payer, agentToken: q.token, mandate: { owner: q.owner, id: q.mandateId },
      kind: q.request.order ? { order: q.request.order.ref } : 'period',
      limit: q.request.order ? q.request.order.amount : q.request.limit,
      deductible: DEDUCTIBLE, premium: q.premium, premiumTx, validUntilMs: BigInt(this.deps.now() + days * DAY_MS),
    };
    let error = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.deps.cover.issuePolicy(params, this.deps.operator);
        if (r.id === null) throw new Error(`policy id missing in tx ${r.hash}`);
        this.policies.push({ policyId: r.id, quoteId, premiumTx, holder: q.owner, payer: q.payer, limit: params.limit, until: Number(params.validUntilMs), kind: q.request.order ? 'order' : 'period' });
        this.premiumsIn += q.premium;
        this.quotes.delete(quoteId);
        this.save();
        return r.id;
      } catch (e) {
        error = (e as Error).message;
        await this.sleep(1000 * (attempt + 1));
      }
    }
    this.unissued.push({ quoteId, premiumTx, error, quote: q });
    this.save();
    return null;
  }

  async retryUnissued() {
    const pending = this.unissued.splice(0);
    for (const u of pending) {
      if (u.quote) await this.issue(u.quoteId, u.premiumTx, u.quote);
      else this.unissued.push(u); // needs a human: keep it
    }
    this.save();
  }

  /** Assesses a filed claim against the on-chain receipts it cites, and records the outcome. */
  async assessClaim(claimId: bigint, receiptTxs: string[]): Promise<Assessment> {
    if (this.claims.has(claimId)) throw new Error('claim already assessed');
    const c = await this.deps.cover.claim(claimId);
    if (!c) throw new Error('unknown claim');
    const p = await this.deps.cover.policy(c.policyId);
    if (!p) throw new Error('unknown policy');
    const e = await this.deps.mandateEntry(p.mandate.owner, p.mandate.id);
    const receipts = [];
    for (const tx of receiptTxs.slice(0, 4)) {
      const r = await this.deps.registryEvents(tx);
      for (const ev of r?.events ?? []) {
        if (ev.type === 'Receipt') receipts.push({ order: ev.order, amount: ev.amount, at: r!.at, mandateId: ev.id, owner: ev.owner });
      }
    }
    const paidOrders = [...this.claims.values()].filter((x) => x.paid && x.policyId === c.policyId).flatMap((x) => x.orders);
    const a = assess({
      claim: { kind: c.kind, amount: c.amount, orders: c.orders },
      policy: { validFromMs: Number(p.validFromMs), validUntilMs: Number(p.validUntilMs), limit: p.limit, paidOut: p.paidOut, deductible: p.deductible, mandateId: p.mandate.id, owner: p.mandate.owner },
      receipts, priorPaidOrders: paidOrders, incidentFiled: (e?.incidents ?? 0n) > 0n,
    });
    await this.deps.cover.assess(claimId, a.ok, await sha256Hex(a.reason), this.deps.operator);
    const rec: ClaimRecord = {
      claimId, policyId: c.policyId, holder: p.holder, claimant: c.claimant, recipient: c.kind === 'MerchantLoss' ? c.claimant : p.agentPayer,
      assessment: a, receiptTxs, orders: c.orders,
    };
    this.claims.set(claimId, rec);
    this.save();

    if (a.noEvidence) {
      // Nothing on-chain backs it: reject without a payout decision, and count it against the
      // account that filed it (the claimant signs fileClaim, so this is who made the claim).
      await this.deps.cover.decide(claimId, false, this.deps.operator);
      rec.decided = true;
      const n = (this.fraud.get(c.claimant) ?? 0) + 1;
      this.fraud.set(c.claimant, n);
      if (n >= FRAUD_THRESHOLD) {
        // Drafted only: a human reviews it in the console before anything is anchored.
        this.pendingDisclosures.push({ claimId: String(claimId), account: c.claimant, doc: {
          type: 'kuasa-cover/lawful-disclosure-request', claimId: String(claimId), account: c.claimant, policyHolder: p.holder,
          rejectedClaimsWithoutEvidence: n,
          legalBasis: 'Suspected insurance fraud. Disclosure of the account holder identity is requested from the identity provider and Privacy Guardians via court order.',
          at: new Date(this.deps.now()).toISOString(),
        } });
      }
      this.save();
    }
    return a;
  }

  /**
   * The human claims handler's decision. Approval pays only if the pool can cover it. Calls for
   * the same claim are serialised, so a double-click can never pay twice.
   */
  async decide(claimId: bigint, approve: boolean): Promise<{ decided: true; paid?: string; reason?: string }> {
    const rec = this.claims.get(claimId);
    if (!rec) throw new Error('claim not assessed yet');
    if (rec.busy) return rec.busy;
    rec.busy = (async () => {
      if (!approve) {
        if (rec.paid) throw new Error('claim already paid');
        await this.deps.cover.decide(claimId, false, this.deps.operator);
        rec.decided = true;
        return { decided: true as const };
      }
      if (!rec.assessment.ok) throw new Error('only positively assessed claims can be approved');
      if (!rec.decided) {
        await this.deps.cover.decide(claimId, true, this.deps.operator);
        rec.decided = true;
      }
      return this.pay(rec);
    })().finally(() => { rec.busy = undefined; this.save(); });
    return rec.busy;
  }

  /** Pays an approved claim at most once; a failed on-chain record is retried without paying again. */
  private async pay(rec: ClaimRecord): Promise<{ decided: true; paid?: string; reason?: string }> {
    if (!rec.paid) {
      const policy = await this.deps.cover.policy(rec.policyId);
      const remaining = policy ? policy.limit - policy.paidOut : 0n;
      const amount = rec.assessment.payout < remaining ? rec.assessment.payout : remaining;
      if (amount <= 0n) return { decided: true, reason: 'policy limit exhausted' };
      if ((await this.deps.treasuryBalance()) < amount) return { decided: true, reason: 'insufficient pool: approved, payout pending' };
      const tx = await this.deps.pay(rec.recipient, amount, 'kuasa-claim:' + rec.claimId);
      rec.paid = tx; // money moved: never transfer again for this claim
      rec.amountPaid = amount;
      rec.recordPending = true;
      this.payouts.push({ claimId: String(rec.claimId), to: rec.recipient, amount, tx });
      this.save(); // money moved: persist before anything else can fail
    }
    if (rec.recordPending) {
      try {
        await this.deps.cover.recordPayout(rec.claimId, rec.paid, rec.amountPaid!, this.deps.operator);
        rec.recordPending = false;
      } catch {
        return { decided: true, paid: rec.paid, reason: 'payout sent; on-chain record pending, approve again to retry the record' };
      }
    }
    return { decided: true, paid: rec.paid };
  }

  /** A human approves a drafted disclosure request: it is stored, hashed and anchored on the claim. */
  async approveDisclosure(claimId: bigint) {
    const i = this.pendingDisclosures.findIndex((d) => d.claimId === String(claimId));
    if (i < 0) throw new Error('no pending disclosure for this claim');
    const [d] = this.pendingDisclosures.splice(i, 1);
    const hash = await this.deps.saveDisclosure(d.doc);
    await this.deps.cover.markFraud(claimId, hash, this.deps.operator);
    this.disclosures.push({ claimId: d.claimId, account: d.account, hash });
    this.save();
    return hash;
  }

  claimRecord = (id: bigint) => this.claims.get(id);
  /** A live (unexpired) quote, for pricing the x402 premium route. */
  quoteOf = (id: string) => { const q = this.quotes.get(id); return q && q.expires >= this.deps.now() ? q : undefined; };

  state() {
    return {
      policies: this.policies,
      unissued: this.unissued,
      claims: [...this.claims.values()].map(({ busy, ...r }) => r),
      payouts: this.payouts,
      premiumsIn: this.premiumsIn,
      pendingDisclosures: this.pendingDisclosures,
      disclosures: this.disclosures,
      fraudCounts: Object.fromEntries(this.fraud),
    };
  }
}
