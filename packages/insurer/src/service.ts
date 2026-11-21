import { AccountAddress } from '@concordium/web-sdk';
import type { Wallet } from '@kuasa/chain';
import { canonicalJson, type Claim, type ClaimEvidence, evidenceHash, REASON_CODES, type SignedDeliveryNote, type IssuePolicyParams, type Mandate, type MandateEntry, type Policy, type RegistryEvent, sha256Hex } from '@kuasa/core';
import { assess, type Assessment, DUPLICATE_WINDOW_MS, findDuplicates, type SeenReceipt, quote, type Quote, type RiskInput, scopeFromAp2Intent, type Ap2IntentMandate } from '@kuasa/cover';
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
  /** True iff the mandate's principal signed this AP2 intent (its `user_authorization`). Only then do its SKUs back AM20 claims. */
  verifyAp2Owner?(intent: Ap2IntentMandate, owner: string): Promise<boolean>;
  /** Concordium account of a merchant named in an AP2 intent (AP2 names merchants; Kuasa needs accounts). */
  ap2Merchant?(name: string): string | undefined;
  cover: {
    issuePolicy(p: IssuePolicyParams, operator?: Wallet): Promise<TxResult & { id: bigint | null }>;
    policy(id: bigint): Promise<Policy | null>;
    claim(id: bigint): Promise<Claim | null>;
    assess(claimId: bigint, ok: boolean, reasonHex: string, operator?: Wallet): Promise<TxResult>;
    decide(claimId: bigint, approve: boolean, operator?: Wallet): Promise<TxResult>;
    recordPayout(claimId: bigint, payoutTx: string, amount: bigint, operator?: Wallet): Promise<TxResult>;
    markFraud(claimId: bigint, disclosureHex: string, operator?: Wallet): Promise<TxResult>;
    /** v2 contracts: automatic approval, accepted only within the contract's published rules. */
    autoApprove?(claimId: bigint, operator?: Wallet): Promise<TxResult>;
    /** v3: file a detected duplicate-order claim for the agent (fully parametric). */
    fileClaimFor?(p: { policyId: bigint; kind: 'AgentMistake'; amount: bigint; evidence: string; orders: string[] }): Promise<TxResult & { id: bigint | null }>;
    /** v3: a policy's own terms (can only tighten the contract's rules). */
    setTerms?(policyId: bigint, t: { autoPayLimit: bigint; objectionWindowMs: bigint; intent: string | null }): Promise<TxResult>;
    /** The policy already issued for this premium payment, if any (premium_tx is unique per premium). */
    policyByPremiumTx(premiumTx: string): Promise<bigint | null>;
  };
  /** kuasa-registry events of a finalized transaction, with block time. */
  registryEvents(tx: string): Promise<{ at: number; events: RegistryEvent[]; sender?: string } | null>;
  /** Checks a merchant delivery note was signed by `signer` (the account that recorded the receipt). */
  verifyDelivery?(d: SignedDeliveryNote, signer: string): Promise<boolean>;
  treasuryBalance(): Promise<bigint>;
  /**
   * Underwriting capacity: the pool and the cover still owed on live policies (all cover contracts).
   * A quote is refused when the new limit would leave live cover not fully backed by the pool.
   */
  capacity?(): Promise<{ pool: bigint; exposure: bigint }>;
  /** Claims already paid to this agent payer (on-chain), for experience rating. */
  paidClaims?(payer: string): Promise<number>;
  /** v3: the agent operator's CCD bond on the cover contract (null if none). */
  bondOf?(payer: string): Promise<{ poster: string; amount: bigint } | null>;
  /** On-chain cover of this payer now (the contract's coverOf view): one live period policy per payer. */
  coverOf?(payer: string): Promise<{ periodRemaining: bigint; policyId: bigint | null }>;
  /** Circuit breaker: publish (or lift) a purchase hold on an agent payer that merchants' guards honour. */
  hold?(payer: string, reason: string): Promise<void>;
  unhold?(payer: string): Promise<void>;
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
  /** Appeals panel (Kleros-style): independent juror accounts; a majority decides an appeal. */
  jurors?: string[];
  /**
   * Staked jurors (Nexus Mutual's assessors, Kleros coherence): a juror votes only with at least
   * `jurorMinStake` of capital in the pool; when the panel decides, each juror who voted against the
   * verdict forfeits `jurorPenalty` (at most its stake) to the jurors who voted with it.
   */
  jurorStake?(juror: string): bigint;
  jurorMinStake?: bigint;
  jurorPenalty?: bigint;
  /** Moves capital between jurors' pool balances (the panel's settlement). */
  settlePanel?(moves: { from: string; to: string; amount: bigint }[]): void;
  /** Share of the premium returned when a policy ends with no claim (basis points; unset = none). */
  givebackBps?: bigint;
  /** Market: this insurer's pricing over the shared risk model (basis points, e.g. 9000 = 10% cheaper). */
  priceBps?: bigint;
  /**
   * Market, "other insurance" clause: orders that another insurer on the market has paid or approved a
   * claim for (read from their cover contracts). They count as already covered, so one loss is paid once.
   */
  otherInsurersOrders?(): Promise<string[]>;
};

/** JSON with bigints tagged, so a snapshot round-trips exactly. */
const toSnapshot = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x));
const fromSnapshot = (s: string) => JSON.parse(s, (_k, x) => (x && typeof x === 'object' && typeof x.$big === 'string' && Object.keys(x).length === 1 ? BigInt(x.$big) : x));

