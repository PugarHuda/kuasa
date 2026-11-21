import type { ConcordiumGRPCClient, Network } from '@concordium/web-sdk';
import type { KuasaRegistry, Wallet } from '@kuasa/chain';
import { authorize, canonicalJson, type Decision, type Mandate, MandateSchema, mandateId, type Requirements, sha256Hex } from '@kuasa/core';
import {
  type AgentRegistry, type CoverCheck, type IdentitySource, MandateProofIdentity, MandateRegistrySpend, type SpendControl,
} from './foundations.js';
import type { verifyMandateProof } from './proof.js';
import { safeFetchText } from './safe-fetch.js';

/** Header an agent sends with every request: the URL of its mandate document. */
export const MANDATE_HEADER = 'x-kuasa-mandate';
/** Optional header binding a payment to an order reference issued by the shop's free quote. */
export const ORDER_HEADER = 'x-kuasa-order';

/** What a merchant sells on a route and what the buyer must prove (and be insured for) to buy it. */
export type Offer = { category: string; requirements: Requirements & { minCover?: bigint } };

type Payload = { signedTransaction?: { header?: { sender?: string; nonce?: number | string } } };
type InFlight = { id: string; owner: string; payer: string; route: string; amount: bigint; orderRef?: string; coverHeld: bigint; intent?: OrderIntent };
type CoverNeed = { available: bigint; needed: bigint; viaOrder: boolean };
type OrderIntent = { payer: string; payTo: string; route: string; amount: bigint; expires: number };

const ORDER_TTL_MS = 10 * 60_000;

/** One payment = one signed transaction: sender + nonce is unique and replay-safe. */
const paymentKey = (payload: unknown) => {
  const h = (payload as Payload)?.signedTransaction?.header;
  return { payer: h?.sender ?? '', key: `${h?.sender ?? ''}:${h?.nonce ?? ''}` };
};

/**
 * Kuasa merchant guard. Plug into an x402 resource server:
 *
 *   server.onBeforeVerify(guard.beforeVerify)
 *         .onAfterSettle(guard.afterSettle)
 *         .onSettleFailure(guard.settleFailed)
 *
 * Before the facilitator sponsors a payment, the guard checks (a) who is behind the paying
 * agent and that its CIS-8004 registry entry is active and owned by that principal, (b) that the
 * purchase is inside the agent's mandate, (c) that the principal may legally buy it and (d) that
 * the purchase is insured when the offer requires cover. In-flight purchases reserve budget so
 * parallel requests cannot overspend. After settlement it records the receipt on-chain.
 */
export class KuasaGuard {
  private inFlight = new Map<string, InFlight>();
  private orders = new Map<string, OrderIntent>();
  private identity: IdentitySource;
  private spend: SpendControl;
  readonly log: { at: number; mandate?: string; payer?: string; amount?: string; decision: Decision }[] = [];
  readonly receipts: { mandate: string; order: string; orderRef?: string; paymentTx: string; receiptTx: string; amount: string; payer?: string; route?: string; at?: number; /** what was packed (fulfilment scan), when it differs from `route` */ shipped?: string }[] = [];
  /** Settled payments whose receipt could not be recorded; reconcile manually. */
  readonly unrecorded: { mandate: string; paymentTx: string; amount: string; error: string }[] = [];

