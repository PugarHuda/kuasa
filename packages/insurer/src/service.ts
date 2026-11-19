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
};

export type QuoteRequest = { mandateUrl: string; limit: bigint; days: number; order?: { ref: string; amount: bigint } };
export type StoredQuote = Quote & {
  quoteId: string; request: QuoteRequest; mandateId: string; owner: string; payer: string; token: string; expires: number;
};
type ClaimRecord = { claimId: bigint; policyId: bigint; holder: string; recipient: string; assessment: Assessment; receiptTxs: string[]; orders: string[]; paid?: string; decided?: boolean };

/**
 * Kuasa Cover insurer: prices cover from on-chain facts, issues policies after the premium is
 * paid over x402, assesses claims against on-chain receipts and pays approved claims from the
 * treasury. Every payout needs a human decision (`decide`).
 */
export class InsurerService {
  private quotes = new Map<string, StoredQuote>();
  private policies: { policyId: bigint; quoteId: string; premiumTx: string; holder: string; payer: string; limit: bigint; until: number; kind: string }[] = [];
  private unissued: { quoteId: string; premiumTx: string; error: string }[] = [];
  private claims = new Map<bigint, ClaimRecord>();
  private fraud = new Map<string, number>();
  private disclosures: { claimId: string; holder: string; hash: string }[] = [];
  private payouts: { claimId: string; to: string; amount: bigint; tx: string }[] = [];
  private premiumsIn = 0n;

  constructor(private deps: InsurerDeps) {}

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
  async issue(quoteId: string, premiumTx: string): Promise<bigint | null> {
    const q = this.quotes.get(quoteId);
    if (!q) return null;
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
        return r.id;
      } catch (e) {
        error = (e as Error).message;
        await this.sleep(1000 * (attempt + 1));
      }
    }
    this.unissued.push({ quoteId, premiumTx, error });
    return null;
  }

  async retryUnissued() {
    const pending = this.unissued.splice(0);
    for (const u of pending) await this.issue(u.quoteId, u.premiumTx);
  }

  /** Assesses a filed claim against the on-chain receipts it cites, and records the outcome. */
  async assessClaim(claimId: bigint, receiptTxs: string[]): Promise<Assessment> {
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
      claimId, policyId: c.policyId, holder: p.holder, recipient: c.kind === 'MerchantLoss' ? c.claimant : p.agentPayer,
      assessment: a, receiptTxs, orders: c.orders,
    };
    this.claims.set(claimId, rec);

    if (a.noEvidence) {
      // Nothing on-chain backs it: reject without a payout decision, and count it against the owner.
      await this.deps.cover.decide(claimId, false, this.deps.operator);
      rec.decided = true;
      const n = (this.fraud.get(p.holder) ?? 0) + 1;
      this.fraud.set(p.holder, n);
      if (n >= FRAUD_THRESHOLD) {
        const doc = {
          type: 'kuasa-cover/lawful-disclosure-request', claimId: String(claimId), account: p.holder, agentPayer: p.agentPayer,
          rejectedClaimsWithoutEvidence: n, legalBasis: 'Suspected insurance fraud. Disclosure of the account holder identity is requested from the identity provider and Privacy Guardians via court order.',
          at: new Date(this.deps.now()).toISOString(),
        };
        const hash = await this.deps.saveDisclosure(doc);
        await this.deps.cover.markFraud(claimId, hash, this.deps.operator);
        this.disclosures.push({ claimId: String(claimId), holder: p.holder, hash });
      }
    }
    return a;
  }

  /** The human claims handler's decision. Approval pays only if the pool can cover it. */
  async decide(claimId: bigint, approve: boolean): Promise<{ decided: true; paid?: string; reason?: string }> {
    const rec = this.claims.get(claimId);
    if (!rec) throw new Error('claim not assessed yet');
    if (!approve) {
      await this.deps.cover.decide(claimId, false, this.deps.operator);
      rec.decided = true;
      return { decided: true };
    }
    if (!rec.assessment.ok) throw new Error('only positively assessed claims can be approved');
    if (!rec.decided) {
      await this.deps.cover.decide(claimId, true, this.deps.operator);
      rec.decided = true;
    }
    return this.pay(rec);
  }

  /** Pays an approved claim (also used to retry when the pool was short). */
  async pay(rec: ClaimRecord): Promise<{ decided: true; paid?: string; reason?: string }> {
    if (rec.paid) return { decided: true, paid: rec.paid };
    const amount = rec.assessment.payout;
    if ((await this.deps.treasuryBalance()) < amount) return { decided: true, reason: 'insufficient pool: approved, payout pending' };
    const tx = await this.deps.pay(rec.recipient, amount, `kuasa-claim:${rec.claimId}`);
    await this.deps.cover.recordPayout(rec.claimId, tx, amount, this.deps.operator);
    rec.paid = tx;
    this.payouts.push({ claimId: String(rec.claimId), to: rec.recipient, amount, tx });
    return { decided: true, paid: tx };
  }

  claimRecord = (id: bigint) => this.claims.get(id);

  state() {
    return {
      policies: this.policies,
      unissued: this.unissued,
      claims: [...this.claims.values()],
      payouts: this.payouts,
      premiumsIn: this.premiumsIn,
      disclosures: this.disclosures,
      fraudCounts: Object.fromEntries(this.fraud),
    };
  }
}
