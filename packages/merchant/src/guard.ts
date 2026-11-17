import type { ConcordiumGRPCClient, Network } from '@concordium/web-sdk';
import type { KuasaRegistry, Wallet } from '@kuasa/chain';
import {
  authorize, canonicalJson, type Claims, type Decision, type Mandate, MandateSchema, mandateId, type Requirements,
  sha256Hex, toMandateState,
} from '@kuasa/core';
import { verifyMandateProof } from './proof.js';

/** Header an agent sends with every request: the URL of its mandate document. */
export const MANDATE_HEADER = 'x-kuasa-mandate';

/** What a merchant sells on a route and what the buyer must prove to buy it. */
export type Offer = { category: string; requirements: Requirements };

type Loaded = { mandate: Mandate; id: string; claims: Claims };

/**
 * Kuasa merchant guard. Plug into an x402 resource server:
 *
 *   server.onBeforeVerify(guard.beforeVerify).onAfterSettle(guard.afterSettle)
 *
 * Before the facilitator sponsors a payment, the guard proves (a) who is behind the paying
 * agent, (b) that this purchase is inside the agent's mandate and (c) that the principal is
 * legally allowed to buy it. After settlement it records the receipt on-chain, which also
 * draws down the mandate budget atomically.
 */
export class KuasaGuard {
  private proofs = new Map<string, Promise<{ ok: true; claims: Claims } | { ok: false; reason: string }>>();
  /** Decisions are exposed for the merchant UI / logs. */
  readonly log: { at: number; mandate?: string; payer?: string; amount?: string; decision: Decision }[] = [];

  constructor(private opts: {
    grpc: ConcordiumGRPCClient;
    network: Network;
    registry: KuasaRegistry;
    /** Route pattern (e.g. "GET /wine/:sku") → offer. */
    offers: Record<string, Offer>;
    /** Account that records receipts; must be listed as a recorder in the mandate. */
    recorder: Wallet;
    fetchText?: (url: string) => Promise<string>;
    now?: () => number;
    /** Injectable for tests; defaults to full on-chain re-verification. */
    verifyProof?: typeof verifyMandateProof;
  }) {}

  private fetchText = (url: string) =>
    (this.opts.fetchText ?? (async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`GET ${u} -> ${r.status}`);
      return r.text();
    }))(url);

  /** Loads + validates the mandate document and (cached) re-verifies its ZK proof. */
  private async load(url: string): Promise<Loaded | { error: string }> {
    let mandate: Mandate;
    try {
      mandate = MandateSchema.parse(JSON.parse(await this.fetchText(url)));
    } catch (e) {
      return { error: `invalid mandate document: ${(e as Error).message}` };
    }
    const id = await mandateId(mandate);
    if (!this.proofs.has(id)) {
      this.proofs.set(id, this.fetchText(mandate.proof.auditRecordUri)
        .then((json) => (this.opts.verifyProof ?? verifyMandateProof)({ mandate, auditRecordJson: json, grpc: this.opts.grpc, network: this.opts.network }))
        .catch((e) => ({ ok: false as const, reason: `proof unavailable: ${(e as Error).message}` })));
    }
    const proof = await this.proofs.get(id)!;
    if (!proof.ok) {
      this.proofs.delete(id); // allow retry after a transient failure
      return { error: proof.reason };
    }
    return { mandate, id, claims: proof.claims };
  }

  /** Full decision for a would-be purchase. Exposed so it can also back a free "/quote". */
  async decide(args: { mandateUrl?: string; route: string; payer: string; payTo: string; asset: string; amount: bigint }): Promise<Decision & { mandateId?: string; owner?: string }> {
    const offer = this.opts.offers[args.route];
    if (!offer) return { ok: false, reasons: [`no Kuasa offer for route ${args.route}`] };
    if (!args.mandateUrl) return { ok: false, reasons: ['no mandate presented (x-kuasa-mandate header)'] };

    const loaded = await this.load(args.mandateUrl);
    if ('error' in loaded) return { ok: false, reasons: [loaded.error] };

    const entry = await this.opts.registry.view(loaded.mandate.principal.account, loaded.id);
    const decision = authorize({
      mandate: loaded.mandate,
      docSha256: loaded.id,
      state: entry && toMandateState(entry, loaded.id),
      claims: loaded.claims,
      requirements: offer.requirements,
      order: {
        payer: args.payer, merchant: args.payTo, asset: args.asset, amount: args.amount,
        category: offer.category, now: Math.floor((this.opts.now?.() ?? Date.now()) / 1000),
      },
    });
    if (decision.ok && entry && !entry.recorders.includes(this.opts.recorder.address.address)) {
      return { ok: false, reasons: ['mandate does not authorise this merchant to record receipts'] };
    }
    return { ...decision, mandateId: loaded.id, owner: loaded.mandate.principal.account };
  }

  /** x402 `onBeforeVerify` hook: abort before any funds move if the mandate says no. */
  beforeVerify = async (ctx: {
    paymentPayload: { payload: unknown };
    requirements: { payTo: string; asset: string; amount: string };
    transportContext?: unknown;
  }) => {
    const req = (ctx.transportContext as { request?: { adapter?: { getHeader(n: string): string | undefined }; routePattern?: string; method?: string; path?: string } })?.request;
    const payer = (ctx.paymentPayload.payload as { signedTransaction?: { header?: { sender?: string } } })?.signedTransaction?.header?.sender ?? '';
    const route = req?.routePattern ?? `${req?.method} ${req?.path}`;
    const decision = await this.decide({
      mandateUrl: req?.adapter?.getHeader(MANDATE_HEADER),
      route, payer, payTo: ctx.requirements.payTo, asset: ctx.requirements.asset, amount: BigInt(ctx.requirements.amount),
    });
    this.log.push({ at: Date.now(), mandate: decision.mandateId, payer, amount: ctx.requirements.amount, decision });
    if (!decision.ok) return { abort: true as const, reason: 'kuasa_mandate_rejected', message: decision.reasons.join('; ') };
    this.pending.set(payer, { id: decision.mandateId!, owner: decision.owner!, route });
  };

  // ponytail: one in-flight purchase per payer; key by payment nonce if agents buy in parallel.
  private pending = new Map<string, { id: string; owner: string; route: string }>();

  /** x402 `onAfterSettle` hook: anchor the receipt and draw down the on-chain budget. */
  afterSettle = async (ctx: {
    paymentPayload: { payload: unknown };
    requirements: { payTo: string; asset: string; amount: string };
    result: { transaction: string; success?: boolean };
  }) => {
    const payer = (ctx.paymentPayload.payload as { signedTransaction?: { header?: { sender?: string } } })?.signedTransaction?.header?.sender ?? '';
    const p = this.pending.get(payer);
    if (!p || ctx.result.success === false) return;
    this.pending.delete(payer);
    const order = await sha256Hex(canonicalJson({ ...ctx.requirements, route: p.route, payer, tx: ctx.result.transaction }));
    const rec = await this.opts.registry.recordReceipt(p.owner, p.id, order, ctx.result.transaction, BigInt(ctx.requirements.amount), this.opts.recorder);
    this.receipts.push({ mandate: p.id, order, paymentTx: ctx.result.transaction, receiptTx: rec.hash, amount: ctx.requirements.amount });
  };

  readonly receipts: { mandate: string; order: string; paymentTx: string; receiptTx: string; amount: string }[] = [];
}
