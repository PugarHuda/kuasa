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
import { canonicalJson, type ClaimKind, encodeFileClaim, sha256Hex } from '@kuasa/core';

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

export class KuasaAgent {
  private payFetch: typeof fetch;
  /**
   * opts.scope is the agent's own trusted copy of its mandate scope, handed over by the owner at
   * start-up and never fetched from a counterparty. Payments outside it are never signed.
   */
  constructor(readonly opts: { shopUrl: string; insurerUrl?: string; mandateUrl: string; payer: string; payerKey: string; scope: Scope }) {
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
    return new KuasaAgent({ shopUrl, insurerUrl, mandateUrl: `${shopUrl}/kuasa/mandate/${name}.json`, payer: acc.address, payerKey: acc.key, scope });
  }

  private get insurerUrl() { return this.opts.insurerUrl ?? 'http://localhost:4023'; }

  /** Never trust a 402: amount, payee, asset and network must fit the mandate. */
  private withinMandate(r: { network: string; asset: string; amount: string; payTo: string }) {
    const s = this.opts.scope;
    if (r.network !== CONCORDIUM_TESTNET_CAIP2) return false;
    if ((r.asset || 'CCD').toUpperCase() !== s.asset.toUpperCase()) return false;
    if (!/^\d+$/.test(r.amount) || BigInt(r.amount) > BigInt(s.maxPerOrder)) return false;
    return !s.merchants?.length || s.merchants.includes(r.payTo);
  }

  private headers = () => ({ [MANDATE_HEADER]: this.opts.mandateUrl });

  /** Pays an x402 resource at a configured counterparty (shop or insurer) only. */
  private async payAt(url: URL, extra: Record<string, string> = {}): Promise<BuyResult> {
    const allowed = [new URL(this.opts.shopUrl).origin, new URL(this.insurerUrl).origin];
    if (!allowed.includes(url.origin)) return { ok: false, reasons: ['refusing to pay outside the configured shop and insurer'] };
    let res: Response;
    try {
      res = await this.payFetch(url, { headers: { ...this.headers(), ...extra } });
    } catch (e) {
      return { ok: false, reasons: [`payment failed: ${(e as Error).message}`] };
    }
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reasons: [`answered ${res.status}: ${body.slice(0, 300) || res.headers.get('payment-required')?.slice(0, 300) || ''}`] };
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
    return (await fetch(u, { headers: this.headers() })).json();
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

  async coverQuote(limit: bigint, days = 30, order?: { ref: string; amount: bigint }) {
    const u = new URL('/cover/quote', this.insurerUrl);
    if (order) {
      u.searchParams.set('order', order.ref);
      u.searchParams.set('amount', String(order.amount));
    } else {
      u.searchParams.set('limit', String(limit));
      u.searchParams.set('days', String(days));
    }
    return (await fetch(u, { headers: this.headers() })).json() as Promise<{ quoteId?: string; premium?: string; factors?: unknown[]; refused?: string }>;
  }

  async coverStatus() {
    const u = new URL('/cover/status', this.insurerUrl);
    u.searchParams.set('payer', this.opts.payer);
    return (await fetch(u)).json() as Promise<{ onChain: { periodRemaining: string; orderLimit: string; policyId: string | null }; policies: { policyId: string; kind: string; limit: string; until: number }[] }>;
  }

  /** Waits until the insurer has issued the policy on-chain after the premium settled. */
  private async waitForPolicy(before: number, timeoutMs = 90_000) {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(3000)) {
      const s = await this.coverStatus();
      if (s.policies.length > before) return s.policies.at(-1)!;
    }
    return null;
  }

  private async buyQuote(q: { quoteId?: string; premium?: string; refused?: string; factors?: unknown[] }) {
    if (!q.quoteId) return { ok: false as const, reasons: [q.refused ?? 'no quote'] };
    const before = (await this.coverStatus()).policies.length;
    const u = new URL('/cover/buy', this.insurerUrl);
    u.searchParams.set('quoteId', q.quoteId);
    const paid = await this.payAt(u);
    if (!paid.ok) return paid;
    const policy = await this.waitForPolicy(before);
    return policy
      ? { ok: true as const, premium: q.premium, factors: q.factors, paymentTx: paid.paymentTx, policy }
      : { ok: false as const, reasons: ['premium paid but the policy is not issued yet; the insurer retries, check cover-status'], paymentTx: paid.paymentTx };
  }

  /** Period cover (option A): insure this agent for `days` up to `limit`. */
  async coverBuy(limit: bigint, days = 30) {
    return this.buyQuote(await this.coverQuote(limit, days));
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
  async fileClaim(kind: ClaimKind, paymentTxs: string[], amount: bigint, note = '') {
    const status = await this.coverStatus();
    const policyId = status.onChain.policyId ?? status.policies.at(-1)?.policyId;
    if (policyId == null) return { ok: false as const, reasons: ['no live policy'] };
    const receipts = await Promise.all(paymentTxs.map((tx) => this.receiptOf(tx)));
    const info = await (await fetch(new URL('/info', this.insurerUrl))).json() as { cover: { index: string; subindex: string }; operator: string };
    const evidence = await sha256Hex(canonicalJson({ paymentTxs, note }));
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
      body: JSON.stringify({ tx: JSON.parse(JSON.stringify(Transaction.toJSON(signed), jsonSafe)), receiptTxs: receipts.map((r) => r.receiptTx) }),
    });
    return { ok: res.ok, ...(await res.json()) };
  }
}
