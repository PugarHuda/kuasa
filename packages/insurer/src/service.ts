import type { Wallet } from '@kuasa/chain';
import { canonicalJson, type Claim, type IssuePolicyParams, type Mandate, type MandateEntry, type Policy, type RegistryEvent, sha256Hex } from '@kuasa/core';
import { assess, type Assessment, quote, type Quote, type RiskInput } from '@kuasa/cover';
import type { IdentitySource } from '@kuasa/merchant';

const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
const QUOTE_TTL_MS = 10 * 60_000;
/** Longer than an x402 payment can take (maxTimeoutSeconds 120 + finalization). */
const RESERVATION_TTL_MS = 150_000;
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
  /** Checks the requester controls the agent payer (signed payer proof); quotes count toward that payer's quota. */
  verifyPayer(payer: string, proof: unknown): Promise<boolean>;
  cover: {
    issuePolicy(p: IssuePolicyParams, operator?: Wallet): Promise<TxResult & { id: bigint | null }>;
    policy(id: bigint): Promise<Policy | null>;
    claim(id: bigint): Promise<Claim | null>;
    assess(claimId: bigint, ok: boolean, reasonHex: string, operator?: Wallet): Promise<TxResult>;
    decide(claimId: bigint, approve: boolean, operator?: Wallet): Promise<TxResult>;
    recordPayout(claimId: bigint, payoutTx: string, amount: bigint, operator?: Wallet): Promise<TxResult>;
    markFraud(claimId: bigint, disclosureHex: string, operator?: Wallet): Promise<TxResult>;
    /** The policy already issued for this premium payment, if any (premium_tx is unique per premium). */
    policyByPremiumTx(premiumTx: string): Promise<bigint | null>;
  };
  /** kuasa-registry events of a finalized transaction, with block time. */
  registryEvents(tx: string): Promise<{ at: number; events: RegistryEvent[] } | null>;
  treasuryBalance(): Promise<bigint>;
  /** Claims already paid to this agent payer (on-chain), for experience rating. */
  paidClaims?(payer: string): Promise<number>;
  /** Submits a payout from the treasury and returns its hash without waiting for finalization. */
  pay(to: string, amount: bigint, memo: string): Promise<string>;
  /** Outcome of a submitted transaction. */
  txOutcome(hash: string): Promise<'success' | 'failed' | 'pending'>;
  /** Stores a lawful-disclosure request document; returns its sha256 (hex). */
  saveDisclosure(doc: object): Promise<string>;
  operator?: Wallet;
  /** Called with a JSON snapshot after every state change (persist it; restore via the constructor). */
  persist?: (snapshot: string) => void;
  /** Upper bound on live quotes held in memory (oldest evicted first). */
  maxQuotes?: number;
  /** Upper bound on live quotes per agent payer (its oldest evicted first). */
  maxQuotesPerPayer?: number;
  /** Tiered autonomy: positive claims paying at most this are paid automatically after an objection window (unset = every claim waits for a human). */
  autoPayLimit?: bigint;
  /** Objection window before an automatic payout (default 2 minutes). */
  autoPayDelayMs?: number;
};

/** JSON with bigints tagged, so a snapshot round-trips exactly. */
const toSnapshot = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x));
const fromSnapshot = (s: string) => JSON.parse(s, (_k, x) => (x && typeof x === 'object' && typeof x.$big === 'string' && Object.keys(x).length === 1 ? BigInt(x.$big) : x));

export type QuoteRequest = { mandateUrl: string; limit: bigint; days: number; order?: { ref: string; amount: bigint }; proof?: unknown };
export type StoredQuote = Quote & {
  quoteId: string; request: QuoteRequest; mandateId: string; owner: string; payer: string; token: string; expires: number;
};
type ClaimRecord = {
  claimId: bigint; policyId: bigint; holder: string; claimant: string; recipient: string; assessment: Assessment; receiptTxs: string[]; orders: string[];
  mandateId?: string;
  /** The human decision (or the automatic no-evidence rejection). */
  verdict?: 'approved' | 'rejected';
  /** Submitted payout transfer not yet confirmed: checked before anything is sent again. */
  payoutTx?: string;
  paid?: string; amountPaid?: bigint; recordPending?: boolean;
  /** Tiered autonomy: paid automatically at this time unless a human holds it first. */
  autoPayAt?: number; held?: boolean; decidedBy?: 'auto';
  /** Why an approved claim is not paid (e.g. insufficient pool); `final` when it never will be. */
  payoutBlocked?: string; final?: boolean;
  busy?: Promise<{ decided: true; paid?: string; reason?: string }>;
  busyApprove?: boolean;
};
type Disclosure = { claimId: string; account: string; doc: object };

