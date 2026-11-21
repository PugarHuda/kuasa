/**
 * Kuasa buyer agent: pays over x402 from its own payer account and presents its mandate
 * (x-kuasa-mandate header) on every request. Checks the shop's free /quote first so it never
 * signs a payment the merchant is going to refuse, and so it can explain *why* it cannot buy.
 *
 * Kuasa Cover: the agent can insure itself (period cover or per-order cover, paid over x402 to the
 * insurer) and file claims, signed by its own payer account and sponsored by the insurer.
 */
import { readFileSync } from 'node:fs';
import { AccountAddress, buildBasicAccountSigner, CcdAmount, ContractAddress, Energy, Parameter, ReceiveName, TransactionExpiry } from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { CONCORDIUM_TESTNET_CAIP2 } from '@x402/concordium';
import { ExactConcordiumScheme } from '@x402/concordium/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { connect } from '@kuasa/chain';
import { type ClaimEvidence, type ClaimKind, defaultReason, encodeFileClaim, evidenceHash, REASON_CODES, type ReasonCode, type SignedDeliveryNote } from '@kuasa/core';
import { type AgentRegistry, Cis8004Registry, makePayerProof } from '@kuasa/merchant';

export const MANDATE_HEADER = 'x-kuasa-mandate';
export const ORDER_HEADER = 'x-kuasa-order';

export type BuyResult =
  | { ok: true; item: unknown; paymentTx?: string }
  | { ok: false; reasons: string[] };

export type Scope = { asset: string; maxPerOrder: string; merchants?: string[] };

const jsonSafe = (_k: string, v: unknown) =>
  typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const big = (v: unknown) => BigInt(String(v ?? 0));

type PayReq = { network: string; asset: string; amount: string; payTo: string };

/**
 * Payment-time policy (runs when x402 asks us to sign): the payee must be the counterparty we
 * verified for this request, and amount/asset/network/payee must fit the mandate. Fails closed.
 */
export function paymentAllowed(scope: Scope, expectedPayTo: string | undefined, r: PayReq, expectedAmount?: bigint): boolean {
  if (!expectedPayTo || r.payTo !== expectedPayTo) return false;
  if (expectedAmount !== undefined && (!/^\d+$/.test(r.amount) || BigInt(r.amount) !== expectedAmount)) return false;
  if (r.network !== CONCORDIUM_TESTNET_CAIP2) return false;
  if ((r.asset || 'CCD').toUpperCase() !== scope.asset.toUpperCase()) return false;
  if (!/^\d+$/.test(r.amount) || BigInt(r.amount) > BigInt(scope.maxPerOrder)) return false;
  return !scope.merchants?.length || scope.merchants.includes(r.payTo);
}

const TRUST_TTL_MS = 5 * 60_000;