  constructor(private opts: {
    grpc: ConcordiumGRPCClient;
    network: Network;
    registry: Pick<KuasaRegistry, 'view' | 'recordReceipt'>;
    /** x402 route path pattern (e.g. "/wine/:sku") -> offer. */
    offers: Record<string, Offer>;
    /** Account that records receipts; must be listed as a recorder in the mandate. */
    recorder: Wallet;
    /** Dev only: the single local origin (e.g. http://localhost:4021) allowed without https. */
    localOrigin?: string;
    fetchText?: (url: string) => Promise<string>;
    now?: () => number;
    /** Injectable for tests; defaults to full on-chain re-verification. */
    verifyProof?: typeof verifyMandateProof;
    /** Swappable foundations (default: Kuasa's own stand-ins). */
    identity?: IdentitySource;
    spend?: SpendControl;
    /** CIS-8004 registry check of the buying agent (recommended). */
    agents?: AgentRegistry;
    /** Kuasa Cover check, required for offers with `minCover`. */
    cover?: CoverCheck;
    /** Insurer circuit breaker: the hold on this payer ("hold;reason=..."), or null. Honoured on every offer. */
    holdOf?: (payer: string) => Promise<string | null>;
    /** Upper bound on live order references (oldest evicted first). */
    maxOrders?: number;
    /** Upper bound per payer, so one payer can only evict its own references. */
    maxOrdersPerPayer?: number;
  }) {
    this.identity = opts.identity ?? new MandateProofIdentity({ grpc: opts.grpc, network: opts.network, fetchText: this.fetchText, verify: opts.verifyProof, now: opts.now });
    this.spend = opts.spend ?? new MandateRegistrySpend(opts.registry);
  }

  private fetchText = (url: string) =>
    this.opts.fetchText ? this.opts.fetchText(url) : safeFetchText(url, { localOrigin: this.opts.localOrigin });

  private now = () => this.opts.now?.() ?? Date.now();

  /** Period cover held by this payer's purchases still settling. */
  private reservedCover(payer: string) {
    let sum = 0n;
    for (const f of this.inFlight.values()) if (f.payer === payer) sum += f.coverHeld;
    return sum;
  }

  private reserved(id: string) {
    let sum = 0n;
    for (const f of this.inFlight.values()) if (f.id === id) sum += f.amount;
    return sum;
  }

  /** Issues a single-use order reference (10 min) that a payment can be bound to via ORDER_HEADER. */
  async issueOrderRef(o: { payer: string; payTo: string; route: string; amount: bigint }): Promise<string> {
    for (const [k, v] of this.orders) if (v.expires < this.now()) this.orders.delete(k);
    // Anyone can quote "as" a public payer, so at a cap new references are refused and existing
    // ones are never evicted (they expire after 10 minutes).
    const mine = [...this.orders.values()].filter((v) => v.payer === o.payer).length;
    if (mine >= (this.opts.maxOrdersPerPayer ?? 20) || this.orders.size >= (this.opts.maxOrders ?? 10_000)) {
      throw new Error('too many open order references; try again in a few minutes');
    }
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
    const ref = await sha256Hex(canonicalJson({ ...o, amount: String(o.amount), nonce }));
    this.orders.set(ref, { ...o, expires: this.now() + ORDER_TTL_MS });
    return ref;
  }

  orderRefCount = (payer: string) => [...this.orders.values()].filter((v) => v.payer === payer).length;

  /** Full decision for a would-be purchase. Also backs a free "quote" endpoint. */
  async decide(args: { mandateUrl?: string; route: string; payer: string; payTo: string; asset: string; amount: bigint; orderRef?: string }): Promise<Decision & { mandateId?: string; owner?: string; budget?: { spent: bigint; maxTotal: bigint }; cover?: CoverNeed }> {
    const offer = this.opts.offers[args.route];
    if (!offer) return { ok: false, reasons: [`no Kuasa offer for route ${args.route}`] };
    if (!args.mandateUrl) return { ok: false, reasons: ['no mandate presented (x-kuasa-mandate header)'] };

    let mandate: Mandate;
    try {
      mandate = MandateSchema.parse(JSON.parse(await this.fetchText(args.mandateUrl)));
    } catch {
      return { ok: false, reasons: ['mandate document unavailable or invalid'] };
    }
    const id = await mandateId(mandate);
    const [proof, state] = await Promise.all([this.identity.claims(mandate, id), this.spend.state(mandate, id)]);
    if (!proof.ok) return { ok: false, reasons: [proof.reason], mandateId: id };

    const budget = state ? { spent: state.spent, maxTotal: state.maxTotal } : undefined;
    if (state) state.spent += this.reserved(id); // budget held by purchases still settling
    const decision = authorize({
      mandate, docSha256: id, state, claims: proof.claims, requirements: offer.requirements,
      order: { payer: args.payer, merchant: args.payTo, asset: args.asset, amount: args.amount, category: offer.category, now: Math.floor(this.now() / 1000) },
    });
    const reasons = decision.ok ? [] : [...decision.reasons];
    if (decision.ok && state && !state.recorders.includes(this.opts.recorder.address.address)) {
      reasons.push('mandate does not authorise this merchant to record receipts');
    }
    const cover = await this.coverCheck(offer, args);
    reasons.push(...await this.agentReasons(mandate), ...cover.reasons, ...await this.holdReasons(args.payer));
    const base = { mandateId: id, owner: mandate.principal.account, budget, cover: cover.need };
    return reasons.length ? { ok: false, reasons, ...base } : { ok: true, ...base };
  }