/** Canonical account (account aliases share the first 29 bytes); undefined if not an address. */
const canonical = (a: string) => { try { return Buffer.from(AccountAddress.fromBase58(a).decodedAddress.slice(0, 29)).toString('hex'); } catch { return undefined; } };

export type QuoteRequest = { mandateUrl: string; limit: bigint; days: number; order?: { ref: string; amount: bigint }; proof?: unknown;
  /** Merchant-paid cover: this account (e.g. the shop) pays the premium; the policy still covers the agent. */
  sponsor?: string;
  /** The user's AP2 Intent Mandate, when the agent works under one: the Kuasa mandate must sit inside it. */
  ap2?: Ap2IntentMandate;
  /** Chosen by the buyer: claims above this always go to a human (0 = never automatic). Can only tighten the insurer's rule. */
  maxAutoPay?: bigint };
export type StoredQuote = Quote & {
  /** The AP2 intent carried the principal's signature (checked at quote time). */
  ownerSignedIntent?: boolean;
  quoteId: string; request: QuoteRequest; mandateId: string; owner: string; payer: string; token: string; expires: number;
};
type ClaimRecord = {
  claimId: bigint; policyId: bigint; /** chargeback-style reason code from the verified evidence */ reason?: string;
  /** The evidence document, kept only when its hash matched the claim's on-chain evidence (publishable: anyone can re-hash it). */
  evidenceDoc?: ClaimEvidence;
  /**
   * Compelling evidence (Stripe CE 3.0): orders recorded on this mandate before the claim that no claim
   * disputes. For an AM20 claim ("the agent did not mean to buy this"), two or more undisputed orders
   * qualify as evidence that the purchases were habitual: the human deciding sees it.
   */
  compelling?: { priorUndisputed: number; qualifies: boolean }; holder: string; claimant: string; recipient: string; assessment: Assessment; receiptTxs: string[]; orders: string[];
  mandateId?: string;
  /** The human decision (or the automatic no-evidence rejection). */
  verdict?: 'approved' | 'rejected';
  /** Submitted payout transfer not yet confirmed: checked before anything is sent again. */
  payoutTx?: string;
  paid?: string; amountPaid?: bigint; recordPending?: boolean;
  /** Tiered autonomy: paid automatically at this time unless a human holds it first. */
  autoPayAt?: number; held?: boolean; decidedBy?: 'auto' | 'panel'; /** v2: the on-chain autoApprove tx */ autoApproveTx?: string;
  /** Re-filed orders of an earlier rejected claim: an appeal, decided by a human or by the appeals panel. */
  appealOf?: bigint;
  /** Appeals panel votes (juror account, verdict). */
  panel?: { by: string; approve: boolean; at: number }[];
  /** Staked panel: capital moved from jurors who voted against the verdict to those who voted with it. */
  panelSettlement?: { from: string; to: string; amount: bigint }[];
  /** Objections raised during the objection window (each holds the claim for a human). */
  objections?: { by: string; reason: string; at: number }[];
  /** Why an approved claim is not paid (e.g. insufficient pool); `final` when it never will be. */
  payoutBlocked?: string; final?: boolean;
  busy?: Promise<{ decided: true; paid?: string; reason?: string }>;
  busyApprove?: boolean;
};
/** A duplicate-order pair the insurer spotted on-chain on an insured agent (parametric AM10 trigger). */
export type Detection = {
  payer: string; policyId: bigint; owner: string; mandateId: string; amount: bigint; at: number;
  orders: [string, string]; paymentTxs: [string, string]; receiptTxs: [string, string];
  /** dismissed: the owner resumed the agent, confirming these purchases were intended */
  status: 'open' | 'filed' | 'dismissed'; claimId?: bigint;
  /** v3: filed by the insurer itself (fileClaimFor), or why that failed */ filedBy?: 'insurer'; fileTx?: string; fileError?: string;
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
  private policies: { policyId: bigint; quoteId: string; premiumTx: string; holder: string; payer: string; limit: bigint; until: number; kind: string; /** SKUs of the AP2 intent it was bought under */ skus?: string[];
    /** the buyer's automatic payout limit (claims above it go to a human), whatever the contract supports */ maxAutoPay?: bigint;
    /** v3 terms set on-chain for this policy, or why they could not be */ terms?: { autoPayLimit: bigint; objectionWindowMs: bigint; intent: string | null; tx?: string; error?: string };
    /** premium share returned at the end of a claim-free policy */ giveback?: { amount: bigint; tx?: string };
    /** merchant-paid cover: who paid the premium (refunds and givebacks go back there) */ sponsor?: string;
    /** the premium paid into the pool (capital accounting counts it once, by premiumTx) */ premium?: bigint }[] = [];
  /** Premiums that settled but whose policy is not on-chain yet; the quote travels with them. */
  private unissued: { quoteId: string; premiumTx: string; error: string; quote?: StoredQuote }[] = [];
  /** Paid premiums that can never become a policy (e.g. mandate revoked meanwhile): refund manually. */
  private needsRefund: { quoteId: string; premiumTx: string; reason: string }[] = [];
  /** Unissued premiums taken off the list by a retry in progress. */
  private issuing: { quoteId: string; premiumTx: string; quote?: StoredQuote }[] = [];
  /** Unused premium returned when a holder cancels (pro rata, only if no claim was paid). */
  private refunds: { policyId: bigint; to: string; amount: bigint; tx?: string }[] = [];
  private refunding = false;
  private refunded = (policyId: bigint) => this.refunds.some((r) => r.policyId === policyId);
  private retrying = false;
  private assessing = new Set<bigint>();
  private claims = new Map<bigint, ClaimRecord>();
  private fraud = new Map<string, number>();
  private pendingDisclosures: Disclosure[] = [];
  private disclosures: { claimId: string; account: string; hash: string }[] = [];
  private payouts: { claimId: string; to: string; amount: bigint; tx: string }[] = [];
  private premiumsIn = 0n;
  /** Parametric monitoring: receipts seen on-chain in the last duplicate window, and what was found. */
  private recent: SeenReceipt[] = [];
  private detections: Detection[] = [];
  /** Agents whose purchases are paused by the circuit breaker (payer -> reason, since). */
  private holds = new Map<string, { reason: string; at: number; published?: boolean }>();
  /** Receipts at or before this time (per mandate) were confirmed by the owner when resuming the agent. */
  private confirmedBefore = new Map<string, number>();

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
      this.refunds = s.refunds ?? [];
      this.objectionsBy = new Map(Object.entries(s.objectionsBy ?? {}));
      this.detections = s.detections ?? [];
      this.holds = new Map(Object.entries(s.holds ?? {}));
      this.confirmedBefore = new Map(Object.entries(s.confirmedBefore ?? {}));
    }
  }

  /** Everything except live quotes and in-flight locks. */
  private save() {
    this.deps.persist?.(toSnapshot({
      policies: this.policies, unissued: this.unissued, needsRefund: this.needsRefund, claims: [...this.claims.values()].map(({ busy, busyApprove, ...r }) => r),
      fraud: Object.fromEntries(this.fraud), pendingDisclosures: this.pendingDisclosures, disclosures: this.disclosures,
      payouts: this.payouts, premiumsIn: this.premiumsIn, refunds: this.refunds, objectionsBy: Object.fromEntries(this.objectionsBy),
      detections: this.detections, holds: Object.fromEntries(this.holds), confirmedBefore: Object.fromEntries(this.confirmedBefore),
    }));
  }

  private sleep = (ms: number) => (this.deps.sleep ?? ((m) => new Promise((r) => setTimeout(r, m))))(ms);

  /** Prices cover. The quote is held for 10 minutes and must still match at purchase time. */
  async quote(req: QuoteRequest): Promise<StoredQuote | { refused: string }> {
    const fresh = await this.price(req);
    if ('refused' in fresh) return fresh;
    const signer = req.sponsor ?? fresh.payer;
    if (!(await this.deps.verifyPayer(signer, req.proof).catch(() => false))) return { refused: req.sponsor ? 'sponsor proof required: sign the request with the sponsor account key' : 'payer proof required: sign the request with the agent payer key' };
    req = { ...req, proof: undefined }; // not kept
    const quoteId = await sha256Hex(canonicalJson({ ...req, limit: String(req.limit), order: req.order && { ...req.order, amount: String(req.order.amount) }, maxAutoPay: req.maxAutoPay === undefined ? undefined : String(req.maxAutoPay), at: this.deps.now(), n: Math.random() }));
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
    if (this.deps.capacity) {
      // Fully collateralised: every live limit is backed by the pool. Re-checked when the premium is paid
      // (checkPurchase prices again). ponytail: two purchases settling in the same instant can both pass;
      // reserve capacity per paying quote if that ever matters.
      const c = await this.deps.capacity().catch(() => null);
      if (!c) return { refused: 'underwriting capacity unavailable; try again' };
      const want = req.order ? req.order.amount : req.limit;
      if (c.exposure + want > c.pool) return { refused: `no underwriting capacity: the pool (${c.pool}) would not cover live limits (${c.exposure}) plus this one (${want}); capital providers can add capital` };
    }
    if (!req.order && this.deps.coverOf) {
      // Issued policies only; checkPurchase also blocks a second period purchase in flight for the same payer.
      const v = await this.deps.coverOf(m.agent.payer).catch(() => null);
      if (!v) return { refused: 'cover status unavailable; try again' };
      if (v.policyId !== null && v.periodRemaining > 0n) return { refused: `this agent already has period cover (policy #${v.policyId}); cancel it or wait for it to end` };
    }
    if (req.ap2) {
      const scope = scopeFromAp2Intent(req.ap2, (n) => this.deps.ap2Merchant?.(n));
      if ('refused' in scope) return { refused: `AP2 intent: ${scope.refused}` };
      const outside = (m.scope.merchants ?? []).filter((x) => !scope.merchants.includes(x));
      if (!m.scope.merchants?.length || outside.length) return { refused: 'the Kuasa mandate is broader than the AP2 intent (it allows merchants the user did not name)' };
      if (Number(e.validUntilMs) > scope.validUntil * 1000) return { refused: 'the Kuasa mandate outlives the AP2 intent (expiry)' };
    }
    const proof = await this.deps.identity.claims(m, id);
    const proven = proof.ok && (proof.claims.ageOver ?? 0) >= 18 && !!proof.claims.residency?.length && proof.claims.residency.every((c) => EU.includes(c));
    const input: RiskInput = {
      limit: req.limit, days: req.days,
      mandate: { maxPerOrder: BigInt(m.scope.maxPerOrder), categories: m.scope.categories, merchants: m.scope.merchants },
      provenAgeAndResidency: proven, ownerKind: m.principal.kind, incidents: Number(e.incidents), receipts: Number(e.receipts),
      paidClaims: this.deps.paidClaims ? await this.deps.paidClaims(m.agent.payer) : 0,
      order: req.order && { amount: req.order.amount },
      bonded: !!(this.deps.bondOf && ((await this.deps.bondOf(m.agent.payer).catch(() => null))?.amount ?? 0n) >= 10_000_000n),
      recentOrders: this.recent.filter((r) => r.mandateId === id).length,
      recentSpend: this.recent.filter((r) => r.mandateId === id).reduce((a, r) => a + r.amount, 0n),
    };
    const q = quote(input);
    if ('refused' in q) return q;
    const bps = this.deps.priceBps ?? 10_000n;
    if (bps !== 10_000n) {
      q.premium = (q.premium * bps + 5_000n) / 10_000n;
      q.factors.push({ name: 'insurer pricing', multiplier: Number(bps) / 10_000, reason: "this insurer's own price over the shared risk model (the market compares insurers)" });
    }
    const ownerSigned = !!req.ap2 && !!this.deps.verifyAp2Owner && await this.deps.verifyAp2Owner(req.ap2, m.principal.account).catch(() => false);
    if (req.ap2) q.factors.push({ name: 'AP2 intent', multiplier: 1, reason: `Kuasa mandate sits inside the user’s AP2 Intent Mandate (merchants and expiry)${ownerSigned ? '; signed by the owner, so its SKUs define outside-intent (AM20) cover' : '; not signed by the owner, so no outside-intent (AM20) cover'}` });
    return { ...q, mandateId: id, owner: m.principal.account, payer: m.agent.payer, token: m.agent.registry.tokenId, ownerSignedIntent: ownerSigned };
  }

  /** x402 before-verify check for a premium payment: returns a refusal reason or null. */
  async checkPurchase(quoteId: string, payer: string, amount: bigint): Promise<string | null> {
    const q = this.quotes.get(quoteId);
    if (!q || q.expires < this.deps.now()) return 'unknown or expired quote';
    // a sponsored quote is paid by the sponsor only (refunds and givebacks go back to the sponsor)
    if (payer !== (q.request.sponsor ?? q.payer)) return q.request.sponsor ? 'this quote is sponsored: only the sponsor pays it' : 'payer is not the agent this quote is for';
    this.dropStaleReservations();
    if (this.paying.has(quoteId)) return 'this quote is already being paid';
    // coverOf only sees issued policies: a period premium in flight or paid-but-unissued for this payer blocks another one.
    const isPeriod = (o?: StoredQuote) => !!o && o.payer === q.payer && !o.request.order;
    if (isPeriod(q) && ([...this.paying.keys()].some((id) => isPeriod(this.quotes.get(id))) || [...this.unissued, ...this.issuing].some((u) => isPeriod(u.quote)))) {
      return 'a period policy for this agent is already being bought';
    }
    this.paying.set(quoteId, this.deps.now()); // reserve before any await: one quote, one payment (and one period purchase per payer)
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
      this.policies.push({ policyId: id, quoteId, premiumTx, premium: q.premium, holder: q.owner, payer: q.payer, limit: params.limit, until: Number(params.validUntilMs), kind: q.request.order ? 'order' : 'period', ...(q.request.sponsor ? { sponsor: q.request.sponsor } : {}), ...(q.ownerSignedIntent && q.request.ap2?.skus?.length ? { skus: q.request.ap2.skus } : {}), ...(q.request.maxAutoPay !== undefined ? { maxAutoPay: q.request.maxAutoPay } : {}) });
      this.premiumsIn += q.premium;
      this.consume(quoteId);
      this.save();
      void this.setTerms(id, q); // v3; never blocks issuance
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

  /** A premium payment from this payer is reserved or settling (its transfer must never be booked as capital). */
  isPaying(payer: string) {
    return [...this.paying.keys()].some((id) => this.quotes.get(id)?.payer === payer);
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
    this.issuing = pending; // still visible to checkPurchase while each one is issued
    for (const u of pending) {
      if (u.quote) await this.issue(u.quoteId, u.premiumTx, u.quote);
      else this.unissued.push(u); // needs a human: keep it
    }
    this.issuing = [];
    this.save();
  }

  /** Assesses a filed claim against the on-chain receipts it cites, and records the outcome. */
  async assessClaim(claimId: bigint, receiptTxs: string[], evidence?: ClaimEvidence): Promise<Assessment> {
    if (this.claims.has(claimId) || this.assessing.has(claimId)) throw new Error('claim already assessed');
    this.assessing.add(claimId);
    try {
      return await this.assessOnce(claimId, receiptTxs, evidence);
    } finally {
      this.assessing.delete(claimId);
    }
  }

  private async assessOnce(claimId: bigint, receiptTxs: string[], evidence?: ClaimEvidence): Promise<Assessment> {
    const c = await this.deps.cover.claim(claimId);
    if (!c) throw new Error('unknown claim');
    const p = await this.deps.cover.policy(c.policyId);
    if (!p) throw new Error('unknown policy');
    const e = await this.deps.mandateEntry(p.mandate.owner, p.mandate.id);
    const receipts = [];
    const recorderOf = new Map<string, string>(); // order -> account that recorded its receipt
    for (const tx of receiptTxs.slice(0, 4)) {
      const r = await this.deps.registryEvents(tx);
      for (const ev of r?.events ?? []) {
        if (ev.type !== 'Receipt') continue;
        if (r!.sender) recorderOf.set(ev.order + ev.paymentTx, r!.sender);
        // Per-order cover: the shop records sha256(orderRef + payment tx) as the receipt order.
        const matchesOrderRef = typeof p.kind === 'object' ? ev.order === await sha256Hex(p.kind.order + ev.paymentTx) : undefined;
        receipts.push({ order: ev.order, amount: ev.amount, at: r!.at, mandateId: ev.id, owner: ev.owner, paymentTx: ev.paymentTx, matchesOrderRef });
      }
    }
    // No double cover: orders paid, approved or still open under ANY policy of the same mandate.
    const paidOrders = [...this.claims.values()].filter((x) => x.mandateId === p.mandate.id && x.verdict !== 'rejected' && (x.paid || x.verdict === 'approved' || x.assessment.ok)).flatMap((x) => x.orders);
    // fails closed: if another insurer's book cannot be read, the claim is not assessed now (retried later)
    if (this.deps.otherInsurersOrders) paidOrders.push(...await this.deps.otherInsurersOrders());
    // The off-chain evidence counts only if it is exactly what the claimant committed to on-chain.
    const knownCode = !!evidence && Object.hasOwn(REASON_CODES, evidence.reason);
    const ev = evidence && knownCode && (await evidenceHash(evidence).catch(() => '')) === c.evidence ? evidence : undefined;
    const delivery = [];
    for (const d of ev?.delivery?.slice(0, 2) ?? []) {
      const signer = recorderOf.get(d.note.order + d.note.paymentTx);
      if (signer && this.deps.verifyDelivery && await this.deps.verifyDelivery(d, signer).catch(() => false)) delivery.push(d.note);
    }
    const local = this.policies.find((x) => x.premiumTx === p.premiumTx);
    const a = assess({
      reason: ev?.reason, delivery, intentSkus: local?.skus,
      claim: { kind: c.kind, amount: c.amount, orders: c.orders },
      policy: { validFromMs: Number(p.validFromMs), validUntilMs: Number(p.validUntilMs), limit: p.limit, paidOut: p.paidOut, deductible: p.deductible, mandateId: p.mandate.id, owner: p.mandate.owner, orderRef: typeof p.kind === 'object' ? p.kind.order : undefined },
      receipts, priorPaidOrders: paidOrders, incidentFiled: (e?.incidents ?? 0n) > 0n,
    });
    await this.deps.cover.assess(claimId, a.ok, await sha256Hex(a.reason), this.deps.operator);
    const rec: ClaimRecord = {
      claimId, policyId: c.policyId, reason: ev?.reason, ...(ev ? { evidenceDoc: ev } : {}), compelling: this.compellingEvidence(e, p.mandate.id, c.orders, ev?.reason), holder: p.holder, claimant: c.claimant, recipient: c.kind === 'MerchantLoss' ? c.claimant : p.agentPayer,
      assessment: a, receiptTxs, orders: c.orders, mandateId: p.mandate.id,
      // any earlier claim on these orders that was not approved (rejected, failed or still undecided) makes this a re-filing: a human decides
      appealOf: [...this.claims.values()].find((x) => x.verdict !== 'approved' && !x.paid && x.mandateId === p.mandate.id && x.orders.some((o) => c.orders.includes(o)))?.claimId,
    };
    const limit = this.deps.autoPayLimit;
    // Automatic only where the chain proves the loss: not for appeals, not for wrong items, not for
    // outside-intent orders (the goods were delivered: a human checks they are returned).
    const pol = this.policies.find((x) => x.policyId === c.policyId);
    const within = (v?: bigint) => v === undefined || a.payout <= v;
    if (a.ok && limit !== undefined && a.payout <= limit && within(pol?.terms?.autoPayLimit) && within(pol?.maxAutoPay) && !this.flagged(rec) && rec.appealOf === undefined && c.kind !== 'WrongItem' && ev?.reason !== 'AM20') rec.autoPayAt = this.deps.now() + (this.deps.autoPayDelayMs ?? 120_000);
    this.claims.set(claimId, rec);
    for (const d of this.detections) if (d.status === 'open' && d.orders.every((o) => c.orders.includes(o))) Object.assign(d, { status: 'filed', claimId });
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

  /**
   * Parametric monitoring. Feed it every kuasa-registry receipt as blocks finalize. A duplicate pair
   * on an agent with live period cover becomes a detection the agent can file with one call (the
   * contract only accepts claims signed by a party to the policy), and trips the circuit breaker: the
   * agent's purchases are paused at every guard that honours insurer holds until the owner resumes.
   */
  async onReceipts(seen: SeenReceipt[]): Promise<Detection[]> {
    const now = Math.max(this.deps.now(), ...seen.map((r) => r.at));
    const known = new Set(this.recent.map((r) => r.receiptTx + r.order));
    this.recent = [...this.recent, ...seen.filter((r) => !known.has(r.receiptTx + r.order))]
      .filter((r) => now - r.at <= 2 * DUPLICATE_WINDOW_MS && r.at > (this.confirmedBefore.get(r.mandateId) ?? 0));
    const used = new Set([...this.detections.flatMap((d) => d.orders), ...[...this.claims.values()].flatMap((c) => c.orders)]);
    const found: Detection[] = [];
    for (const d of findDuplicates(this.recent, used)) {
      const e = await this.deps.mandateEntry(d.owner, d.mandateId).catch(() => null);
      const v = e && this.deps.coverOf ? await this.deps.coverOf(e.payer).catch(() => null) : null;
      if (!e || !v || v.policyId === null || v.periodRemaining <= 0n) continue; // not insured with us
      const det: Detection = { ...d, payer: e.payer, policyId: v.policyId, status: 'open' };
      this.detections.push(det);
      found.push(det);
      if (!this.holds.has(e.payer)) this.holds.set(e.payer, { reason: 'duplicate-orders', at: this.deps.now() });
    }
    if (found.length) { this.save(); await this.publishHolds(); }
    for (const d of found) await this.fileDetected(d);
    return found;
  }

  /** Publishes holds not yet on-chain (a failed publication is retried on the next call). */
  async publishHolds() {
    for (const [payer, h] of this.holds) {
      if (h.published || !this.deps.hold) continue;
      try { await this.deps.hold(payer, h.reason); h.published = true; this.save(); } catch { /* next round */ }
    }
  }

  detectionsOf = (payer: string) => this.detections.filter((d) => d.payer === payer);
  holdOf = (payer: string) => this.holds.get(payer) ?? null;

  /** The owner resumed the agent: lift the hold. */
  async clearHold(payer: string) {
    if (!this.holds.has(payer)) return false;
    await this.deps.unhold?.(payer);
    this.holds.delete(payer);
    // Resuming confirms what the agent bought so far: those receipts never trip the breaker again.
    const now = this.deps.now();
    for (const d of this.detections.filter((x) => x.payer === payer)) {
      this.confirmedBefore.set(d.mandateId, now);
      if (d.status === 'open') d.status = 'dismissed';
    }
    this.recent = this.recent.filter((r) => r.at > (this.confirmedBefore.get(r.mandateId) ?? 0));
    this.save();
    return true;
  }

  /**
   * v3 per-policy terms: anchor the owner-signed AP2 intent on the policy, and halve the automatic
   * payout limit for agents with incidents. Only set when there is something to tighten.
   */
  private async setTerms(policyId: bigint, q: StoredQuote) {
    if (!this.deps.cover.setTerms) return;
    const rec = this.policies.find((p) => p.policyId === policyId);
    const limit = this.deps.autoPayLimit ?? 0n;
    const risky = q.factors.some((f) => f.name === 'incidents');
    const intent = q.ownerSignedIntent && q.request.ap2 ? await sha256Hex(canonicalJson(q.request.ap2)) : null;
    const chosen = q.request.maxAutoPay;
    if (!rec || (!intent && !risky && chosen === undefined)) return;
    let auto = risky ? limit / 2n : limit;
    if (chosen !== undefined && chosen < auto) auto = chosen; // the buyer's choice only ever tightens
    const t = { autoPayLimit: auto, objectionWindowMs: BigInt(this.deps.autoPayDelayMs ?? 120_000), intent };
    try {
      rec.terms = { ...t, tx: (await this.deps.cover.setTerms(policyId, t)).hash };
    } catch (e) {
      rec.terms = { ...t, error: (e as Error).message };
    }
    this.save();
  }

  /** v3: file a detection on the agent's behalf and assess it at once (fully parametric). */
  private async fileDetected(d: Detection) {
    if (!this.deps.cover.fileClaimFor) return;
    const evidence: ClaimEvidence = { v: 2, reason: 'AM10', paymentTxs: [...d.paymentTxs], note: 'detected on-chain and filed by the insurer' };
    try {
      const r = await this.deps.cover.fileClaimFor({ policyId: d.policyId, kind: 'AgentMistake', amount: d.amount, evidence: await evidenceHash(evidence), orders: [...d.orders] });
      if (r.id === null) throw new Error(`claim id missing in tx ${r.hash}`);
      d.filedBy = 'insurer';
      d.fileTx = r.hash;
      await this.assessClaim(r.id, [...d.receiptTxs], evidence);
    } catch (e) {
      d.fileError = (e as Error).message; // the agent can still file it (claimDetected)
      this.save();
    }
  }

  /**
   * Giveback: a policy that ended (expired, not cancelled) without any claim returns a share of
   * its premium to the agent payer. Run periodically.
   */
  async givebackExpired() {
    const bps = this.deps.givebackBps;
    if (!bps) return;
    const now = this.deps.now();
    for (const rec of this.policies) {
      if (rec.giveback || rec.until > now || this.refunded(rec.policyId)) continue;
      if ([...this.claims.values()].some((c) => c.policyId === rec.policyId)) { rec.giveback = { amount: 0n }; continue; }
      const p = await this.deps.cover.policy(rec.policyId).catch(() => null);
      if (!p || p.status !== 'Active' || p.paidOut > 0n || p.premiumTx !== rec.premiumTx) continue;
      const amount = (p.premium * bps) / 10_000n;
      if (amount <= 0n) { rec.giveback = { amount: 0n }; continue; }
      rec.giveback = { amount }; // before paying: never twice
      this.save();
      try {
        rec.giveback.tx = await this.deps.pay(rec.sponsor ?? rec.payer, amount, `kuasa giveback policy ${rec.policyId}`);
      } catch {
        rec.giveback = undefined; // retried next round
      }
      this.save();
    }
  }

  /**
   * Appeals panel: a juror (an independent account named in the panel, never a party to the claim)
   * votes on an appeal; the first verdict to reach a majority of the panel decides it, exactly as a
   * human decision would (payout included). The caller has verified the juror's signature.
   */
  async panelVote(claimId: bigint, juror: string, approve: boolean) {
    const jurors = this.deps.jurors ?? [];
    const rec = this.claims.get(claimId);
    if (!jurors.includes(juror)) throw new Error('not a juror on the appeals panel');
    if (!rec) throw new Error('unknown claim');
    if (rec.appealOf === undefined) throw new Error('only appeals go to the panel');
    // escalation (UMA's DVM pattern): the panel decides an appeal once; appealing its decision goes to the insurer's human
    if (this.panelDecided(rec)) throw new Error('escalated: the panel already decided these orders; a human at the insurer decides this appeal');
    // decidedBy is set before the decision's await: a vote arriving meanwhile cannot decide (or settle) twice
    if (rec.verdict || rec.paid || rec.decidedBy) throw new Error('already decided');
    if ([rec.claimant, rec.holder, rec.recipient].includes(juror)) throw new Error('a party to the claim cannot judge it');
    rec.panel ??= [];
    if (rec.panel.some((v) => v.by === juror)) throw new Error('this juror already voted');
    const min = this.deps.jurorMinStake ?? 0n;
    if (this.deps.jurorStake && this.deps.jurorStake(juror) < min) throw new Error(`a juror needs at least ${min} of capital staked in the pool to vote`);
    rec.panel.push({ by: juror, approve, at: this.deps.now() });
    this.save();
    const need = Math.floor(jurors.length / 2) + 1;
    const yes = rec.panel.filter((v) => v.approve).length;
    const no = rec.panel.length - yes;
    if (yes < need && no < need) return { decided: false as const, yes, no, need };
    rec.decidedBy = 'panel';
    let d: Awaited<ReturnType<InsurerService['decide']>>;
    try {
      d = await this.decide(claimId, yes >= need);
    } catch (e) {
      // settle only when the panel's own verdict stands (its payout failed); a verdict from elsewhere, or none, moves no stakes
      if (rec.verdict !== (yes >= need ? 'approved' : 'rejected')) { rec.decidedBy = undefined; throw e; }
      rec.panelSettlement ??= this.settlePanel(rec.panel, yes >= need);
      this.save();
      throw e;
    }
    rec.panelSettlement ??= this.settlePanel(rec.panel, yes >= need); // once, after the decision stands
    this.save();
    return { ...d, by: 'panel' as const, approve: yes >= need, yes, no, need, settlement: rec.panelSettlement };
  }

  private compellingEvidence(e: MandateEntry | null, mandateId: string, orders: string[], reason?: string) {
    const disputed = new Set([...this.claims.values()].filter((x) => x.mandateId === mandateId).flatMap((x) => x.orders));
    for (const o of orders) disputed.add(o);
    const priorUndisputed = Math.max(0, Number(e?.receipts ?? 0n) - disputed.size);
    return { priorUndisputed, qualifies: reason === 'AM20' && priorUndisputed >= 2 };
  }

  /** Coherence: jurors against the verdict pay the penalty (capped by their stake), shared by the jurors with it. */
  private settlePanel(votes: { by: string; approve: boolean }[], verdict: boolean) {
    const penalty = this.deps.jurorPenalty ?? 0n;
    const stake = this.deps.jurorStake;
    // only staked jurors share the penalty (an unstaked juror, allowed when the minimum stake is 0, has nothing at risk)
    const winners = votes.filter((v) => v.approve === verdict && !!stake && stake(v.by) > 0n).map((v) => v.by);
    if (penalty <= 0n || !stake || !this.deps.settlePanel || winners.length === 0) return [];
    const moves: { from: string; to: string; amount: bigint }[] = [];
    for (const l of votes.filter((v) => v.approve !== verdict)) {
      const take = stake(l.by) < penalty ? stake(l.by) : penalty;
      if (take <= 0n) continue;
      const each = take / BigInt(winners.length);
      winners.forEach((w, i) => moves.push({ from: l.by, to: w, amount: i === 0 ? take - each * BigInt(winners.length - 1) : each }));
    }
    if (moves.length) this.deps.settlePanel(moves);
    return moves;
  }

  /** A juror with a vote on an appeal not yet settled: its stake stays in the pool until the panel's settlement has run. */
  jurorBusy(account: string) {
    return [...this.claims.values()].some((c) => c.appealOf !== undefined && (c.panel ?? []).some((v) => v.by === account)
      && (c.decidedBy === 'panel' ? c.panelSettlement === undefined : !c.verdict && !c.paid));
  }

  /** Some earlier claim on these orders was decided by the panel: a further appeal escalates to a human. */
  private panelDecided(rec: ClaimRecord) {
    return [...this.claims.values()].some((x) => x.claimId !== rec.claimId && x.decidedBy === 'panel' && x.orders.some((o) => rec.orders.includes(o)));
  }

  /** Appeals waiting for a decision, with the panel's votes so far. */
  openAppeals() {
    return [...this.claims.values()].filter((c) => c.appealOf !== undefined && !c.verdict && !c.paid)
      .map((c) => ({ claimId: c.claimId, appealOf: c.appealOf, assessment: c.assessment, votes: c.panel ?? [], jurors: this.deps.jurors ?? [], escalated: this.panelDecided(c) }));
  }

  /** Any party to the claim (filer, policy holder, paid account) with a rejected no-evidence claim. */
  private flagged(rec: ClaimRecord) {
    return [rec.claimant, rec.holder, rec.recipient].some((a) => (this.fraud.get(a) ?? 0) > 0);
  }

  private objectionsBy = new Map<string, number[]>();

  /**
   * Optimistic payouts can be challenged: during the objection window any party that proves control
   * of a Concordium account (signed, like the payer proof) can object. An objection moves no money;
   * it only hands the claim to a human. At most 3 objections per account per day.
   */
  async object(claimId: bigint, o: { by: string; reason: string; proof: unknown }) {
    const rec = this.claims.get(claimId);
    if (!rec || rec.autoPayAt === undefined || rec.verdict) throw new Error('no automatic payout pending for this claim');
    // Only parties to the claim: policy holder, claimant, recipient, or a recorder of the mandate (the merchant).
    const by = canonical(o.by);
    const policy = await this.deps.cover.policy(rec.policyId);
    const recorders = policy ? (await this.deps.mandateEntry(policy.mandate.owner, policy.mandate.id))?.recorders ?? [] : [];
    const parties = [rec.holder, rec.claimant, rec.recipient, ...recorders].map(canonical);
    if (!by || !parties.includes(by)) throw new Error('only a party to this claim (holder, claimant, recipient or the merchant) can object');
    if (!(await this.deps.verifyPayer(o.by, o.proof).catch(() => false))) throw new Error('objector proof required: sign with the objecting account');
    const now = this.deps.now();
    const recent = (this.objectionsBy.get(by) ?? []).filter((t) => now - t < 86_400_000);
    if (recent.length >= 3) throw new Error('too many objections from this account today');
    this.objectionsBy.set(by, [...recent, now]);
    rec.objections = [...(rec.objections ?? []), { by: o.by, reason: String(o.reason).slice(0, 280), at: now }];
    rec.autoPayAt = undefined;
    rec.held = true;
    this.save();
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
      if (this.deps.cover.autoApprove) {
        // v2: the contract itself enforces the rules (limit, window, kind, objections)
        try {
          rec.autoApproveTx = (await this.deps.cover.autoApprove(rec.claimId, this.deps.operator)).hash;
          rec.verdict = 'approved';
        } catch {
          rec.decidedBy = undefined;
          rec.autoPayAt = undefined; // refused on-chain (e.g. an objection): a human decides
          rec.held = true;
          this.save();
          continue;
        }
      }
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
        // later claims on the same orders are re-filings now: no automatic payout for them
        for (const o of this.claims.values()) if (o !== rec && o.autoPayAt !== undefined && o.orders.some((x) => rec.orders.includes(x))) { o.autoPayAt = undefined; o.appealOf ??= claimId; }
        return { decided: true as const };
      }
      if (rec.verdict === 'rejected') throw new Error('claim was rejected; it cannot be paid');
      if (!rec.assessment.ok) throw new Error('only positively assessed claims can be approved');
      if (this.refunded(rec.policyId)) {
        rec.autoPayAt = undefined;
        return { decided: true as const, reason: 'the policy was cancelled and its unused premium refunded; this claim needs a manual review' };
      }
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
      refunds: this.refunds,
      detections: this.detections,
      holds: Object.fromEntries(this.holds),
    };
  }

  /**
   * Returns the unused part of the premium when a holder cancels a policy on-chain: premium x
   * (time left / policy term), paid to the agent payer that paid it, once. A policy that already
   * paid a claim keeps its premium. Run periodically.
   */
  async refundCancelled() {
    if (this.refunding) return; // one run at a time: a refund is never paid twice
    this.refunding = true;
    try {
      await this.refundCancelledOnce();
    } finally {
      this.refunding = false;
    }
  }

  private async refundCancelledOnce() {
    for (const rec of this.policies) {
      if (this.refunded(rec.policyId)) continue;
      // Any claim on this policy that is not finally rejected keeps the premium: refund or payout, never both.
      if ([...this.claims.values()].some((c) => c.policyId === rec.policyId && c.verdict !== 'rejected')) continue;
      const p = await this.deps.cover.policy(rec.policyId);
      if (!p || p.status !== 'Cancelled' || p.paidOut > 0n) continue;
      const now = BigInt(this.deps.now());
      if (now >= p.validUntilMs || p.validUntilMs <= p.validFromMs) continue;
      const left = p.validUntilMs - (now > p.validFromMs ? now : p.validFromMs);
      const amount = (p.premium * left) / (p.validUntilMs - p.validFromMs);
      if (amount <= 0n) continue;
      // a sponsored premium goes back to whoever paid it
      const to = rec.sponsor ?? p.agentPayer;
      const entry: { policyId: bigint; to: string; amount: bigint; tx?: string } = { policyId: rec.policyId, to, amount };
      this.refunds.push(entry); // recorded before paying: a crash never pays twice (a missing tx is visible for a manual check)
      this.save();
      entry.tx = await this.deps.pay(to, amount, `kuasa cover refund policy ${rec.policyId}`);
      this.save();
    }
  }
}