export class KuasaAgent {
  private payFetch: typeof fetch;
  /**
   * opts.scope is the agent's own trusted copy of its mandate scope, handed over by the owner at
   * start-up and never fetched from a counterparty. Payments outside it are never signed.
   */
  private trustedShop?: { payTo: string; at: number };
  /** Each insurer's pool account, read from its /info (by origin). */
  private insurerTreasury = new Map<string, string>();
  /** The payee verified for the payment currently being made (calls are sequential). */
  private expectPayTo?: string;
  /** When paying a quote, the exact amount quoted. */
  private expectAmount?: bigint;
  /** Payments run one at a time: the expected payee/amount belong to exactly one payment. */
  private payQueue: Promise<unknown> = Promise.resolve();
  constructor(readonly opts: {
    shopUrl: string; insurerUrl?: string; mandateUrl: string; payer: string; payerKey: string; scope: Scope;
    /** Market: further insurers this agent may buy cover from (the mandate must also list their pool accounts). */
    insurers?: string[];
    /** CIS-8004 registry used to check the shop before paying it (two-way trust). */
    agents?: AgentRegistry;
    fetchJson?: (url: string) => Promise<unknown>;
  }) {
    const client = new x402Client()
      .register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumScheme({ accountAddress: AccountAddress.fromBase58(opts.payer), signer: buildBasicAccountSigner(opts.payerKey) }))
      // x402's USD caps don't understand CCD; the agent enforces its own mandate instead (below).
      .setSpendControls(false)
      .registerPolicy((_, reqs) => reqs.filter((r) => this.withinMandate(r)));
    this.payFetch = wrapFetchWithPayment(fetch, client);
  }

  /** Demo convenience: load the agent's payer account from .kuasa (testnet only). */
  static fromDemo(name: string, shopUrl = process.env.KUASA_SHOP_URL ?? 'http://localhost:4021', insurerUrl = process.env.KUASA_INSURER_URL ?? 'http://localhost:4023') {
    const root = new URL('../../../.kuasa/', import.meta.url);
    const acc = JSON.parse(readFileSync(new URL(`accounts/${name}.json`, root), 'utf8')).accounts.find((a: { credNumber: number }) => a.credNumber === 1);
    const { scope } = JSON.parse(readFileSync(new URL(`public/mandate/${name}.json`, root), 'utf8')); // owner's local copy
    // market: the other insurers set up on this testnet (state.market), if any
    const market = (JSON.parse(readFileSync(new URL('state.json', root), 'utf8')) as { market?: { url: string }[] }).market ?? [];
    return new KuasaAgent({ shopUrl, insurerUrl, mandateUrl: `${shopUrl}/kuasa/mandate/${name}.json`, payer: acc.address, payerKey: acc.key, scope, agents: new Cis8004Registry(connect()), insurers: market.map((m) => m.url) });
  }

  private get insurerUrl() { return this.opts.insurerUrl ?? 'http://localhost:4023'; }
  private get insurerUrls() { return [this.insurerUrl, ...(this.opts.insurers ?? [])]; }

  /** Never trust a 402: payee must be the verified counterparty; amount, asset and network must fit the mandate. */
  private withinMandate(r: PayReq) {
    return paymentAllowed(this.opts.scope, this.expectPayTo, r, this.expectAmount);
  }

  private headers = () => ({ [MANDATE_HEADER]: this.opts.mandateUrl });

  /** Signed proof that this agent controls its payer, for quote requests to `audience`. */
  private proof = (audience: string) => makePayerProof(this.opts.payer, buildBasicAccountSigner(this.opts.payerKey), audience);

  private fetchJson = (url: string) => (this.opts.fetchJson ? this.opts.fetchJson(url) : fetch(url).then((r) => r.json()));

  /**
   * Two-way trust: before paying the shop, check its Agent Card names a CIS-8004 agent that is
   * active and owned by the shop's payTo account. Returns a refusal reason, or null if trusted.
   */
  async verifyShop(): Promise<string | null> {
    const card = await this.fetchJson(new URL('/.well-known/agent-card.json', this.opts.shopUrl).toString()).catch(() => null) as { kuasa?: { payTo?: string; agentToken?: string } } | null;
    const k = card?.kuasa;
    if (!k?.payTo || !k.agentToken || !/^[0-9a-f]{2,64}$/.test(k.agentToken)) return 'shop agent card missing or invalid';
    if (!this.opts.agents) { this.trustedShop = { payTo: k.payTo, at: Date.now() }; return null; } // no registry configured: card only
    const a = await this.opts.agents.agentOf(k.agentToken).catch(() => undefined);
    if (a === undefined) return 'agent registry unavailable';
    if (a === null) return 'shop agent not registered in the agent registry';
    if (!a.active) return 'shop agent not active in the agent registry';
    if (a.owner !== k.payTo) return 'shop agent not owned by the account it asks us to pay';
    this.trustedShop = { payTo: k.payTo, at: Date.now() };
    return null;
  }

  /** Pays an x402 resource at a configured counterparty (shop or insurer) only. */
  private payAt(url: URL, extra: Record<string, string> = {}, expectAmount?: bigint): Promise<BuyResult> {
    const run = this.payQueue.then(() => this.payAtNow(url, extra, expectAmount));
    this.payQueue = run.catch(() => undefined);
    return run;
  }

  private async payAtNow(url: URL, extra: Record<string, string>, expectAmount?: bigint): Promise<BuyResult> {
    if (url.origin === new URL(this.opts.shopUrl).origin) {
      if (!this.trustedShop || Date.now() - this.trustedShop.at > TRUST_TTL_MS) {
        const why = await this.verifyShop();
        if (why) return { ok: false, reasons: [why] };
      }
      this.expectPayTo = this.trustedShop!.payTo;
    } else if (this.insurerUrls.some((u) => new URL(u).origin === url.origin)) {
      if (!this.insurerTreasury.has(url.origin)) {
        const t = ((await this.fetchJson(new URL('/info', url.origin).toString())) as { treasury?: string }).treasury;
        if (t) this.insurerTreasury.set(url.origin, t);
      }
      this.expectPayTo = this.insurerTreasury.get(url.origin);
    } else {
      return { ok: false, reasons: ['refusing to pay outside the configured shop and insurer'] };
    }
    this.expectAmount = expectAmount;
    let res: Response;
    try {
      res = await this.payFetch(url, { headers: { ...this.headers(), ...extra } });
    } catch (e) {
      return { ok: false, reasons: [`payment failed: ${(e as Error).message}`] };
    } finally {
      this.expectPayTo = undefined;
      this.expectAmount = undefined;
    }
    if (!res.ok) {
      const body = await res.text();
      // x402 puts the refusal reason in the base64 PAYMENT-REQUIRED header
      let why = '';
      try { why = (JSON.parse(Buffer.from(res.headers.get('payment-required') ?? '', 'base64').toString()) as { error?: string }).error ?? ''; } catch { /* not x402 */ }
      return { ok: false, reasons: [`answered ${res.status}: ${why || body.slice(0, 300)}`] };
    }
    const header = res.headers.get('payment-response');
    const settle = header ? decodePaymentResponseHeader(header) : undefined;
    return { ok: true, item: await res.json(), paymentTx: settle?.transaction };
  }

  async catalog() {
    return (await fetch(`${this.opts.shopUrl}/catalog`)).json();
  }

  async mandate() {
    return (await fetch(this.opts.mandateUrl)).json();
  }

  async quote(path: string): Promise<{ ok: boolean; reasons?: string[]; orderRef?: string; amount?: string }> {
    const u = new URL('/quote', this.opts.shopUrl);
    u.searchParams.set('path', path);
    u.searchParams.set('payer', this.opts.payer);
    return (await fetch(u, { headers: { ...this.headers(), ...(await this.proof(this.opts.shopUrl)) } })).json();
  }

  /** skipQuote: behave like a rogue agent that pays anyway; the shop must still refuse. */
  async buy(path: string, skipQuote = false, orderRef?: string): Promise<BuyResult> {
    const q = skipQuote ? { ok: true } : await this.quote(path);
    if (!q.ok) return { ok: false, reasons: q.reasons ?? ['refused'] };
    return this.payAt(new URL(path, this.opts.shopUrl), orderRef ? { [ORDER_HEADER]: orderRef } : {});
  }

  /** Demo: the agent "makes a mistake" and places the same order twice. */
  async buyTwice(path: string) {
    const first = await this.buy(path);
    const second = await this.buy(path);
    return { first, second };
  }

  // ---- Kuasa Cover ---------------------------------------------------------------------------

  /** ap2: the user's AP2 Intent Mandate, if this agent works under one (the insurer checks the mandate sits inside it). */
  /** sponsor: this client's payer pays the premium for the mandate's agent (merchant-paid cover). */
  async coverQuote(limit: bigint, days = 30, order?: { ref: string; amount: bigint }, ap2?: object, sponsor = false, at = this.insurerUrl) {
    const u = new URL('/cover/quote', at);
    if (sponsor) u.searchParams.set('sponsor', this.opts.payer);
    if (order) {
      u.searchParams.set('order', order.ref);
      u.searchParams.set('amount', String(order.amount));
    } else {
      u.searchParams.set('limit', String(limit));
      u.searchParams.set('days', String(days));
    }
    const ap2Header: Record<string, string> = ap2 ? { 'x-ap2-intent-mandate': Buffer.from(JSON.stringify(ap2)).toString('base64url') } : {};
    return (await fetch(u, { headers: { ...this.headers(), ...(await this.proof(at)), ...ap2Header } })).json() as Promise<{ quoteId?: string; premium?: string; factors?: { name: string }[]; refused?: string; payer?: string }>;
  }

  /** payer: whose cover (defaults to this agent; a sponsor checks the agent it insured). */
  async coverStatus(payer = this.opts.payer, at = this.insurerUrl) {
    const u = new URL('/cover/status', at);
    u.searchParams.set('payer', payer);
    return (await fetch(u)).json() as Promise<{ onChain: { periodRemaining: string; orderLimit: string; policyId: string | null }; policies: { policyId: string; kind: string; limit: string; until: number }[] }>;
  }

  /** Waits until the insurer has issued the policy on-chain after the premium settled. */
  private async waitForPolicy(before: number, timeoutMs = 90_000, insured = this.opts.payer, at = this.insurerUrl) {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(3000)) {
      const s = await this.coverStatus(insured, at);
      if (s.policies.length > before) return s.policies.at(-1)!;
    }
    return null;
  }

  private async buyQuote(q: { quoteId?: string; premium?: string; refused?: string; factors?: unknown[]; payer?: string }, at = this.insurerUrl) {
    if (!q.quoteId) return { ok: false as const, reasons: [q.refused ?? 'no quote'] };
    const insured = q.payer ?? this.opts.payer; // a sponsor pays, the quote's agent is insured
    const before = (await this.coverStatus(insured, at)).policies.length;
    const u = new URL('/cover/buy', at);
    u.searchParams.set('quoteId', q.quoteId);
    const paid = await this.payAt(u, {}, q.premium !== undefined ? BigInt(q.premium) : undefined);
    if (!paid.ok) return paid;
    const policy = await this.waitForPolicy(before, 90_000, insured, at);
    return policy
      ? { ok: true as const, premium: q.premium, factors: q.factors, paymentTx: paid.paymentTx, policy }
      : { ok: false as const, reasons: ['premium paid but the policy is not issued yet; the insurer retries, check cover-status'], paymentTx: paid.paymentTx };
  }

  /** This agent's recent purchases at the shop (signed request). */
  async myPayments() {
    const u = new URL(`/payments/${this.opts.payer}`, this.opts.shopUrl);
    return (await fetch(u, { headers: await this.proof(this.opts.shopUrl) })).json() as Promise<{ item: string; amount: string; paymentTx: string; at?: string }[]>;
  }

  /** Period cover (option A): insure this agent for `days` up to `limit`. */
  async coverBuy(limit: bigint, days = 30, ap2?: object) {
    return this.buyQuote(await this.coverQuote(limit, days, undefined, ap2));
  }

  /**
   * Market (Etherisc GIF / Nexus Mutual pattern): ask every insurer this agent may use for the same cover
   * and compare. Each answer is that insurer's own quote, priced over the shared risk model.
   */
  async marketQuotes(limit: bigint, days = 30) {
    return Promise.all(this.insurerUrls.map(async (at) => ({ at, quote: await this.coverQuote(limit, days, undefined, undefined, false, at).catch((e) => ({ refused: (e as Error).message } as { refused: string; premium?: string; quoteId?: string })) })));
  }

  /** Buys period cover from the cheapest insurer that offers it (refusals, e.g. no capacity, are skipped). */
  async coverBuyBest(limit: bigint, days = 30) {
    const offers = await this.marketQuotes(limit, days);
    const best = offers.filter((o) => o.quote.quoteId && o.quote.premium !== undefined).sort((a, b) => (BigInt(a.quote.premium!) < BigInt(b.quote.premium!) ? -1 : 1))[0];
    if (!best) return { ok: false as const, reasons: offers.map((o) => `${o.at}: ${o.quote.refused ?? 'no quote'}`), offers };
    return { ...(await this.buyQuote(best.quote, best.at)), insurer: best.at, offers };
  }

  /**
   * Syndicated cover (Nexus Mutual v2 capacity allocation, Lloyd's following market): when no single
   * insurer can carry the whole limit, split it. Each insurer's free capacity (pool minus live limits,
   * from its public /solvency) is filled cheapest first, per unit of cover; each share is that insurer's
   * own policy, and the shop adds them up. Stops at the first failed purchase (shares bought stay bought).
   */
  async coverBuySyndicated(limit: bigint, days = 30) {
    const offers: { at: string; free: bigint; unit: number }[] = [];
    for (const at of this.insurerUrls) {
      const s = await (await fetch(new URL('/solvency', at))).json().catch(() => null) as { pool?: string; exposure?: string } | null;
      if (!s?.pool || !s.exposure) continue;
      const free = BigInt(s.pool) - BigInt(s.exposure);
      if (free <= 0n) continue;
      const probe = free < limit ? free : limit;
      const q = await this.coverQuote(probe, days, undefined, undefined, false, at).catch(() => null);
      if (q?.premium) offers.push({ at, free, unit: Number(q.premium) / Number(probe) });
    }
    offers.sort((a, b) => a.unit - b.unit);
    let rest = limit;
    const legs: { at: string; limit: bigint; ok: boolean; premium?: string; policyId?: string; paymentTx?: string; reasons?: string[] }[] = [];
    for (const o of offers) {
      if (rest <= 0n) break;
      const take = o.free < rest ? o.free : rest;
      const r = await this.buyQuote(await this.coverQuote(take, days, undefined, undefined, false, o.at), o.at);
      legs.push({ at: o.at, limit: take, ok: r.ok, premium: (r as { premium?: string }).premium, policyId: (r as { policy?: { policyId: string } }).policy?.policyId, paymentTx: (r as { paymentTx?: string }).paymentTx, reasons: (r as { reasons?: string[] }).reasons });
      if (!r.ok) break;
      rest -= take;
    }
    return { ok: rest === 0n, covered: limit - rest, legs };
  }

  /** Merchant-paid cover: buy per-order cover for another agent's order (this client pays, that agent is insured). */
  async sponsorOrderCover(order: { ref: string; amount: bigint }) {
    return this.buyQuote(await this.coverQuote(0n, 1, order, undefined, true));
  }

  /** Per-order cover (option B): quote the order at the shop, insure exactly it, then buy with the order reference. */
  async buyCovered(path: string) {
    const q = await this.quote(path);
    if (!q.orderRef || !q.amount) return { ok: false as const, reasons: q.reasons ?? ['shop gave no order reference'] };
    const cover = await this.buyQuote(await this.coverQuote(0n, 1, { ref: q.orderRef, amount: big(q.amount) }));
    if (!cover.ok) return cover;
    return { cover, purchase: await this.buy(path, true, q.orderRef) };
  }

  /** The shop's on-chain receipt for one of our payments (it is recorded right after settlement). */
  async receiptOf(paymentTx: string, timeoutMs = 90_000) {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(3000)) {
      const r = await fetch(new URL(`/receipt/${paymentTx}`, this.opts.shopUrl));
      if (r.ok) return (await r.json()) as { order: string; receiptTx: string; amount: string };
    }
    throw new Error(`no receipt for payment ${paymentTx} yet`);
  }

  /**
   * Files a claim on our live policy, signed by this agent's payer account and sponsored by the
   * insurer (the agent pays no fee). The insurer assesses it against the on-chain receipts.
   */
  /** policyId: the policy claimed on (defaults to this agent's live cover; a merchant names the buyer's policy). */
  /** Duplicate orders the insurer spotted on-chain for this agent, and whether its purchases are on hold. */
  async detections() {
    return (await (await fetch(new URL(`/detections/${this.opts.payer}`, this.insurerUrl))).json()) as {
      detections: { orders: string[]; paymentTxs: string[]; amount: string; status: 'open' | 'filed'; claimId?: string }[]; hold: { reason: string; at: number } | null;
    };
  }

  /** Files every open detection as an AM10 duplicate-order claim (the insurer already did the finding). */
  async claimDetected() {
    const { detections } = await this.detections();
    const out = [];
    for (const d of detections.filter((x) => x.status === 'open')) out.push(await this.fileClaim('AgentMistake', d.paymentTxs, big(d.amount), 'detected by the insurer', undefined, 'AM10'));
    return out;
  }

  /** The shop's signed delivery note (ordered vs. shipped) for one of our payments. */
  async deliveryNote(paymentTx: string): Promise<SignedDeliveryNote> {
    const u = new URL(`/delivery/${paymentTx}`, this.opts.shopUrl);
    const r = await fetch(u, { headers: await this.proof(u.origin) });
    if (!r.ok) throw new Error(`no delivery note for ${paymentTx}: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
    return r.json() as Promise<SignedDeliveryNote>;
  }

  /** reason: a chargeback-style code (AM10 duplicate, AM20 outside the user intent, WI10 wrong item, ML10 merchant loss). */
  async fileClaim(kind: ClaimKind, paymentTxs: string[], amount: bigint, note = '', policyIdArg?: string, reason: ReasonCode = defaultReason(kind)) {
    if (REASON_CODES[reason]?.kind !== kind) return { ok: false as const, reasons: [`reason code ${reason} does not fit a ${kind} claim`] };
    const status = policyIdArg ? undefined : await this.coverStatus();
    const policyId = policyIdArg ?? status?.onChain.policyId ?? status?.policies.at(-1)?.policyId;
    if (policyId == null) return { ok: false as const, reasons: ['no live policy'] };
    const receipts = await Promise.all(paymentTxs.map((tx) => this.receiptOf(tx)));
    const info = await (await fetch(new URL('/info', this.insurerUrl))).json() as { cover: { index: string; subindex: string }; operator: string };
    // The evidence document travels with the filing; only its hash goes on-chain.
    const doc: ClaimEvidence = { v: 2, reason, paymentTxs, note, ...(reason === 'WI10' || reason === 'AM20' ? { delivery: await Promise.all(paymentTxs.map((tx) => this.deliveryNote(tx))) } : {}) };
    const evidence = await evidenceHash(doc);
    const message = encodeFileClaim({ policyId: big(policyId), kind, amount, evidence, orders: receipts.map((r) => r.order) });

    const grpc = connect();
    const sender = AccountAddress.fromBase58(this.opts.payer);
    const { nonce } = await grpc.getNextAccountNonce(sender);
    const tx = (Transaction.updateContract({
      amount: CcdAmount.zero(), address: ContractAddress.create(big(info.cover.index), big(info.cover.subindex)),
      receiveName: ReceiveName.fromString('kuasa_cover.fileClaim'), message: Parameter.fromBuffer(message.slice().buffer as ArrayBuffer),
    }, Energy.create(60_000)) as Transaction.Builder)
      .addMetadata({ sender, nonce, expiry: TransactionExpiry.futureMinutes(10) })
      .addSponsor(AccountAddress.fromBase58(info.operator))
      .build();
    const signed = await Transaction.sign(tx as never, buildBasicAccountSigner(this.opts.payerKey));
    const res = await fetch(new URL('/claims/sponsor', this.insurerUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tx: JSON.parse(JSON.stringify(Transaction.toJSON(signed), jsonSafe)), receiptTxs: receipts.map((r) => r.receiptTx), evidence: doc }),
    });
    return { ok: res.ok, ...(await res.json()) };
  }
}