  private async holdReasons(payer: string): Promise<string[]> {
    if (!this.opts.holdOf) return [];
    const h = await this.opts.holdOf(payer).catch(() => undefined);
    if (h === undefined) return ['insurer hold check unavailable'];
    return h?.startsWith('hold') ? [`purchases paused by the insurer (${h.split(';')[1] ?? 'hold'}): the owner must resume this agent`] : [];
  }

  private async agentReasons(m: Mandate): Promise<string[]> {
    if (!this.opts.agents) return [];
    const a = await this.opts.agents.agentOf(m.agent.registry.tokenId).catch(() => undefined);
    if (a === undefined) return ['agent registry unavailable'];
    if (a === null) return ['agent not registered in the agent registry'];
    const out: string[] = [];
    if (!a.active) out.push('agent token not active in the agent registry');
    if (a.owner !== m.principal.account) out.push('agent token not owned by the principal');
    return out;
  }

  /**
   * Order-specific cover is used when it covers the order on its own; otherwise period cover,
   * minus what this payer's in-flight purchases already hold.
   */
  private async coverCheck(offer: Offer, args: { payer: string; amount: bigint; orderRef?: string }): Promise<{ reasons: string[]; need?: CoverNeed }> {
    const min = offer.requirements.minCover;
    if (min === undefined) return { reasons: [] };
    if (!this.opts.cover) return { reasons: ['cover required but no cover check configured'] };
    const v = await this.opts.cover.coverOf(args.payer, args.orderRef).catch(() => null);
    if (!v) return { reasons: ['cover check unavailable'] };
    const needed = args.amount > min ? args.amount : min;
    const need: CoverNeed = v.orderLimit >= needed
      ? { available: v.orderLimit, needed, viaOrder: true }
      : { available: v.periodRemaining, needed, viaOrder: false };
    const free = need.viaOrder ? need.available : need.available - this.reservedCover(args.payer);
    return free < needed ? { reasons: [`cover required: ${needed} needed, ${free} available (Kuasa Cover)`], need } : { reasons: [], need };
  }

  /** x402 `onBeforeVerify`: abort before any funds move if the mandate says no. */
  beforeVerify = async (ctx: { paymentPayload: { payload: unknown }; requirements: { payTo: string; asset: string; amount: string }; transportContext?: unknown }) => {
    const req = (ctx.transportContext as { request?: { adapter?: { getHeader(n: string): string | undefined }; routePattern?: string; method?: string; path?: string } })?.request;
    const { payer, key } = paymentKey(ctx.paymentPayload.payload);
    if (this.inFlight.has(key)) return { abort: true as const, reason: 'kuasa_duplicate_payment', message: 'payment already in flight' };
    const route = req?.routePattern ?? `${req?.method} ${req?.path}`;
    const amount = BigInt(ctx.requirements.amount);
    const orderRef = req?.adapter?.getHeader(ORDER_HEADER) || undefined;
    const intent = orderRef ? this.orders.get(orderRef) : undefined;
    if (orderRef) {
      const o = intent;
      if (!o || o.expires < this.now() || o.payer !== payer || o.payTo !== ctx.requirements.payTo || o.route !== route || o.amount !== amount) {
        return { abort: true as const, reason: 'kuasa_mandate_rejected', message: 'unknown or expired order reference' };
      }
      this.orders.delete(orderRef); // consume before any await: one reference backs one payment
    }
    const reject = (message: string) => {
      if (orderRef && intent) this.orders.set(orderRef, intent); // give it back on refusal
      return { abort: true as const, reason: 'kuasa_mandate_rejected', message };
    };
    const decision = await this.decide({ mandateUrl: req?.adapter?.getHeader(MANDATE_HEADER), route, payer, payTo: ctx.requirements.payTo, asset: ctx.requirements.asset, amount, orderRef });
    this.log.push({ at: this.now(), mandate: decision.mandateId, payer, amount: ctx.requirements.amount, decision });
    if (!decision.ok) return reject(decision.reasons.join('; '));
    // decide() awaited I/O, so other purchases may have reserved meanwhile. This check and the
    // reservation below run with no await in between, so they are atomic on the event loop.
    const b = decision.budget!;
    if (b.spent + this.reserved(decision.mandateId!) + amount > b.maxTotal) return reject('amount exceeds remaining mandate budget');
    const c = decision.cover;
    if (c && !c.viaOrder && c.available - this.reservedCover(payer) < c.needed) return reject('cover required: period cover is held by purchases still settling');
    this.inFlight.set(key, { id: decision.mandateId!, owner: decision.owner!, payer, route, amount, orderRef, intent, coverHeld: c && !c.viaOrder ? amount : 0n });
  };

