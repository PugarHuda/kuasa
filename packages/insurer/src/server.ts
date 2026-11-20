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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import express from 'express';
import { x402Facilitator } from '@x402/core/facilitator';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { CONCORDIUM_TESTNET_CAIP2, toConcordiumFacilitatorSigner } from '@x402/concordium';
import { ExactConcordiumScheme as FacilitatorScheme } from '@x402/concordium/exact/facilitator';
import { ExactConcordiumScheme as ServerScheme } from '@x402/concordium/exact/server';
import { solvency } from '@kuasa/cover';
import { AuditLog, bigintJson, connect, KuasaCover, KuasaRegistry, registerData, registryEventsOfTx, TESTNET, wallet } from '@kuasa/chain';
import { canonicalJson, MandateSchema, mandateId, sha256Hex } from '@kuasa/core';
import { KuasaGuard, MANDATE_HEADER, MandateProofIdentity, safeFetchText, verifyPayerProof } from '@kuasa/merchant';
import { InsurerService } from './service.js';
import { checkSponsorable, jsonSafe, SponsorBudget } from './sponsor.js';
import { Transaction } from '@concordium/web-sdk/transactions';

const ROOT = new URL('../../../.kuasa/', import.meta.url);
const PORT = Number(process.env.PORT ?? 4023);
const PUBLIC_URL = process.env.KUASA_INSURER_URL ?? `http://localhost:${PORT}`;
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

const STATE_FILE = new URL('insurer-state.json', ROOT);
const svc = new InsurerService({
  now: () => Date.now(),
  persist: (snapshot) => { const tmp = new URL('insurer-state.json.tmp', ROOT); writeFileSync(tmp, snapshot); renameSync(tmp, STATE_FILE); },
  operator,
  loadMandate: async (url) => {
    const mandate = MandateSchema.parse(JSON.parse(await fetchDoc(url)));
    return { mandate, id: await mandateId(mandate) };
  },
  mandateEntry: (owner, id) => registry.view(owner, id),
  identity: new MandateProofIdentity({ grpc, network: 'Testnet', fetchText: fetchDoc }),
  // the requester must sign with the agent payer key (audience: this service's public origin)
  verifyPayer: (payer, proof) => verifyPayerProof({ header: proof as (n: string) => string | undefined, payer, audience: PUBLIC_URL, accountInfo: (a) => grpc.getAccountInfo(a) }),
  cover: {
    issuePolicy: async (p) => { const r = await cover.issuePolicy(p, operator); return { hash: r.hash, id: KuasaCover.idFromEvents(r.summary, coverIndex) }; },
    policy: (id) => cover.policy(id),
    claim: (id) => cover.claim(id),
    assess: (id, ok, reason) => cover.assess(id, ok, reason, operator),
    decide: (id, approve) => cover.decide(id, approve, operator),
    recordPayout: (id, tx, amount) => cover.recordPayout(id, tx, amount, operator),
    markFraud: (id, hash) => cover.markFraud(id, hash, operator),
    // premium_tx is unique per premium: scan issued policies (ids are dense from 0)
    policyByPremiumTx: async (tx) => {
      for (let id = 0n; id < 10_000n; id++) {
        const p = await cover.policy(id);
        if (!p) return null;
        if (p.premiumTx === tx) return id;
      }
      return null;
    },
  },
  registryEvents: (tx) => registryEventsOfTx(grpc, tx, registryIndex),
  treasuryBalance: () => eudemoBalance(treasury.address.address),
  paidClaims: async (payer) => {
    const { policies, claims } = await scanCover();
    return claims.filter((c) => c.status.tag === 'Paid' && policies[Number(c.policyId)]?.agentPayer === payer).length;
  },
  autoPayLimit: BigInt(process.env.KUASA_AUTOPAY_LIMIT ?? 10_000_000), // 10 EUDemo: smaller claims pay after the objection window
  autoPayDelayMs: Number(process.env.KUASA_AUTOPAY_DELAY_MS ?? 120_000),
  pay: async (to, amount, memo) => {
    const token = await sdk.Token.fromId(grpc, sdk.TokenId.fromString(ASSET));
    const hash = await sdk.Token.transfer(token, treasury.address,
      { recipient: sdk.AccountAddress.fromBase58(to), amount: sdk.TokenAmount.create(amount, 6), memo: sdk.CborMemo.fromString(memo) },
      treasury.signer, undefined, { autoScale: false, validate: true });
    return sdk.TransactionHash.toHexString(hash); // submitted; txOutcome confirms it
  },
  txOutcome: async (hash) => {
    const tx = sdk.TransactionHash.fromHexString(hash);
    const done = await Promise.race([grpc.waitForTransactionFinalization(tx).then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 30_000))]).catch(() => false);
    if (!done) return 'pending';
    const st = await grpc.getBlockItemStatus(tx);
    if (st.status !== 'finalized' || !st.outcome) return 'pending';
    return (st.outcome.summary as { transactionType?: string }).transactionType === 'failed' ? 'failed' : 'success';
  },
  saveDisclosure: async (doc) => {
    const body = canonicalJson(doc);
    const hash = await sha256Hex(body);
    mkdirSync(disclosureDir, { recursive: true });
    writeFileSync(new URL(`${hash}.json`, disclosureDir), body);
    return hash;
  },
}, existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf8') : undefined);

