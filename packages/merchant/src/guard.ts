import type { ConcordiumGRPCClient, Network } from '@concordium/web-sdk';
import type { KuasaRegistry, Wallet } from '@kuasa/chain';
import {
  authorize, canonicalJson, type Claims, type Decision, type Mandate, MandateSchema, mandateId, type Requirements,
  sha256Hex, toMandateState,
} from '@kuasa/core';
import { verifyMandateProof } from './proof.js';
import { safeFetchText } from './safe-fetch.js';

/** Header an agent sends with every request: the URL of its mandate document. */
export const MANDATE_HEADER = 'x-kuasa-mandate';

/** What a merchant sells on a route and what the buyer must prove to buy it. */
export type Offer = { category: string; requirements: Requirements };

type ProofResult = { ok: true; claims: Claims } | { ok: false; reason: string };
type Payload = { signedTransaction?: { header?: { sender?: string; nonce?: number | string } } };
type InFlight = { id: string; owner: string; route: string; amount: bigint };

const PROOF_TTL_MS = 5 * 60_000;
const PROOF_CACHE_MAX = 500;

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
 * agent, (b) that this purchase is inside the agent's mandate and (c) that the principal may
 * legally buy it. In-flight purchases reserve budget so parallel requests cannot overspend.
 * After settlement it records the receipt on-chain, which also draws down the budget.
 */
export class KuasaGuard {
  private proofs = new Map<string, { at: number; result: Promise<ProofResult> }>();
  private inFlight = new Map<string, InFlight>();
  readonly log: { at: number; mandate?: string; payer?: string; amount?: string; decision: Decision }[] = [];
  readonly receipts: { mandate: string; order: string; paymentTx: string; receiptTx: string; amount: string }[] = [];
  /** Settled payments whose receipt could not be recorded; reconcile manually. */
  readonly unrecorded: { mandate: string; paymentTx: string; amount: string; error: string }[] = [];

  constructor(private opts: {
    grpc: ConcordiumGRPCClient;
    network: Network;
    registry: KuasaRegistry;
    /** Route pattern (e.g. "GET /wine/:sku") -> offer. */
    offers: Record<string, Offer>;
    /** Account that records receipts; must be listed as a recorder in the mandate. */
    recorder: Wallet;
    /** Dev only: allow http://localhost mandate URLs. */
    allowHttpLocalhost?: boolean;
    fetchText?: (url: string) => Promise<string>;
    now?: () => number;
    /** Injectable for tests; defaults to full on-chain re-verification. */
    verifyProof?: typeof verifyMandateProof;
  }) {}

  private fetchText = (url: string) =>
    this.opts.fetchText ? this.opts.fetchText(url) : safeFetchText(url, { allowHttpLocalhost: this.opts.allowHttpLocalhost });

  private now = () => this.opts.now?.() ?? Date.now();

  /** Re-verifies the principal's proof at most every PROOF_TTL_MS (credentials can expire or be revoked). */
  private proofFor(id: string, mandate: Mandate): Promise<ProofResult> {
    const hit = this.proofs.get(id);
    if (hit && this.now() - hit.at < PROOF_TTL_MS) return hit.result;
    if (this.proofs.size >= PROOF_CACHE_MAX) this.proofs.delete(this.proofs.keys().next().value!);
    const result = this.fetchText(mandate.proof.auditRecordUri)
      .then((json) => (this.opts.verifyProof ?? verifyMandateProof)({ mandate, auditRecordJson: json, grpc: this.opts.grpc, network: this.opts.network }))
      .catch((e): ProofResult => ({ ok: false, reason: `proof unavailable (${(e as Error).message})` }));
    this.proofs.set(id, { at: this.now(), result });
    result.then((r) => { if (!r.ok) this.proofs.delete(id); }); // never cache failures
    return result;
  }

  private reserved(id: string) {
    let sum = 0n;
    for (const f of this.inFlight.values()) if (f.id === id) sum += f.amount;
    return sum;
  }