  private release(payload: unknown, restoreOrder: boolean) {
    const key = paymentKey(payload).key;
    const f = this.inFlight.get(key);
    if (restoreOrder && f?.orderRef && f.intent && !this.orders.has(f.orderRef) && f.intent.expires > this.now()) this.orders.set(f.orderRef, f.intent);
    this.inFlight.delete(key);
  }
  /**
   * x402 `onSettleFailure`: release the reservation. The order reference stays used up: a settle
   * failure can come after the transaction was broadcast, and one reference must back one payment.
   */
  settleFailed = async (ctx: { paymentPayload: { payload: unknown } }) => this.release(ctx.paymentPayload.payload, false);
  /** x402 `onVerifyFailure` (verification threw, e.g. the facilitator was unreachable): nothing was broadcast, so the order reference is usable again. */
  verifyFailed = async (ctx: { paymentPayload: { payload: unknown } }) => this.release(ctx.paymentPayload.payload, true);
  /** x402 `onVerifiedPaymentCanceled`: canceled before settlement, so nothing was broadcast. */
  verifiedCanceled = this.verifyFailed;
  /** x402 `onAfterVerify`: release when the facilitator found the payment invalid (never broadcast). */
  afterVerify = async (ctx: { paymentPayload: { payload: unknown }; result: { isValid: boolean } }) => {
    if (!ctx.result.isValid) await this.verifyFailed(ctx);
  };

  /** x402 `onAfterSettle`: anchor the receipt and draw down the on-chain budget. */
  afterSettle = async (ctx: { paymentPayload: { payload: unknown }; requirements: { payTo: string; asset: string; amount: string }; result: { transaction: string; success?: boolean } }) => {
    const { payer, key } = paymentKey(ctx.paymentPayload.payload);
    const f = this.inFlight.get(key);
    if (!f) return;
    if (ctx.result.success === false) { this.inFlight.delete(key); return; }
    // With an order reference the receipt binds it, so cover bought for that order matches the receipt.
    const order = f.orderRef
      ? await sha256Hex(f.orderRef + ctx.result.transaction)
      : await sha256Hex(canonicalJson({ ...ctx.requirements, route: f.route, payer, tx: ctx.result.transaction }));
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rec = await this.opts.registry.recordReceipt(f.owner, f.id, order, ctx.result.transaction, f.amount, this.opts.recorder);
        this.receipts.push({ mandate: f.id, order, orderRef: f.orderRef, paymentTx: ctx.result.transaction, receiptTx: rec.hash, amount: ctx.requirements.amount, payer, route: f.route, at: Date.now() });
        this.inFlight.delete(key);
        return;
      } catch (e) {
        lastError = (e as Error).message;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    // Keep the reservation: money moved but the budget was not drawn down on-chain yet.
    this.unrecorded.push({ mandate: f.id, paymentTx: ctx.result.transaction, amount: ctx.requirements.amount, error: lastError });
  };
}