// EU AI Act Art. 12: premiums, claim assessments, decisions and payouts are logged and anchored.
const audit = new AuditLog({ dir: new URL('audit/insurer/', ROOT), register: (d) => registerData(grpc, d, operator) })
  .start(60_000, (e) => console.error('[audit]', e.message));

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
  if (ctx.result.success !== false) {
    svc.markSettled(quoteIdOf(ctx)); // consumed before issuance: the quote can never back another payment
    const policyId = await svc.issue(quoteIdOf(ctx), ctx.result.transaction);
    audit.append({ kind: 'premium', payer: payerOf(ctx), amount: ctx.requirements.amount, premiumTx: ctx.result.transaction, policyId });
  }
}) as never);
server.onSettleFailure((async (ctx: Parameters<KuasaGuard['settleFailed']>[0]) => {
  await guard.settleFailed(ctx);
  svc.releaseQuote(quoteIdOf(ctx)); // the premium did not settle: the quote may be paid again
}) as never);

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
  json(res, await svc.quote({ mandateUrl, limit: order ? order.amount : big(req.query.limit), days: Number(req.query.days ?? 30), order, proof: (n: string) => req.header(n) }));
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
const sponsorBudget = new SponsorBudget(5, 3_600_000);
/** Filed on-chain but not assessed (e.g. a chain error mid-way); the console can assess them. */
const pendingAssessments = new Map<string, { claimId: bigint; receiptTxs: string[]; error: string }>();