  /** Full decision for a would-be purchase. Also backs a free "quote" endpoint. */
  async decide(args: { mandateUrl?: string; route: string; payer: string; payTo: string; asset: string; amount: bigint }): Promise<Decision & { mandateId?: string; owner?: string; budget?: { spent: bigint; maxTotal: bigint } }> {
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
    const [proof, entry] = await Promise.all([this.proofFor(id, mandate), this.opts.registry.view(mandate.principal.account, id)]);
    if (!proof.ok) return { ok: false, reasons: [proof.reason], mandateId: id };

    const state = entry && toMandateState(entry, id);
    if (state) state.spent += this.reserved(id); // budget held by purchases still settling
    const decision = authorize({
      mandate, docSha256: id, state, claims: proof.claims, requirements: offer.requirements,
      order: { payer: args.payer, merchant: args.payTo, asset: args.asset, amount: args.amount, category: offer.category, now: Math.floor(this.now() / 1000) },
    });
    if (decision.ok && entry && !entry.recorders.includes(this.opts.recorder.address.address)) {
      return { ok: false, reasons: ['mandate does not authorise this merchant to record receipts'], mandateId: id };
    }
    return { ...decision, mandateId: id, owner: mandate.principal.account, budget: entry ? { spent: entry.spent, maxTotal: entry.maxTotal } : undefined };
  }

  /** x402 `onBeforeVerify`: abort before any funds move if the mandate says no. */
  beforeVerify = async (ctx: { paymentPayload: { payload: unknown }; requirements: { payTo: string; asset: string; amount: string }; transportContext?: unknown }) => {
    const req = (ctx.transportContext as { request?: { adapter?: { getHeader(n: string): string | undefined }; routePattern?: string; method?: string; path?: string } })?.request;
    const { payer, key } = paymentKey(ctx.paymentPayload.payload);
    if (this.inFlight.has(key)) return { abort: true as const, reason: 'kuasa_duplicate_payment', message: 'payment already in flight' };
    const route = req?.routePattern ?? `${req?.method} ${req?.path}`;
    const amount = BigInt(ctx.requirements.amount);
    const decision = await this.decide({ mandateUrl: req?.adapter?.getHeader(MANDATE_HEADER), route, payer, payTo: ctx.requirements.payTo, asset: ctx.requirements.asset, amount });
    this.log.push({ at: this.now(), mandate: decision.mandateId, payer, amount: ctx.requirements.amount, decision });
    if (!decision.ok) return { abort: true as const, reason: 'kuasa_mandate_rejected', message: decision.reasons.join('; ') };
    // decide() awaited I/O, so other purchases may have reserved meanwhile. This check and the
    // reservation below run with no await in between, so they are atomic on the event loop.
    const b = decision.budget!;
    if (b.spent + this.reserved(decision.mandateId!) + amount > b.maxTotal) {
      return { abort: true as const, reason: 'kuasa_mandate_rejected', message: 'amount exceeds remaining mandate budget' };
    }
    this.inFlight.set(key, { id: decision.mandateId!, owner: decision.owner!, route, amount });
  };

  /** x402 `onSettleFailure`: release the reservation. */
  settleFailed = async (ctx: { paymentPayload: { payload: unknown } }) => {
    this.inFlight.delete(paymentKey(ctx.paymentPayload.payload).key);
  };

  /** x402 `onAfterSettle`: anchor the receipt and draw down the on-chain budget. */
  afterSettle = async (ctx: { paymentPayload: { payload: unknown }; requirements: { payTo: string; asset: string; amount: string }; result: { transaction: string; success?: boolean } }) => {
    const { payer, key } = paymentKey(ctx.paymentPayload.payload);
    const f = this.inFlight.get(key);
    if (!f) return;
    if (ctx.result.success === false) { this.inFlight.delete(key); return; }
    const order = await sha256Hex(canonicalJson({ ...ctx.requirements, route: f.route, payer, tx: ctx.result.transaction }));
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rec = await this.opts.registry.recordReceipt(f.owner, f.id, order, ctx.result.transaction, f.amount, this.opts.recorder);
        this.receipts.push({ mandate: f.id, order, paymentTx: ctx.result.transaction, receiptTx: rec.hash, amount: ctx.requirements.amount });
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
