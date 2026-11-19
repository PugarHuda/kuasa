/**
 * Kuasa Cover insurer service (port 4023).
 *
 * - Prices cover from on-chain facts and sells it over x402 in EUDemo. The premium is a purchase
 *   under the agent's mandate (category "insurance"), so KuasaGuard checks it like any other.
 * - Issues policies on the kuasa-cover contract after settlement.
 * - Assesses claims against on-chain receipts; a human approves before any payout.
 *
 * DEMO: the operator and treasury keys come from .kuasa (testnet only). Signing endpoints are
 * localhost-only and require the console header.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import express from 'express';
import { x402Facilitator } from '@x402/core/facilitator';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { CONCORDIUM_TESTNET_CAIP2, toConcordiumFacilitatorSigner } from '@x402/concordium';
import { ExactConcordiumScheme as FacilitatorScheme } from '@x402/concordium/exact/facilitator';
import { ExactConcordiumScheme as ServerScheme } from '@x402/concordium/exact/server';
import { bigintJson, connect, KuasaCover, KuasaRegistry, registryEventsOfTx, TESTNET, wallet } from '@kuasa/chain';
import { canonicalJson, MandateSchema, mandateId, sha256Hex } from '@kuasa/core';
import { KuasaGuard, MANDATE_HEADER, MandateProofIdentity, safeFetchText } from '@kuasa/merchant';
import { InsurerService } from './service.js';
import { checkSponsorable } from './sponsor.js';
import { Transaction } from '@concordium/web-sdk/transactions';

const ROOT = new URL('../../../.kuasa/', import.meta.url);
const PORT = Number(process.env.PORT ?? 4023);
const SHOP_ORIGIN = process.env.KUASA_SHOP_URL ?? 'http://localhost:4021';
const ASSET = process.env.KUASA_ASSET ?? 'EUDemo';
const state = JSON.parse(readFileSync(new URL('state.json', ROOT), 'utf8')) as { registry: string; cover: string };
const accounts = JSON.parse(readFileSync(new URL('accounts/insurer.json', ROOT), 'utf8')).accounts as { credNumber: number; address: string; key: string }[];
const treasuryAcc = accounts.find((a) => a.credNumber === 0)!;
const operatorAcc = accounts.find((a) => a.credNumber === 1)!;
const treasury = wallet(treasuryAcc.address, treasuryAcc.key);
const operator = wallet(operatorAcc.address, operatorAcc.key);

const grpc = connect();
const registryIndex = BigInt(state.registry);
const coverIndex = BigInt(state.cover);
const registry = new KuasaRegistry(grpc, registryIndex);
const cover = new KuasaCover(grpc, coverIndex);
const fetchDoc = (url: string) => safeFetchText(url, { localOrigin: SHOP_ORIGIN });
const disclosureDir = new URL('disclosures/', ROOT);

async function eudemoBalance(address: string) {
  const info = await grpc.getAccountInfo(sdk.AccountAddress.fromBase58(address));
  const t = (info as unknown as { accountTokens?: { id: unknown; state: { balance: { value: bigint | string } } }[] }).accountTokens?.find((x) => String(x.id) === ASSET);
  return t ? BigInt(t.state.balance.value) : 0n;
}

const svc = new InsurerService({
  now: () => Date.now(),
  operator,
  loadMandate: async (url) => {
    const mandate = MandateSchema.parse(JSON.parse(await fetchDoc(url)));
    return { mandate, id: await mandateId(mandate) };
  },
  mandateEntry: (owner, id) => registry.view(owner, id),
  identity: new MandateProofIdentity({ grpc, network: 'Testnet', fetchText: fetchDoc }),
  cover: {
    issuePolicy: async (p) => { const r = await cover.issuePolicy(p, operator); return { hash: r.hash, id: KuasaCover.idFromEvents(r.summary, coverIndex) }; },
    policy: (id) => cover.policy(id),
    claim: (id) => cover.claim(id),
    assess: (id, ok, reason) => cover.assess(id, ok, reason, operator),
    decide: (id, approve) => cover.decide(id, approve, operator),
    recordPayout: (id, tx, amount) => cover.recordPayout(id, tx, amount, operator),
    markFraud: (id, hash) => cover.markFraud(id, hash, operator),
  },
  registryEvents: (tx) => registryEventsOfTx(grpc, tx, registryIndex),
  treasuryBalance: () => eudemoBalance(treasury.address.address),
  pay: async (to, amount, memo) => {
    const token = await sdk.Token.fromId(grpc, sdk.TokenId.fromString(ASSET));
    const hash = await sdk.Token.transfer(token, treasury.address,
      { recipient: sdk.AccountAddress.fromBase58(to), amount: sdk.TokenAmount.create(amount, 6), memo: sdk.CborMemo.fromString(memo) },
      treasury.signer, undefined, { autoScale: false, validate: true });
    const { summary } = await grpc.waitForTransactionFinalization(hash);
    if ((summary as { transactionType?: string }).transactionType === 'failed') throw new Error(`payout rejected: ${JSON.stringify(summary, bigintJson)}`);
    return sdk.TransactionHash.toHexString(hash);
  },
  saveDisclosure: async (doc) => {
    const body = canonicalJson(doc);
    const hash = await sha256Hex(body);
    mkdirSync(disclosureDir, { recursive: true });
    writeFileSync(new URL(`${hash}.json`, disclosureDir), body);
    return hash;
  },
});

// The premium is spending under the mandate: same guard as any shop, category "insurance".
const guard = new KuasaGuard({
  grpc, network: 'Testnet', registry,
  offers: { '/cover/buy': { category: 'insurance', requirements: {} } },
  recorder: operator,
  localOrigin: SHOP_ORIGIN,
});

const quoteIdOf = (ctx: unknown) => {
  const url = (ctx as { transportContext?: { request?: { adapter?: { getUrl(): string } } } })?.transportContext?.request?.adapter?.getUrl();
  return url ? new URL(url, 'http://local').searchParams.get('quoteId') ?? '' : '';
};
const payerOf = (ctx: { paymentPayload: { payload: unknown } }) =>
  (ctx.paymentPayload.payload as { signedTransaction?: { header?: { sender?: string } } })?.signedTransaction?.header?.sender ?? '';

const facilitator = new x402Facilitator().register(CONCORDIUM_TESTNET_CAIP2,
  new FacilitatorScheme({ signer: toConcordiumFacilitatorSigner(operator.address.address, operatorAcc.key, { host: TESTNET.grpc.host, port: TESTNET.grpc.port, useTls: true }) }));
const server = new x402ResourceServer(facilitator as never).register(CONCORDIUM_TESTNET_CAIP2, new ServerScheme());
const mandateHeaderOf = (ctx: unknown) =>
  (ctx as { transportContext?: { request?: { adapter?: { getHeader(n: string): string | undefined } } } })?.transportContext?.request?.adapter?.getHeader(MANDATE_HEADER);
server.onBeforeVerify((async (ctx: Parameters<KuasaGuard['beforeVerify']>[0]) => {
  const q = svc.quoteOf(quoteIdOf(ctx));
  if (!q || mandateHeaderOf(ctx) !== q.request.mandateUrl) {
    return { abort: true as const, reason: 'kuasa_cover_rejected', message: 'the premium must be paid under the mandate the quote was priced for' };
  }
  const g = await guard.beforeVerify(ctx);
  if (g) return g;
  const reason = await svc.checkPurchase(quoteIdOf(ctx), payerOf(ctx), BigInt(ctx.requirements.amount));
  if (reason) {
    await guard.settleFailed(ctx); // release the budget reservation
    return { abort: true as const, reason: 'kuasa_cover_rejected', message: reason };
  }
}) as never);
server.onAfterSettle((async (ctx: Parameters<KuasaGuard['afterSettle']>[0]) => {
  await guard.afterSettle(ctx); // receipt: the premium draws down the mandate budget
  if (ctx.result.success !== false) await svc.issue(quoteIdOf(ctx), ctx.result.transaction);
}) as never);
server.onSettleFailure(guard.settleFailed as never);

const app = express();
app.use(express.json({ limit: '32kb' }));
const json = (res: express.Response, body: unknown, status = 200) => res.status(status).type('json').send(JSON.stringify(body, bigintJson));
const local = (req: express.Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
const consoleOnly: express.RequestHandler = (req, res, next) =>
  local(req) && [`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.get('host') ?? '') && req.get('x-kuasa-console') === '1' ? next() : json(res, { error: 'forbidden' }, 403);
const big = (v: unknown) => { try { return BigInt(String(v)); } catch { return -1n; } };

app.get('/cover/quote', async (req, res) => {
  const mandateUrl = req.header(MANDATE_HEADER);
  if (!mandateUrl) return json(res, { refused: 'no mandate presented (x-kuasa-mandate header)' }, 400);
  const order = req.query.order ? { ref: String(req.query.order), amount: big(req.query.amount) } : undefined;
  if (order && !/^[0-9a-f]{64}$/.test(order.ref)) return json(res, { refused: 'bad order reference' }, 400);
  json(res, await svc.quote({ mandateUrl, limit: order ? order.amount : big(req.query.limit), days: Number(req.query.days ?? 30), order }));
});

// Unknown quotes never reach the paywall.
app.get('/cover/buy', (req, res, next) => (svc.quoteOf(String(req.query.quoteId ?? '')) ? next() : json(res, { error: 'unknown or expired quote' }, 404)));
app.use(paymentMiddleware({
  'GET /cover/buy': {
    accepts: {
      scheme: 'exact', network: CONCORDIUM_TESTNET_CAIP2, payTo: treasury.address.address, maxTimeoutSeconds: 120,
      price: async (ctx: { adapter: { getUrl(): string } }) => {
        const q = svc.quoteOf(new URL(ctx.adapter.getUrl(), 'http://local').searchParams.get('quoteId') ?? '');
        return { amount: String(q?.premium ?? 0n), asset: ASSET };
      },
    },
    description: 'Kuasa Cover premium', mimeType: 'application/json',
  },
} as never, server));
app.get('/cover/buy', (req, res) => json(res, { ok: true, quoteId: req.query.quoteId, note: 'policy is issued on settlement; see /cover/status' }));

app.get('/cover/status', async (req, res) => {
  const payer = String(req.query.payer ?? '');
  try { sdk.AccountAddress.fromBase58(payer); } catch { return json(res, { error: 'bad payer' }, 400); }
  json(res, { onChain: await cover.coverOf(payer), policies: svc.state().policies.filter((p) => p.payer === payer) });
});

app.get('/info', (_req, res) => json(res, { cover: { index: state.cover, subindex: '0' }, operator: operator.address.address, treasury: treasury.address.address, asset: ASSET }));

/** Co-signs (sponsors) a claim filing signed by the claimant, so agents never need CCD for fees. */
app.post('/claims/sponsor', async (req, res) => {
  const check = await checkSponsorable(req.body?.tx, cover.address, operator.address);
  if ('refused' in check) return json(res, { error: check.refused }, 400);
  try {
    const sponsored = await Transaction.sponsor(check.signable as never, operator.signer);
    const hash = await grpc.sendTransaction(Transaction.finalize(sponsored));
    const summary = await grpc.waitForTransactionFinalization(hash);
    const s = summary.summary as { transactionType?: string };
    if (s.transactionType === 'failed') return json(res, { error: 'claim rejected on-chain', summary }, 400);
    const claimId = KuasaCover.idFromEvents(summary, coverIndex);
    if (claimId === null) return json(res, { error: 'claim id missing' }, 500);
    // The receipts are submitted together with the claimant-signed filing; assessed exactly once.
    const txs = Array.isArray(req.body?.receiptTxs) ? req.body.receiptTxs.map(String).filter((t: string) => /^[0-9a-f]{64}$/.test(t)).slice(0, 4) : [];
    const assessment = await svc.assessClaim(claimId, txs);
    json(res, { tx: sdk.TransactionHash.toHexString(hash), claimId, assessment });
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

app.get('/state', consoleOnly, async (_req, res) => json(res, {
  ...svc.state(), treasury: treasury.address.address, operator: operator.address.address, cover: `<${state.cover},0>`,
  pool: await eudemoBalance(treasury.address.address),
}));
app.post('/claims/:id/decision', consoleOnly, async (req, res) => {
  try { json(res, await svc.decide(big(req.params.id), req.body?.approve === true)); } catch (e) { json(res, { error: (e as Error).message }, 400); }
});
app.post('/disclosures/:id/approve', consoleOnly, async (req, res) => {
  try { json(res, { hash: await svc.approveDisclosure(big(req.params.id)) }); } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

setInterval(() => { void svc.retryUnissued(); }, 60_000);
app.listen(PORT, () => console.log(`[insurer] http://localhost:${PORT}  cover <${state.cover},0>  treasury ${treasury.address.address}`));