/**
 * Kuasa Cover insurer: prices cover from on-chain facts, issues policies after the premium is
 * paid over x402, assesses claims against on-chain receipts and pays approved claims from the
 * treasury. Every payout needs a human decision (`decide`).
 */
export class InsurerService {
  private quotes = new Map<string, StoredQuote>();
  /** Quotes whose premium payment is in flight: one quote backs one payment. */
  private paying = new Map<string, number>(); // quoteId -> reserved at (ms)
  /** Quotes whose premium settled: their reservation never lapses. */
  private settled = new Set<string>();
  private policies: { policyId: bigint; quoteId: string; premiumTx: string; holder: string; payer: string; limit: bigint; until: number; kind: string }[] = [];
  /** Premiums that settled but whose policy is not on-chain yet; the quote travels with them. */
  private unissued: { quoteId: string; premiumTx: string; error: string; quote?: StoredQuote }[] = [];
  /** Paid premiums that can never become a policy (e.g. mandate revoked meanwhile): refund manually. */
  private needsRefund: { quoteId: string; premiumTx: string; reason: string }[] = [];
  private retrying = false;
  private assessing = new Set<bigint>();
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
      this.needsRefund = s.needsRefund ?? [];
      this.claims = new Map((s.claims ?? []).map((c: ClaimRecord & { decided?: boolean }) => {
        // older snapshots stored a bare 'decided' flag; payouts still re-check the on-chain status
        if (c.decided && !c.verdict) c.verdict = c.paid || c.assessment.ok ? 'approved' : 'rejected';
        delete c.decided;
        return [c.claimId, c];
      }));
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
      policies: this.policies, unissued: this.unissued, needsRefund: this.needsRefund, claims: [...this.claims.values()].map(({ busy, busyApprove, ...r }) => r),
      fraud: Object.fromEntries(this.fraud), pendingDisclosures: this.pendingDisclosures, disclosures: this.disclosures,
      payouts: this.payouts, premiumsIn: this.premiumsIn,
    }));
  }

  private sleep = (ms: number) => (this.deps.sleep ?? ((m) => new Promise((r) => setTimeout(r, m))))(ms);

  /** Prices cover. The quote is held for 10 minutes and must still match at purchase time. */
  async quote(req: QuoteRequest): Promise<StoredQuote | { refused: string }> {
    const fresh = await this.price(req);
    if ('refused' in fresh) return fresh;
    if (!(await this.deps.verifyPayer(fresh.payer, req.proof).catch(() => false))) return { refused: 'payer proof required: sign the request with the agent payer key' };
    req = { ...req, proof: undefined }; // not kept
    const quoteId = await sha256Hex(canonicalJson({ ...req, limit: String(req.limit), order: req.order && { ...req.order, amount: String(req.order.amount) }, at: this.deps.now(), n: Math.random() }));
    const stored: StoredQuote = { ...fresh, quoteId, request: req, expires: this.deps.now() + QUOTE_TTL_MS };
    this.dropStaleReservations();
    for (const [id, q] of this.quotes) if (q.expires < this.deps.now() && !this.paying.has(id)) this.quotes.delete(id);
    // Mandate URLs are public, so anyone can ask for quotes "as" an agent: at a cap new quotes are
    // refused and nothing existing is ever evicted (quotes expire after 10 minutes).
    const mine = [...this.quotes.values()].filter((q) => q.payer === stored.payer).length;
    if (mine >= (this.deps.maxQuotesPerPayer ?? 20)) return { refused: 'too many open quotes for this agent; try again in a few minutes' };
    if (this.quotes.size >= (this.deps.maxQuotes ?? 10_000)) return { refused: 'too many open quotes; try again in a few minutes' };
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
      paidClaims: this.deps.paidClaims ? await this.deps.paidClaims(m.agent.payer) : 0,
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
    this.dropStaleReservations();
    if (this.paying.has(quoteId)) return 'this quote is already being paid';
    this.paying.set(quoteId, this.deps.now()); // reserve before any await: one quote, one payment
    const fresh = await this.price(q.request);
    const reason = 'refused' in fresh ? fresh.refused : fresh.premium !== q.premium || amount !== q.premium ? 'premium changed; request a new quote' : null;
    if (reason) this.paying.delete(quoteId);
    return reason;
  }

  /** After the premium settled: write the policy on-chain (3 attempts; kept as unissued otherwise). */
  async issue(quoteId: string, premiumTx: string, stored?: StoredQuote): Promise<bigint | null> {
    const done = this.policies.find((p) => p.quoteId === quoteId);
    if (done && done.premiumTx !== premiumTx) {
      // A second premium paid against an already issued quote: one quote, one policy.
      this.needsRefund.push({ quoteId, premiumTx, reason: 'second payment for a quote whose policy was already issued' });
      this.consume(quoteId);
      this.save();
      return null;
    }
    if (done) return done.policyId;
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
    const record = (id: bigint) => {
      this.policies.push({ policyId: id, quoteId, premiumTx, holder: q.owner, payer: q.payer, limit: params.limit, until: Number(params.validUntilMs), kind: q.request.order ? 'order' : 'period' });
      this.premiumsIn += q.premium;
      this.consume(quoteId);
      this.save();
      return id;
    };
    const issued = async () => this.deps.cover.policyByPremiumTx(premiumTx).catch(() => null);
    let error = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      // A previous attempt may have landed on-chain even though the client saw an error.
      const existing = await issued();
      if (existing !== null) return this.policies.some((p) => p.premiumTx === premiumTx) ? existing : record(existing);
      // A revoked or expired mandate will never accept a policy: stop and refund instead of paying fees forever.
      const m = await this.deps.mandateEntry(q.owner, q.mandateId).catch(() => undefined);
      if (m === null || (m && (m.revoked || Number(m.validUntilMs) <= this.deps.now()))) {
        this.needsRefund.push({ quoteId, premiumTx, reason: m ? (m.revoked ? 'mandate revoked after the premium was paid' : 'mandate expired') : 'mandate not found' });
        this.consume(quoteId);
        this.save();
        return null;
      }
      try {
        const r = await this.deps.cover.issuePolicy(params, this.deps.operator);
        if (r.id === null) throw new Error(`policy id missing in tx ${r.hash}`);
        return record(r.id);
      } catch (e) {
        error = (e as Error).message;
        await this.sleep(1000 * (attempt + 1));
      }
    }
    const late = await issued();
    if (late !== null) return record(late);
    this.unissued.push({ quoteId, premiumTx, error, quote: q });
    this.consume(quoteId); // the quote travels with the unissued entry
    this.save();
    return null;
  }

  /** A paid quote leaves the live store: it no longer counts toward caps and cannot be paid again. */
  private consume(quoteId: string) {
    this.quotes.delete(quoteId);
    this.paying.delete(quoteId);
    this.settled.delete(quoteId);
  }

  /** A reservation whose payment never settled nor failed visibly (e.g. rejected at verification) lapses. */
  private dropStaleReservations() {
    for (const [id, at] of this.paying) if (!this.settled.has(id) && this.deps.now() - at > RESERVATION_TTL_MS) this.paying.delete(id);
  }

  /** The reserved premium payment did not settle: the quote may be paid again. */
  releaseQuote(quoteId: string) {
    if (!this.settled.has(quoteId)) this.paying.delete(quoteId);
  }

  /** The premium settled: the quote is consumed, whatever happens to issuance. */
  markSettled(quoteId: string) {
    this.settled.add(quoteId);
    this.paying.set(quoteId, this.paying.get(quoteId) ?? this.deps.now());
  }

  quoteCount = () => this.quotes.size;

  async retryUnissued() {
    if (this.retrying) return;
    this.retrying = true;
    try {
      await this.retryOnce();
    } finally {
      this.retrying = false;
    }
  }

  private async retryOnce() {
    const pending = this.unissued.splice(0);
    for (const u of pending) {
      if (u.quote) await this.issue(u.quoteId, u.premiumTx, u.quote);
      else this.unissued.push(u); // needs a human: keep it
    }
    this.save();
  }

  /** Assesses a filed claim against the on-chain receipts it cites, and records the outcome. */
  async assessClaim(claimId: bigint, receiptTxs: string[]): Promise<Assessment> {
    if (this.claims.has(claimId) || this.assessing.has(claimId)) throw new Error('claim already assessed');
    this.assessing.add(claimId);
    try {
      return await this.assessOnce(claimId, receiptTxs);
    } finally {
      this.assessing.delete(claimId);
    }
  }

  private async assessOnce(claimId: bigint, receiptTxs: string[]): Promise<Assessment> {
    const c = await this.deps.cover.claim(claimId);
    if (!c) throw new Error('unknown claim');
    const p = await this.deps.cover.policy(c.policyId);
    if (!p) throw new Error('unknown policy');
    const e = await this.deps.mandateEntry(p.mandate.owner, p.mandate.id);
    const receipts = [];
    for (const tx of receiptTxs.slice(0, 4)) {
      const r = await this.deps.registryEvents(tx);
      for (const ev of r?.events ?? []) {
        if (ev.type !== 'Receipt') continue;
        // Per-order cover: the shop records sha256(orderRef + payment tx) as the receipt order.
        const matchesOrderRef = typeof p.kind === 'object' ? ev.order === await sha256Hex(p.kind.order + ev.paymentTx) : undefined;
        receipts.push({ order: ev.order, amount: ev.amount, at: r!.at, mandateId: ev.id, owner: ev.owner, paymentTx: ev.paymentTx, matchesOrderRef });
      }
    }
    // No double cover: orders paid, approved or still open under ANY policy of the same mandate.
    const paidOrders = [...this.claims.values()].filter((x) => x.mandateId === p.mandate.id && x.verdict !== 'rejected' && (x.paid || x.verdict === 'approved' || x.assessment.ok)).flatMap((x) => x.orders);
    const a = assess({
      claim: { kind: c.kind, amount: c.amount, orders: c.orders },
      policy: { validFromMs: Number(p.validFromMs), validUntilMs: Number(p.validUntilMs), limit: p.limit, paidOut: p.paidOut, deductible: p.deductible, mandateId: p.mandate.id, owner: p.mandate.owner, orderRef: typeof p.kind === 'object' ? p.kind.order : undefined },
      receipts, priorPaidOrders: paidOrders, incidentFiled: (e?.incidents ?? 0n) > 0n,
    });
    await this.deps.cover.assess(claimId, a.ok, await sha256Hex(a.reason), this.deps.operator);
    const rec: ClaimRecord = {
      claimId, policyId: c.policyId, holder: p.holder, claimant: c.claimant, recipient: c.kind === 'MerchantLoss' ? c.claimant : p.agentPayer,
      assessment: a, receiptTxs, orders: c.orders, mandateId: p.mandate.id,
    };
    const limit = this.deps.autoPayLimit;
    if (a.ok && limit !== undefined && a.payout <= limit && !this.flagged(rec)) rec.autoPayAt = this.deps.now() + (this.deps.autoPayDelayMs ?? 120_000);
    this.claims.set(claimId, rec);
    this.save();

    if (a.noEvidence) {
      // Nothing on-chain backs it: reject without a payout decision, and count it against the
      // account that filed it (the claimant signs fileClaim, so this is who made the claim).
      await this.deps.cover.decide(claimId, false, this.deps.operator);
      rec.verdict = 'rejected';
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

  /** Any party to the claim (filer, policy holder, paid account) with a rejected no-evidence claim. */
  private flagged(rec: ClaimRecord) {
    return [rec.claimant, rec.holder, rec.recipient].some((a) => (this.fraud.get(a) ?? 0) > 0);
  }

  /** A human takes the claim over: no automatic payout. */
  hold(claimId: bigint) {
    const rec = this.claims.get(claimId);
    if (!rec) throw new Error('claim not assessed yet');
    rec.held = true;
    rec.autoPayAt = undefined;
    this.save();
  }

  /** Pays small, positively assessed claims whose objection window has passed and nobody held. */
  async runAutoPay() {
    for (const rec of this.claims.values()) {
      if (rec.autoPayAt === undefined || rec.held || rec.verdict || this.deps.now() < rec.autoPayAt) continue;
      if (this.flagged(rec)) { this.hold(rec.claimId); continue; } // flagged during the window: a human decides
      rec.decidedBy = 'auto';
      await this.decide(rec.claimId, true).catch(() => { rec.decidedBy = undefined; });
    }
  }

  /**
   * The human claims handler's decision. A rejection is final; approval pays only if the pool can
   * cover it. Calls for the same claim are serialised, so a double-click can never pay twice.
   */
  async decide(claimId: bigint, approve: boolean): Promise<{ decided: true; paid?: string; reason?: string }> {
    const rec = this.claims.get(claimId);
    if (!rec) throw new Error('claim not assessed yet');
    if (rec.busy) {
      if (approve !== rec.busyApprove) throw new Error('another decision on this claim is in progress');
      return rec.busy;
    }
    rec.busyApprove = approve;
    rec.busy = (async () => {
      if (!approve) {
        if (rec.verdict === 'approved') throw new Error('claim already approved');
        if (rec.verdict !== 'rejected') await this.deps.cover.decide(claimId, false, this.deps.operator);
        rec.verdict = 'rejected';
        return { decided: true as const };
      }
      if (rec.verdict === 'rejected') throw new Error('claim was rejected; it cannot be paid');
      if (!rec.assessment.ok) throw new Error('only positively assessed claims can be approved');
      if (!rec.verdict) {
        await this.deps.cover.decide(claimId, true, this.deps.operator);
        rec.verdict = 'approved';
      }
      return this.pay(rec);
    })().finally(() => { rec.busy = undefined; this.save(); });
    return rec.busy;
  }

  /**
   * Pays an approved claim at most once. The claim must be Approved on-chain; a submitted transfer
   * is confirmed before anything is sent again; a failed on-chain record is retried without paying.
   */
  private async pay(rec: ClaimRecord): Promise<{ decided: true; paid?: string; reason?: string }> {
    if (rec.final) return { decided: true, reason: rec.payoutBlocked };
    if (!rec.paid) {
      const onChain = await this.deps.cover.claim(rec.claimId);
      if (onChain?.status.tag === 'Paid') {
        rec.paid = onChain.status.payoutTx;
        rec.recordPending = false;
        return { decided: true, paid: rec.paid };
      }
      if (onChain?.status.tag !== 'Approved') return { decided: true, reason: 'claim is not approved on-chain' };
      if (rec.payoutTx) {
        const outcome = await this.deps.txOutcome(rec.payoutTx).catch(() => 'pending' as const);
        if (outcome === 'pending') return { decided: true, reason: 'payout in flight; approve again to check' };
        if (outcome === 'failed') rec.payoutTx = undefined;
        else this.confirmPayout(rec);
      }
      if (!rec.paid && !rec.payoutTx) {
        const policy = await this.deps.cover.policy(rec.policyId);
        const remaining = policy ? policy.limit - policy.paidOut : 0n;
        const amount = rec.assessment.payout < remaining ? rec.assessment.payout : remaining;
        if (amount <= 0n) {
          rec.payoutBlocked = 'policy limit exhausted';
          rec.final = true;
          return { decided: true, reason: rec.payoutBlocked };
        }
        if ((await this.deps.treasuryBalance()) < amount) {
          rec.payoutBlocked = 'insufficient pool: approved, payout pending';
          return { decided: true, reason: rec.payoutBlocked };
        }
        rec.payoutBlocked = undefined;
        rec.payoutTx = await this.deps.pay(rec.recipient, amount, 'kuasa-claim:' + rec.claimId);
        rec.amountPaid = amount;
        this.save(); // submitted: from now on we check this transfer instead of sending another
        const outcome = await this.deps.txOutcome(rec.payoutTx).catch(() => 'pending' as const);
        if (outcome === 'pending') return { decided: true, reason: 'payout in flight; approve again to check' };
        if (outcome === 'failed') {
          rec.payoutTx = undefined;
          return { decided: true, reason: 'payout transfer failed on-chain; approve again to retry' };
        }
        this.confirmPayout(rec);
      }
    }
    if (rec.recordPending) {
      try {
        await this.deps.cover.recordPayout(rec.claimId, rec.paid!, rec.amountPaid!, this.deps.operator);
        rec.recordPending = false;
      } catch {
        return { decided: true, paid: rec.paid, reason: 'payout sent; on-chain record pending, approve again to retry the record' };
      }
    }
    return { decided: true, paid: rec.paid };
  }

  private confirmPayout(rec: ClaimRecord) {
    rec.paid = rec.payoutTx; // money moved: never transfer again for this claim
    rec.recordPending = true;
    this.payouts.push({ claimId: String(rec.claimId), to: rec.recipient, amount: rec.amountPaid!, tx: rec.paid! });
    this.save();
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
      needsRefund: this.needsRefund,
      claims: [...this.claims.values()].map(({ busy, busyApprove, ...r }) => r),
      payouts: this.payouts,
      premiumsIn: this.premiumsIn,
      pendingDisclosures: this.pendingDisclosures,
      disclosures: this.disclosures,
      fraudCounts: Object.fromEntries(this.fraud),
    };
  }
}
