/**
 * Kuasa buyer agent: pays over x402 from its own payer account and presents its mandate
 * (x-kuasa-mandate header) on every request. Checks the shop's free /quote first so it never
 * signs a payment the merchant is going to refuse, and so it can explain *why* it cannot buy.
 */
import { readFileSync } from 'node:fs';
import { AccountAddress, buildBasicAccountSigner } from '@concordium/web-sdk';
import { CONCORDIUM_TESTNET_CAIP2 } from '@x402/concordium';
import { ExactConcordiumScheme } from '@x402/concordium/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';

export const MANDATE_HEADER = 'x-kuasa-mandate';

export type BuyResult =
  | { ok: true; item: unknown; paymentTx?: string }
  | { ok: false; reasons: string[] };

export type Scope = { asset: string; maxPerOrder: string; merchants?: string[] };

export class KuasaAgent {
  private pay: typeof fetch;
  /**
   * opts.scope is the agent's own trusted copy of its mandate scope, handed over by the owner at
   * start-up and never fetched from a counterparty. Payments outside it are never signed.
   */
  constructor(readonly opts: { shopUrl: string; mandateUrl: string; payer: string; payerKey: string; scope: Scope }) {
    const client = new x402Client()
      .register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumScheme({ accountAddress: AccountAddress.fromBase58(opts.payer), signer: buildBasicAccountSigner(opts.payerKey) }))
      // x402's USD caps don't understand CCD; the agent enforces its own mandate instead (below).
      .setSpendControls(false)
      .registerPolicy((_, reqs) => reqs.filter((r) => this.withinMandate(r)));
    this.pay = wrapFetchWithPayment(fetch, client);
  }

  /** Demo convenience: load the agent's payer account from .kuasa (testnet only). */
  static fromDemo(name: string, shopUrl = process.env.KUASA_SHOP_URL ?? 'http://localhost:4021') {
    const root = new URL('../../../.kuasa/', import.meta.url);
    const acc = JSON.parse(readFileSync(new URL(`accounts/${name}.json`, root), 'utf8')).accounts.find((a: { credNumber: number }) => a.credNumber === 1);
    const { scope } = JSON.parse(readFileSync(new URL(`public/mandate/${name}.json`, root), 'utf8')); // owner's local copy
    return new KuasaAgent({ shopUrl, mandateUrl: `${shopUrl}/kuasa/mandate/${name}.json`, payer: acc.address, payerKey: acc.key, scope });
  }

  /** Never trust the shop's 402: amount, payee, asset and network must fit the mandate. */
  private withinMandate(r: { network: string; asset: string; amount: string; payTo: string }) {
    const s = this.opts.scope;
    if (r.network !== CONCORDIUM_TESTNET_CAIP2) return false;
    if ((r.asset || 'CCD').toUpperCase() !== s.asset.toUpperCase()) return false;
    if (!/^\d+$/.test(r.amount) || BigInt(r.amount) > BigInt(s.maxPerOrder)) return false;
    return !s.merchants?.length || s.merchants.includes(r.payTo);
  }

  private headers = () => ({ [MANDATE_HEADER]: this.opts.mandateUrl });

  async catalog() {
    return (await fetch(`${this.opts.shopUrl}/catalog`)).json();
  }

  async mandate() {
    return (await fetch(this.opts.mandateUrl)).json();
  }

  async quote(path: string): Promise<{ ok: boolean; reasons?: string[] }> {
    const u = new URL('/quote', this.opts.shopUrl);
    u.searchParams.set('path', path);
    u.searchParams.set('payer', this.opts.payer);
    return (await fetch(u, { headers: this.headers() })).json();
  }

  /** skipQuote: behave like a rogue agent that pays anyway; the shop must still refuse. */
  async buy(path: string, skipQuote = false): Promise<BuyResult> {
    const q = skipQuote ? { ok: true } : await this.quote(path);
    if (!q.ok) return { ok: false, reasons: q.reasons ?? ['refused'] };
    const url = new URL(path, this.opts.shopUrl);
    if (url.origin !== new URL(this.opts.shopUrl).origin) return { ok: false, reasons: ['refusing to pay outside the configured shop'] };
    let res: Response;
    try {
      res = await this.pay(url, { headers: this.headers() });
    } catch (e) {
      return { ok: false, reasons: [`payment failed: ${(e as Error).message}`] };
    }
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reasons: [`shop answered ${res.status}: ${body.slice(0, 300) || res.headers.get('payment-required')?.slice(0, 300) || ''}`] };
    }
    const header = res.headers.get('payment-response');
    const settle = header ? decodePaymentResponseHeader(header) : undefined;
    return { ok: true, item: await res.json(), paymentTx: settle?.transaction };
  }
}