app.post('/claims/sponsor', async (req, res) => {
  const check = await checkSponsorable(req.body?.tx, cover.address, operator.address);
  if ('refused' in check) return json(res, { error: check.refused }, 400);
  const wire = JSON.parse(JSON.stringify(Transaction.toJSON(check.signable as never), jsonSafe));
  const sender = String(wire.header.sender);
  // Dry-run as the sender first: never pay fees for a filing the contract would reject.
  const dry = await grpc.invokeContract({
    contract: cover.address, invoker: sdk.AccountAddress.fromBase58(sender), method: sdk.ReceiveName.fromString('kuasa_cover.fileClaim'),
    parameter: sdk.Parameter.fromHexString(String(wire.payload.message)), energy: sdk.Energy.create(60_000),
  }).catch(() => null);
  if (!dry || dry.tag !== 'success') return json(res, { error: 'the cover contract would reject this claim' }, 400);
  if (!sponsorBudget.take(sender)) return json(res, { error: 'too many sponsored filings; try again later' }, 429);
  try {
    const sponsored = await Transaction.sponsor(check.signable as never, operator.signer);
    const hash = await grpc.sendTransaction(Transaction.finalize(sponsored));
    const summary = await grpc.waitForTransactionFinalization(hash).catch(() => null);
    // Sent but not confirmed yet: report the transaction so the claimant can follow up.
    if (!summary) return json(res, { tx: sdk.TransactionHash.toHexString(hash), claimId: null, assessment: 'pending', error: 'filing sent; finalization not confirmed yet' }, 202);
    const s = summary.summary as { transactionType?: string };
    if (s.transactionType === 'failed') return json(res, { error: 'claim rejected on-chain', summary }, 400);
    const claimId = KuasaCover.idFromEvents(summary, coverIndex);
    if (claimId === null) return json(res, { error: 'claim id missing' }, 500);
    // The receipts are submitted together with the claimant-signed filing; assessed exactly once.
    const txs = Array.isArray(req.body?.receiptTxs) ? req.body.receiptTxs.map(String).filter((t: string) => /^[0-9a-f]{64}$/.test(t)).slice(0, 4) : [];
    const filedTx = sdk.TransactionHash.toHexString(hash);
    try {
      const assessment = await svc.assessClaim(claimId, txs);
      audit.append({ kind: 'claim-assessed', claimId, filedTx, ok: assessment.ok, reason: assessment.reason, payout: assessment.payout });
      json(res, { tx: filedTx, claimId, assessment });
    } catch (e) {
      pendingAssessments.set(String(claimId), { claimId, receiptTxs: txs, error: (e as Error).message });
      json(res, { tx: filedTx, claimId, assessment: 'pending', error: (e as Error).message }, 202);
    }
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

app.get('/state', consoleOnly, async (_req, res) => json(res, {
  ...svc.state(), treasury: treasury.address.address, operator: operator.address.address, cover: `<${state.cover},0>`,
  pool: await eudemoBalance(treasury.address.address).catch(() => null), // node hiccups must not hide the claims queue
  pendingAssessments: [...pendingAssessments.values()],
  audit: audit.anchors(),
}));
/** Console: assess a claim that was filed but never assessed (receipts from the filing request). */
app.post('/claims/:id/assess', consoleOnly, async (req, res) => {
  // Operator recovery: receipts from the pending filing, or supplied by the operator (console only).
  const given = Array.isArray(req.body?.receiptTxs) ? req.body.receiptTxs.map(String).filter((t: string) => /^[0-9a-f]{64}$/.test(t)).slice(0, 4) : [];
  const p = pendingAssessments.get(String(big(req.params.id))) ?? (given.length ? { claimId: big(req.params.id), receiptTxs: given, error: '' } : undefined);
  if (!p) return json(res, { error: 'no pending assessment for this claim' }, 404);
  try {
    const a = await svc.assessClaim(p.claimId, p.receiptTxs);
    pendingAssessments.delete(String(p.claimId));
    json(res, a);
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

app.post('/claims/:id/decision', consoleOnly, async (req, res) => {
  try {
    const d = await svc.decide(big(req.params.id), req.body?.approve === true);
    audit.append({ kind: 'claim-decided', claimId: req.params.id, approve: req.body?.approve === true, by: 'claims handler (console)', paid: d.paid, note: d.reason });
    json(res, d);
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});
app.post('/disclosures/:id/approve', consoleOnly, async (req, res) => {
  try { json(res, { hash: await svc.approveDisclosure(big(req.params.id)) }); } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

/** Every policy and claim on the cover contract (ids are sequential), cached for 30 s. */
let scanned: { at: number; policies: NonNullable<Awaited<ReturnType<KuasaCover['policy']>>>[]; claims: NonNullable<Awaited<ReturnType<KuasaCover['claim']>>>[] } | undefined;
async function scanCover() {
  if (scanned && Date.now() - scanned.at < 30_000) return scanned;
  const policies = [];
  for (let i = 0n; ; i++) { const p = await cover.policy(i); if (!p) break; policies.push(p); }
  const claims = [];
  for (let i = 0n; ; i++) { const c = await cover.claim(i); if (!c) break; claims.push(c); }
  scanned = { at: Date.now(), policies, claims };
  return scanned;
}

/** Public proof of solvency: pool vs the cover still owed by live policies, from on-chain data. */
app.get('/solvency', async (_req, res) => {
  try {
    const { policies, claims } = await scanCover();
    const s = solvency({ pool: await eudemoBalance(treasury.address.address), now: Date.now(), policies, claims: claims.map((c) => ({ status: c.status.tag })) });
    json(res, { ...s, cover: `<${state.cover},0>`, treasury: treasury.address.address, asset: ASSET, autoPayLimit: String(BigInt(process.env.KUASA_AUTOPAY_LIMIT ?? 10_000_000)) });
  } catch (e) { json(res, { error: (e as Error).message }, 502); }
});

/** A human takes a claim over (no automatic payout). */
app.post('/claims/:id/hold', consoleOnly, (req, res) => {
  try { svc.hold(big(req.params.id)); json(res, { held: true }); } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

setInterval(() => { void svc.retryUnissued(); }, 60_000);
const autoAudited = new Set<string>();
setInterval(() => {
  void svc.runAutoPay().then(() => {
    for (const c of svc.state().claims) {
      if (c.decidedBy !== 'auto' || !c.paid || autoAudited.has(String(c.claimId))) continue;
      autoAudited.add(String(c.claimId));
      audit.append({ kind: 'claim-decided', claimId: String(c.claimId), approve: true, by: 'automatic (below the auto-pay limit, objection window passed)', paid: c.paid });
    }
  });
}, 15_000);
app.listen(PORT, process.env.HOST ?? '127.0.0.1', () => console.log(`[insurer] http://localhost:${PORT}  cover <${state.cover},0>  treasury ${treasury.address.address}`));
