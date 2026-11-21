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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import express from 'express';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { x402Facilitator } from '@x402/core/facilitator';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { CONCORDIUM_TESTNET_CAIP2, toConcordiumFacilitatorSigner } from '@x402/concordium';
import { ExactConcordiumScheme as FacilitatorScheme } from '@x402/concordium/exact/facilitator';
import { ExactConcordiumScheme as ServerScheme } from '@x402/concordium/exact/server';
import { experienceBps, solvency } from '@kuasa/cover';
import { handleA2a } from './a2a.js';
import { CapitalLedger, capitalClassOf, type RiskClass } from './capital.js';
import { AuditLog, bigintJson, cis8004GetMetadata, cis8004SetMetadata, claimKey, COVER_V1, connect, finalizedHeight, registryReceiptsAt, KuasaCover, KuasaRegistry, registerData, registryEventsOfTx, TESTNET, wallet } from '@kuasa/chain';
import { canonicalJson, type ClaimEvidence, evidenceHash, MandateSchema, mandateId, sha256Hex } from '@kuasa/core';
import { KuasaGuard, MANDATE_HEADER, MandateProofIdentity, safeFetchText, verifyAp2Intent, verifyDeliveryNote, verifyPayerProof } from '@kuasa/merchant';
import { InsurerService } from './service.js';
import { checkSponsorable, jsonSafe, SponsorBudget } from './sponsor.js';
import { Transaction } from '@concordium/web-sdk/transactions';

const ROOT = new URL('../../../.kuasa/', import.meta.url);
const PORT = Number(process.env.PORT ?? 4023);
const PUBLIC_URL = process.env.KUASA_INSURER_URL ?? `http://localhost:${PORT}`;
const SHOP_ORIGIN = process.env.KUASA_SHOP_URL ?? 'http://localhost:4021';
const ASSET = process.env.KUASA_ASSET ?? 'EUDemo';
const state = JSON.parse(readFileSync(new URL('state.json', ROOT), 'utf8')) as { registry: string; cover: string; coverV1?: string; coverV2?: string; insurerAgent?: string };
// Serve an older book (e.g. to decide a claim left on v2 after the switch to v3): KUASA_COVER_INDEX + KUASA_STATE_FILE.
if (process.env.KUASA_COVER_INDEX) state.cover = process.env.KUASA_COVER_INDEX;
const accounts = JSON.parse(readFileSync(new URL('accounts/insurer.json', ROOT), 'utf8')).accounts as { credNumber: number; address: string; key: string }[];
const treasuryAcc = accounts.find((a) => a.credNumber === 0)!;
const operatorAcc = accounts.find((a) => a.credNumber === 1)!;
const treasury = wallet(treasuryAcc.address, treasuryAcc.key);
const operator = wallet(operatorAcc.address, operatorAcc.key);
/** EUDemo out of the pool (claim payouts, refunds, capital withdrawals); returns the submitted hash. */
async function treasuryPay(to: string, amount: bigint, memo: string) {
  const token = await sdk.Token.fromId(grpc, sdk.TokenId.fromString(ASSET));
  const hash = await sdk.Token.transfer(token, treasury.address,
    { recipient: sdk.AccountAddress.fromBase58(to), amount: sdk.TokenAmount.create(amount, 6), memo: sdk.CborMemo.fromString(memo) },
    treasury.signer, undefined, { autoScale: false, validate: true });
  return sdk.TransactionHash.toHexString(hash);
}
/** Outcome of a submitted transfer: success, failed, or pending when finality is not confirmed within 30 s. */
async function txOutcomeOf(hash: string): Promise<'success' | 'failed' | 'pending'> {
  const tx = sdk.TransactionHash.fromHexString(hash);
  const done = await Promise.race([grpc.waitForTransactionFinalization(tx).then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 30_000))]).catch(() => false);
  if (!done) return 'pending';
  const st = await grpc.getBlockItemStatus(tx);
  if (st.status !== 'finalized' || !st.outcome) return 'pending';
  return (st.outcome.summary as { transactionType?: string }).transactionType === 'failed' ? 'failed' : 'success';
}
const toJsonBig = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x));
const fromJsonBig = (t: string) => JSON.parse(t, (_k, x) => (x && typeof x === 'object' && typeof x.$big === 'string' && Object.keys(x).length === 1 ? BigInt(x.$big) : x));
const AP2_MERCHANTS: Record<string, string> = {
  'Kuasa Cover': treasuryAcc.address,
  ...(existsSync(new URL('accounts/merchant.json', ROOT)) ? { 'Kuasa demo shop': JSON.parse(readFileSync(new URL('accounts/merchant.json', ROOT), 'utf8')).accounts.find((a: { credNumber: number }) => a.credNumber === 0).address } : {}),
};
/** The user's AP2 Intent Mandate, if the agent sends one (base64url JSON in x-ap2-intent-mandate). */
const ap2Of = (v: unknown) => { try { return v ? JSON.parse(Buffer.from(String(v), 'base64url').toString()) : undefined; } catch { return undefined; } };

/**
 * Every claim decision is published on the insurer's own CIS-8004 entry (key kuasa:decision:<id>),
 * so anyone can see which claims were paid automatically and which a human decided.
 */
function publishDecision(claimId: bigint | string, by: 'auto' | 'human' | 'panel', verdict: 'approved' | 'rejected', paid?: string) {
  if (!state.insurerAgent) return;
  const reason = svc.state().claims.find((c) => String(c.claimId) === String(claimId))?.reason;
  // metadata is ;/= delimited: only a known reason-code shape goes in, never claimant text
  const code = reason && /^[A-Z]{2}\d{2}$/.test(reason) ? `reason=${reason};` : '';
  const value = `by=${by};verdict=${verdict};paid=${paid ?? '-'};${code}at=${Math.floor(Date.now() / 1000)}`;
  const key = claimKey('decision', state.cover, claimId);
  // a decision is final: if it is already on-chain (e.g. republished after a restart), pay no fee again
  void cis8004GetMetadata(grpc, state.insurerAgent, key)
    .then((existing) => (existing?.includes(`verdict=${verdict};`) ? undefined : cis8004SetMetadata(grpc, state.insurerAgent!, key, value, treasury)))
    .catch((e) => console.error('[insurer] publishing decision failed', String(claimId), (e as Error).message));
}

const grpc = connect();
const registryIndex = BigInt(state.registry);
const coverIndex = BigInt(state.cover);
const registry = new KuasaRegistry(grpc, registryIndex);
const cover = new KuasaCover(grpc, coverIndex);
/** The version comes from configuration (any instance after v1 is v2); a v2 contract's rules are mandatory. */
const isV2 = coverIndex !== COVER_V1;
let rules: Awaited<ReturnType<KuasaCover['rules']>> = null;
for (let i = 0; isV2 && !rules && i < 5; i++) { rules = await cover.rules(); if (!rules) await new Promise((r) => setTimeout(r, 2000)); }
if (isV2 && !rules) throw new Error(`cannot read the automation rules of kuasa-cover <${coverIndex},0>; refusing to start`);
/** v3 (bonded objections, operator bonds, per-policy terms, filing for the agent) is recognised by its bondRules view. */
const objectionBond = isV2 ? await cover.objectionBond() : null;
const isV3 = objectionBond !== null;
const AUTO_PAY_LIMIT = rules?.autoPayLimit ?? BigInt(process.env.KUASA_AUTOPAY_LIMIT ?? 10_000_000);
const AUTO_PAY_DELAY_MS = rules?.objectionWindowMs ?? Number(process.env.KUASA_AUTOPAY_DELAY_MS ?? 120_000);
/** CIS-8004 key of an agent payer's purchase hold on the insurer's entry. */
const holdKey = (payer: string) => `kuasa:hold:${payer}`;
const fetchDoc = (url: string) => safeFetchText(url, { localOrigin: SHOP_ORIGIN });
const disclosureDir = new URL('disclosures/', ROOT);

async function eudemoBalance(address: string) {
  const info = await grpc.getAccountInfo(sdk.AccountAddress.fromBase58(address));
  const t = (info as unknown as { accountTokens?: { id: unknown; state: { balance: { value: bigint | string } } }[] }).accountTokens?.find((x) => String(x.id) === ASSET);
  return t ? BigInt(t.state.balance.value) : 0n;
}

const STATE_NAME = process.env.KUASA_STATE_FILE ?? 'insurer-state.json';
const STATE_FILE = new URL(STATE_NAME, ROOT);
const svc = new InsurerService({
  now: () => Date.now(),
  persist: (snapshot) => { const tmp = new URL(`${STATE_NAME}.tmp`, ROOT); writeFileSync(tmp, snapshot); renameSync(tmp, STATE_FILE); },
  operator,
  loadMandate: async (url) => {
    const mandate = MandateSchema.parse(JSON.parse(await fetchDoc(url)));
    return { mandate, id: await mandateId(mandate) };
  },
  mandateEntry: (owner, id) => registry.view(owner, id),
  identity: new MandateProofIdentity({ grpc, network: 'Testnet', fetchText: fetchDoc }),
  // the requester must sign with the agent payer key (audience: this service's public origin)
  // AP2 names merchants; their Concordium accounts (demo: the shop's payTo and the insurer's pool)
  ap2Merchant: (name) => AP2_MERCHANTS[name],
  verifyPayer: (payer, proof) => verifyPayerProof({ header: proof as (n: string) => string | undefined, payer, audience: PUBLIC_URL, accountInfo: (a) => grpc.getAccountInfo(a) }),
  cover: {
    issuePolicy: async (p) => { const r = await cover.issuePolicy(p, operator); return { hash: r.hash, id: KuasaCover.idFromEvents(r.summary, coverIndex) }; },
    policy: (id) => cover.policy(id),
    claim: (id) => cover.claim(id),
    ...(rules ? { autoApprove: (id: bigint) => cover.autoApprove(id, operator) } : {}),
    ...(isV3 ? {
      fileClaimFor: async (p: Parameters<KuasaCover['fileClaimFor']>[0]) => { const r = await cover.fileClaimFor(p, operator); return { hash: r.hash, id: KuasaCover.idFromEvents(r.summary, coverIndex) }; },
      setTerms: (id: bigint, t: Parameters<KuasaCover['setTerms']>[1]) => cover.setTerms(id, t, operator),
    } : {}),
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
  // Circuit breaker: holds live on the insurer's own CIS-8004 entry, where any merchant guard can read them.
  hold: async (payer, reason) => { if (state.insurerAgent) await cis8004SetMetadata(grpc, state.insurerAgent, holdKey(payer), `hold;reason=${reason};at=${Math.floor(Date.now() / 1000)}`, treasury); },
  unhold: async (payer) => { if (state.insurerAgent) await cis8004SetMetadata(grpc, state.insurerAgent, holdKey(payer), `clear;by=owner;at=${Math.floor(Date.now() / 1000)}`, treasury); },
  verifyAp2Owner: (intent, owner) => verifyAp2Intent(intent, owner, (a) => grpc.getAccountInfo(a)),
  verifyDelivery: (d, signer) => verifyDeliveryNote(d, signer, (a) => grpc.getAccountInfo(a)),
  treasuryBalance: () => eudemoBalance(treasury.address.address),
  capacity: async () => { const s = await solvencyNow(); return { pool: s.pool - pendingOut(), exposure: s.exposure }; },
  ...(isV3 ? { bondOf: (payer: string) => cover.bondOf(payer) } : {}),
  paidClaims: async (payer) => {
    return paidClaimsOf(payer);
  },
  coverOf: (payer) => cover.coverOf(payer),
  autoPayLimit: AUTO_PAY_LIMIT, // smaller claims pay after the objection window (enforced by a v2 contract)
  // appeals panel: independent juror accounts (KUASA_JURORS, comma-separated)
  jurors: (process.env.KUASA_JURORS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
  // staked jurors: capital in the pool is the stake; jurors against the verdict pay the jurors with it
  jurorStake: (juror) => capital.balances().find((b) => b.provider === juror)?.balance ?? 0n,
  jurorMinStake: BigInt(process.env.KUASA_JUROR_MIN_STAKE ?? 5_000_000),
  jurorPenalty: BigInt(process.env.KUASA_JUROR_PENALTY ?? 1_000_000),
  settlePanel: (moves) => {
    for (const m of moves) { capital.adjust(m.from, -m.amount); capital.adjust(m.to, m.amount); }
    saveCapital();
    audit.append({ kind: 'panel-settlement', moves: moves.map((m) => ({ ...m, amount: String(m.amount) })) });
  },
  // giveback: share of the premium returned when a policy ends without a claim
  givebackBps: BigInt(process.env.KUASA_GIVEBACK_BPS ?? 1_000),
  autoPayDelayMs: AUTO_PAY_DELAY_MS,
  pay: (to, amount, memo) => treasuryPay(to, amount, memo), // submitted; txOutcome confirms it
  txOutcome: (hash) => txOutcomeOf(hash),
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
const server = new x402ResourceServer(facilitator as never).register(CONCORDIUM_TESTNET_CAIP2, new ServerScheme()).registerExtension(bazaarResourceServerExtension);
const mandateHeaderOf = (ctx: unknown) =>
  (ctx as { transportContext?: { request?: { adapter?: { getHeader(n: string): string | undefined } } } })?.transportContext?.request?.adapter?.getHeader(MANDATE_HEADER);
server.onBeforeVerify((async (ctx: Parameters<KuasaGuard['beforeVerify']>[0]) => {
  const q = svc.quoteOf(quoteIdOf(ctx));
  if (!q || mandateHeaderOf(ctx) !== q.request.mandateUrl) {
    return { abort: true as const, reason: 'kuasa_cover_rejected', message: 'the premium must be paid under the mandate the quote was priced for' };
  }
  // A sponsor's premium (merchant-paid cover) is not the agent's spending: no mandate guard for it.
  const sponsored = !!q.request.sponsor && payerOf(ctx) === q.request.sponsor;
  const g = sponsored ? undefined : await guard.beforeVerify(ctx);
  if (g) return g;
  const reason = await svc.checkPurchase(quoteIdOf(ctx), payerOf(ctx), BigInt(ctx.requirements.amount));
  if (reason) {
    if (!sponsored) await guard.settleFailed(ctx); // release the budget reservation
    return { abort: true as const, reason: 'kuasa_cover_rejected', message: reason };
  }
}) as never);
server.onAfterSettle((async (ctx: Parameters<KuasaGuard['afterSettle']>[0]) => {
  await guard.afterSettle(ctx); // receipt: the premium draws down the mandate budget
  if (ctx.result.success !== false) {
    svc.markSettled(quoteIdOf(ctx)); // consumed before issuance: the quote can never back another payment
    await serialCapital(async () => { capital.reserve(ctx.result.transaction); saveCapital(); }); // a premium payment can never be booked as capital
    const policyId = await svc.issue(quoteIdOf(ctx), ctx.result.transaction);
    audit.append({ kind: 'premium', payer: payerOf(ctx), amount: ctx.requirements.amount, premiumTx: ctx.result.transaction, policyId });
  }
}) as never);
server.onAfterVerify(guard.afterVerify as never).onVerifyFailure(guard.verifyFailed as never).onVerifiedPaymentCanceled(guard.verifiedCanceled as never);
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
  const sponsor = req.query.sponsor ? String(req.query.sponsor) : undefined;
  if (sponsor && !order) return json(res, { refused: 'a sponsor can pay for per-order cover only' }, 400);
  const maxAutoPay = req.query.maxAutoPay !== undefined ? big(req.query.maxAutoPay) : undefined;
  if (maxAutoPay !== undefined && maxAutoPay < 0n) return json(res, { refused: 'maxAutoPay must be a non-negative amount' }, 400);
  json(res, await svc.quote({ mandateUrl, limit: order ? order.amount : big(req.query.limit), days: Number(req.query.days ?? 30), order, proof: (n: string) => req.header(n), ap2: ap2Of(req.header('x-ap2-intent-mandate')), sponsor, ...(maxAutoPay !== undefined ? { maxAutoPay } : {}) }));
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
    description: 'Kuasa Cover premium', mimeType: 'application/json', serviceName: 'Kuasa Cover', tags: ['kuasa', 'insurance', 'agents'],
    // x402 Bazaar discovery: price a quote first (GET /cover/quote with a payer proof), then pay it here
    extensions: declareDiscoveryExtension({ input: { quoteId: '<from /cover/quote>' }, inputSchema: { type: 'object', properties: { quoteId: { type: 'string' } }, required: ['quoteId'] }, output: { example: { ok: true, policyId: '7' } } }),
  },
} as never, server));
app.get('/cover/buy', (req, res) => json(res, { ok: true, quoteId: req.query.quoteId, note: 'policy is issued on settlement; see /cover/status' }));

app.get('/cover/status', async (req, res) => {
  const payer = String(req.query.payer ?? '');
  try { sdk.AccountAddress.fromBase58(payer); } catch { return json(res, { error: 'bad payer' }, 400); }
  json(res, { onChain: await cover.coverOf(payer), policies: svc.state().policies.filter((p) => p.payer === payer) });
});

/** Experience rating inputs, recomputed from the cover contract (public: it is all on-chain). */
async function riskOf(payer: string) {
  sdk.AccountAddress.fromBase58(payer); // throws on a bad address
  const paidClaims = await paidClaimsOf(payer);
  return { payer, paidClaims, premiumMultiplier: Number(experienceBps(paidClaims, paidClaims)) / 10_000, source: books.map((b) => `kuasa-cover <${b.address.index},0>`).join(" + ") };
}
app.get('/risk/:payer', async (req, res) => { try { json(res, await riskOf(req.params.payer)); } catch (e) { json(res, { error: (e as Error).message }, 400); } });

async function solvencyNow() {
  const { policies, claims } = await scanCover();
  const s = solvency({ pool: await eudemoBalance(treasury.address.address), now: Date.now(), policies, claims: claims.map((c) => ({ status: c.status.tag })) });
  return { ...s, cover: `<${state.cover},0>`, treasury: treasury.address.address, asset: ASSET, autoPayLimit: String(AUTO_PAY_LIMIT), objectionWindowMs: AUTO_PAY_DELAY_MS, rulesEnforcedOnChain: !!rules, objectionBondMicroCcd: objectionBond === null ? null : String(objectionBond) };
}

/** The insurer as an agent: its badged Agent Card, and A2A message/send for the skills on it. */
const CARD = new URL('../../../docs/agents/insurer.json', import.meta.url);
app.get('/.well-known/agent-card.json', (_req, res) => (existsSync(CARD) ? res.type('json').send(readFileSync(CARD, 'utf8')) : json(res, { error: 'card not built' }, 404)));
app.post('/a2a', async (req, res) => json(res, await handleA2a(req.body, {
  solvency: () => solvencyNow(),
  capital: () => capitalView(),
  risk: async (d) => riskOf(String(d.payer ?? '')),
  'cover-status': async (d) => {
    const payer = String(d.payer ?? '');
    sdk.AccountAddress.fromBase58(payer);
    return { onChain: await cover.coverOf(payer), policies: svc.state().policies.filter((p) => p.payer === payer) };
  },
  object: async (d) => {
    const proof = (d.proof ?? {}) as Record<string, unknown>;
    const by = String(proof['x-kuasa-payer'] ?? '');
    await svc.object(big(d.claimId), { by, reason: String(d.reason ?? ''), proof: (n: string) => (typeof proof[n] === 'string' ? (proof[n] as string) : undefined) });
    audit.append({ kind: 'claim-objection', claimId: String(d.claimId), by, reason: String(d.reason ?? '').slice(0, 280) });
    return { held: true };
  },
  // Same rules as GET /cover/quote: the requester proves control of the payer (headers as fields of `proof`).
  quote: async (d) => {
    const proof = (d.proof ?? {}) as Record<string, unknown>;
    return svc.quote({ mandateUrl: String(d.mandateUrl ?? ''), limit: big(d.limit), days: Number(d.days ?? 30), ap2: d.ap2 as never, proof: (n: string) => (typeof proof[n] === 'string' ? (proof[n] as string) : undefined) });
  },
})));

/** x402 discovery listing (Bazaar shape): the insurer sells cover over x402. */
app.get('/discovery/resources', (_req, res) => json(res, { x402Version: 2, items: [{ resource: `${PUBLIC_URL}/cover/buy`, type: 'http', method: 'GET', accepts: [{ scheme: 'exact', network: CONCORDIUM_TESTNET_CAIP2, payTo: treasury.address.address, amount: 'quoted', asset: ASSET }], metadata: { description: 'Kuasa Cover premium for an AI agent', steps: ['GET /cover/quote (x-kuasa-mandate + payer proof headers)', 'GET /cover/buy?quoteId=… over x402'], agentCard: 'https://pugarhuda.github.io/kuasa/agents/insurer.json' } }] }));

app.get('/info', (_req, res) => json(res, { cover: { index: state.cover, subindex: '0' }, operator: operator.address.address, treasury: treasury.address.address, asset: ASSET }));

/** Co-signs (sponsors) a claim filing signed by the claimant, so agents never need CCD for fees. */
const sponsorBudget = new SponsorBudget(5, 3_600_000);
/** Filed on-chain but not assessed (e.g. a chain error mid-way); the console can assess them. */
const pendingAssessments = new Map<string, { claimId: bigint; receiptTxs: string[]; error: string; evidence?: ClaimEvidence }>();
/** The claimant's evidence document (its hash is checked against the on-chain claim before use). */
const evidenceOf = (v: unknown): ClaimEvidence | undefined => (v && typeof v === 'object' && (v as ClaimEvidence).v === 2 && JSON.stringify(v).length < 20_000 ? v as ClaimEvidence : undefined);

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
      const assessment = await svc.assessClaim(claimId, txs, evidenceOf(req.body?.evidence));
      audit.append({ kind: 'claim-assessed', claimId, filedTx, ok: assessment.ok, reason: assessment.reason, payout: assessment.payout });
      if (typeof assessment === 'object' && assessment.noEvidence) publishDecision(claimId, 'auto', 'rejected');
      json(res, { tx: filedTx, claimId, assessment });
    } catch (e) {
      pendingAssessments.set(String(claimId), { claimId, receiptTxs: txs, error: (e as Error).message, evidence: evidenceOf(req.body?.evidence) });
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
  const p = pendingAssessments.get(String(big(req.params.id))) ?? (given.length ? { claimId: big(req.params.id), receiptTxs: given as string[], error: '', evidence: undefined } : undefined);
  if (!p) return json(res, { error: 'no pending assessment for this claim' }, 404);
  try {
    const a = await svc.assessClaim(p.claimId, p.receiptTxs, p.evidence ?? evidenceOf(req.body?.evidence));
    pendingAssessments.delete(String(p.claimId));
    json(res, a);
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

app.post('/claims/:id/decision', consoleOnly, async (req, res) => {
  try {
    const d = await svc.decide(big(req.params.id), req.body?.approve === true);
    audit.append({ kind: 'claim-decided', claimId: req.params.id, approve: req.body?.approve === true, by: 'claims handler (console)', paid: d.paid, note: d.reason });
    if (req.body?.approve !== true || d.paid) publishDecision(String(req.params.id), 'human', req.body?.approve === true ? 'approved' : 'rejected', d.paid);
    json(res, d);
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});
app.post('/disclosures/:id/approve', consoleOnly, async (req, res) => {
  try { json(res, { hash: await svc.approveDisclosure(big(req.params.id)) }); } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

/** Every policy and claim on the cover contract (ids are sequential), cached for 30 s. */
let scanned: { at: number; per: { policies: NonNullable<Awaited<ReturnType<KuasaCover['policy']>>>[]; claims: NonNullable<Awaited<ReturnType<KuasaCover['claim']>>>[] }[]; policies: NonNullable<Awaited<ReturnType<KuasaCover['policy']>>>[]; claims: NonNullable<Awaited<ReturnType<KuasaCover['claim']>>>[] } | undefined;
const books = [cover, ...[state.coverV2, state.coverV1].filter((c): c is string => !!c && BigInt(c) !== coverIndex).map((c) => new KuasaCover(grpc, BigInt(c)))];
async function scanCover() {
  if (scanned && Date.now() - scanned.at < 30_000) return scanned;
  const per: { policies: NonNullable<Awaited<ReturnType<KuasaCover['policy']>>>[]; claims: NonNullable<Awaited<ReturnType<KuasaCover['claim']>>>[] }[] = [];
  for (const c of books) {
    const policies = [];
    for (let i = 0n; ; i++) { const p = await c.policy(i); if (!p) break; policies.push(p); }
    const claims = [];
    for (let i = 0n; ; i++) { const x = await c.claim(i); if (!x) break; claims.push(x); }
    per.push({ policies, claims });
  }
  scanned = { at: Date.now(), per, policies: per.flatMap((b) => b.policies), claims: per.flatMap((b) => b.claims) };
  return scanned;
}
/** Paid claims of an agent payer, across every cover contract (policy ids are per contract). */
const paidClaimsOf = async (payer: string) => (await scanCover()).per.reduce((n, b) => n + b.claims.filter((c) => c.status.tag === 'Paid' && b.policies[Number(c.policyId)]?.agentPayer === payer).length, 0);

/** Public proof of solvency: pool vs the cover still owed by live policies, from on-chain data. */
app.get('/solvency', async (_req, res) => {
  try {
    json(res, await solvencyNow());
  } catch (e) { json(res, { error: (e as Error).message }, 502); }
});

/**
 * Capital providers. The ledger is kept next to the insurer state; premiums, payouts and refunds are
 * reconciled into it every 15 s. Deposits are plain EUDemo transfers into the pool, verified on-chain.
 */
const CAPITAL_FILE = new URL('capital.json', ROOT);
const capitalSnap = existsSync(CAPITAL_FILE) ? fromJsonBig(readFileSync(CAPITAL_FILE, 'utf8')) as { ledger: ReturnType<CapitalLedger['snapshot']>; pending?: { provider: string; amount: bigint; tx: string }[]; seen?: string[]; adjustments?: { at: string; amount: bigint; reason: string }[] } : undefined;
/** Withdrawals submitted but not yet final (persisted; re-checked on startup). */
const pendingWithdrawals: { provider: string; amount: bigint; tx: string }[] = capitalSnap?.pending ?? [];
const capital = new CapitalLedger(capitalSnap?.ledger);
/** Capital operations run one at a time (deposits, withdrawals and their reconciliation). */
let capitalLock: Promise<unknown> = Promise.resolve();
const serialCapital = <T>(fn: () => Promise<T>) => { const r = capitalLock.then(fn); capitalLock = r.catch(() => undefined); return r; };
const pendingOut = () => pendingWithdrawals.reduce((a, p) => a + p.amount, 0n); // withdrawals submitted but not yet final
/**
 * Pool events already booked to capital, by transaction (premium:<tx>, payout:<tx>, refund:<tx>,
 * giveback:<tx>). Transaction hashes are unique on-chain, so a demo reset of the insurer state or a
 * switch to a new cover contract can neither skip nor double-count an event (cumulative counters could).
 */
const seenEvents = new Set<string>(capitalSnap?.seen ?? []);
const adjustments = capitalSnap?.adjustments ?? [];
const classOf = (claimId: string): RiskClass | undefined => {
  const r = svc.state().claims.find((c) => String(c.claimId) === claimId)?.reason;
  return r?.startsWith('AM') ? 'AM' : r?.startsWith('WI') ? 'WI' : r?.startsWith('ML') ? 'ML' : undefined;
};
/** Every pool event the insurer knows about now, with its booking. */
function poolEvents() {
  const st = svc.state();
  return [
    ...st.policies.filter((p) => p.premium !== undefined).map((p) => ({ id: `premium:${p.premiumTx}`, book: () => capital.onPremium(p.premium!) })),
    ...st.payouts.map((p) => ({ id: `payout:${p.tx}`, book: () => capital.onPayout(p.amount, classOf(String(p.claimId)), true) })),
    ...st.refunds.filter((r) => r.tx).map((r) => ({ id: `refund:${r.tx}`, book: () => capital.onPayout(r.amount) })),
    ...st.policies.filter((p) => p.giveback?.tx).map((p) => ({ id: `giveback:${p.giveback!.tx}`, book: () => capital.onPayout(p.giveback!.amount) })),
  ];
}
const saveCapital = () => { const tmp = new URL('capital.json.tmp', ROOT); writeFileSync(tmp, toJsonBig({ ledger: capital.snapshot(), seen: [...seenEvents], adjustments, pending: pendingWithdrawals })); renameSync(tmp, CAPITAL_FILE); };
function reconcileCapital() {
  for (const e of poolEvents()) {
    if (seenEvents.has(e.id)) continue;
    seenEvents.add(e.id);
    e.book();
  }
  saveCapital();
}
/** Event ids in every insurer state file on disk (.kuasa/insurer-state*.json and archive/<run>/insurer-state.json). */
function eventsInStateFiles(): string[] {
  const files: URL[] = readdirSync(ROOT).filter((f) => /^insurer-state.*\.json$/.test(f)).map((f) => new URL(f, ROOT));
  const arch = new URL('archive/', ROOT);
  if (existsSync(arch)) for (const d of readdirSync(arch)) { const f = new URL(`archive/${d}/insurer-state.json`, ROOT); if (existsSync(f)) files.push(f); }
  const ids: string[] = [];
  for (const f of files) {
    try {
      const st = JSON.parse(readFileSync(f, 'utf8')) as { policies?: { premiumTx?: string; giveback?: { tx?: string } }[]; payouts?: { tx?: string }[]; refunds?: { tx?: string }[] };
      for (const p of st.policies ?? []) { if (p.premiumTx) ids.push(`premium:${p.premiumTx}`); if (p.giveback?.tx) ids.push(`giveback:${p.giveback.tx}`); }
      for (const p of st.payouts ?? []) if (p.tx) ids.push(`payout:${p.tx}`);
      for (const r of st.refunds ?? []) if (r.tx) ids.push(`refund:${r.tx}`);
    } catch { /* unreadable file: skip */ }
  }
  return ids;
}
const ledgerTotal = () => capital.balances().reduce((a, b) => a + b.balance, 0n);
/**
 * One-time true-up against the chain: what the providers' balances add up to must equal the pool
 * (minus withdrawals still settling). A difference is a booking error of the insurer, so the insurer's
 * own capital carries it, never outside providers; it is recorded with its reason.
 */
async function trueUp(reason: string) {
  const diff = ledgerTotal() - (await eudemoBalance(treasury.address.address) - pendingOut());
  if (diff === 0n) return;
  capital.adjust(treasury.address.address, -diff);
  adjustments.push({ at: new Date().toISOString(), amount: -diff, reason });
  audit.append({ kind: 'capital-true-up', amount: String(-diff), reason });
}
void (async () => {
  if (capital.balances().length === 0) { // first run: the pool as it stands is the insurer's own capital
    capital.deposit(treasury.address.address, await eudemoBalance(treasury.address.address), 'genesis');
    for (const e of poolEvents()) seenEvents.add(e.id);
    saveCapital();
  } else if (!capitalSnap?.seen) {
    // migration from cumulative counters: everything so far is booked, in every insurer state there
    // is (this one, other cover contracts, archived demo resets); the drift the counters left (state
    // resets made payouts go uncharged) is trued up once against the pool, on the record
    for (const e of poolEvents()) seenEvents.add(e.id);
    for (const id of eventsInStateFiles()) seenEvents.add(id);
    await serialCapital(async () => { await trueUp('migration from cumulative counters: payouts after an insurer state reset had gone uncharged'); saveCapital(); });
  }
  setInterval(reconcileCapital, 15_000);
})();

/** Settle a pending withdrawal once final: drop it, and roll it back if it failed. Retries on any error. */
function watchWithdrawal(p: { provider: string; amount: bigint; tx: string }) {
  const settle = async () => {
    const o = await txOutcomeOf(p.tx);
    if (o === 'pending') { setTimeout(run, 30_000); return; }
    await serialCapital(async () => {
      const i = pendingWithdrawals.indexOf(p);
      if (i < 0) return; // already settled by an earlier run
      pendingWithdrawals.splice(i, 1);
      if (o === 'failed') capital.unwithdraw(p.provider, p.amount);
      saveCapital();
    });
    audit.append({ kind: 'capital-withdrawal-settled', provider: p.provider, amount: String(p.amount), tx: p.tx, outcome: o });
  };
  const run = () => { settle().catch(() => setTimeout(run, 30_000)); };
  setTimeout(run, 30_000);
}
for (const p of pendingWithdrawals) watchWithdrawal(p); // re-check after a restart
const LOCKUP_MS = Number(process.env.KUASA_CAPITAL_LOCKUP_MS ?? 7 * 86_400_000);
/** Premium payments also land in the pool; they are never capital. */
const isPremiumTx = (tx: string) => { const st = svc.state(); return [...st.policies, ...st.unissued, ...st.needsRefund].some((p) => (p as { premiumTx?: string }).premiumTx === tx); };

const capitalView = async () => {
  const s = await solvencyNow();
  return { pool: s.pool, exposure: s.exposure, providers: capital.balances().map((b) => ({ ...b, share: s.pool > 0n ? Number((b.balance * 10_000n) / s.pool) / 100 : 0 })) };
};
app.get('/capital', async (_req, res) => { try { json(res, await capitalView()); } catch (e) { json(res, { error: (e as Error).message }, 502); } });

/** A provider sends EUDemo to the pool, then registers the transfer here (verified on-chain). */
app.post('/capital/deposit', async (req, res) => {
  const tx = String(req.body?.tx ?? '');
  if (!/^[0-9a-f]{64}$/.test(tx)) return json(res, { error: 'send { tx: <transfer hash> }' }, 400);
  try {
    const st = await grpc.getBlockItemStatus(sdk.TransactionHash.fromHexString(tx));
    if (st.status !== 'finalized' || !st.outcome) return json(res, { error: 'transaction not finalized' }, 400);
    const sum = st.outcome.summary as unknown as { transactionType?: string; events?: { tag: string; tokenId: string; from: { address: string }; to: { address: string }; amount: { value: string }; memo?: string }[] };
    const transfers = (sum.events ?? []).filter((e) => e.tag === 'TokenTransfer' && String(e.tokenId) === ASSET && String(e.to?.address) === treasury.address.address);
    if (sum.transactionType !== 'tokenUpdate' || transfers.length !== 1) return json(res, { error: 'not a single EUDemo transfer into the pool' }, 400);
    const memoHex = typeof transfers[0].memo === "string" ? transfers[0].memo : (JSON.parse(JSON.stringify(transfers[0].memo ?? null)) as string | null) ?? undefined; // CborMemo serialises to hex
    const cls = capitalClassOf(memoHex);
    if (!cls) return json(res, { error: 'a capital deposit carries the memo "kuasa capital" (or "kuasa capital:AM|WI|ML" to back one risk class, or "kuasa capital:junior" for the junior tranche)' }, 400);
    if (isPremiumTx(tx)) return json(res, { error: 'this transfer is a premium payment, not capital' }, 400);
    const provider = String(transfers[0].from.address);
    await serialCapital(async () => {
      if (svc.isPaying(provider)) throw new Error('a premium payment from this account is settling; register the deposit again in a minute');
      reconcileCapital(); // results so far belong to the providers who carried the risk
      capital.deposit(provider, BigInt(transfers[0].amount.value), tx, Date.now(), cls === 'general' ? undefined : cls);
      saveCapital();
    });
    audit.append({ kind: 'capital-deposit', provider, amount: transfers[0].amount.value, tx });
    json(res, await capitalView());
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

/** A provider withdraws (signed x-kuasa-payer* proof); refused if live cover would be left uncovered. */
app.post('/capital/withdraw', async (req, res) => {
  const provider = String(req.header('x-kuasa-payer') ?? '');
  try {
    if (!(await verifyPayerProof({ header: (n) => req.header(n), payer: provider, audience: PUBLIC_URL, accountInfo: (a) => grpc.getAccountInfo(a) }))) return json(res, { error: 'provider proof required' }, 401);
    const amount = big(req.body?.amount);
    if (svc.jurorBusy(provider)) return json(res, { error: 'this juror has a vote on an undecided appeal: its stake stays until the appeal is decided' }, 400);
    const paid = await serialCapital(async () => {
      if (svc.jurorBusy(provider)) throw new Error('this juror has a vote on an undecided appeal: its stake stays until the appeal is decided');
      reconcileCapital();
      const sv = await solvencyNow();
      capital.withdraw(provider, amount, { pool: sv.pool - pendingOut(), exposure: sv.exposure }, Date.now(), LOCKUP_MS); // in-flight withdrawals already left
      saveCapital();
      let hash: string;
      try {
        hash = await treasuryPay(provider, amount, 'kuasa cover capital withdrawal');
      } catch (e) {
        capital.unwithdraw(provider, amount); // never submitted: nothing left the pool
        saveCapital();
        throw e;
      }
      // Roll back only on a final "failed". If finality is not confirmed yet the withdrawal stays
      // booked (the transfer may still land); it shows as pending in the audit log.
      const outcome = await txOutcomeOf(hash);
      if (outcome === 'failed') {
        capital.unwithdraw(provider, amount);
        saveCapital();
        throw new Error('the withdrawal transfer failed on-chain; nothing was paid');
      }
      if (outcome === 'pending') {
        audit.append({ kind: 'capital-withdrawal-pending', provider, amount: String(amount), tx: hash });
        const p = { provider, amount, tx: hash };
        pendingWithdrawals.push(p);
        saveCapital();
        watchWithdrawal(p);
      }
      return hash;
    });
    audit.append({ kind: 'capital-withdrawal', provider, amount: String(amount), tx: paid });
    json(res, { tx: paid, ...(await capitalView()) });
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

/** Anyone who proves control of a Concordium account (x-kuasa-payer* headers, payer = objector) can hold an automatic payout. */
app.post('/claims/:id/object', async (req, res) => {
  const by = String(req.header('x-kuasa-payer') ?? '');
  try {
    await svc.object(big(req.params.id), { by, reason: String(req.body?.reason ?? ''), proof: (n: string) => req.header(n) });
    audit.append({ kind: 'claim-objection', claimId: req.params.id, by, reason: String(req.body?.reason ?? '').slice(0, 280) });
    json(res, { held: true });
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

/** A human takes a claim over (no automatic payout). */
app.post('/claims/:id/hold', consoleOnly, (req, res) => {
  try { svc.hold(big(req.params.id)); json(res, { held: true }); } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

/** A claim's evidence document by its hash (sha256 of its canonical JSON is the claim's on-chain `evidence`). Console only: it carries the claimant's own note; publication is curated (scripts/publish-evidence.ts). */
app.get('/evidence/:hash', consoleOnly, async (req, res) => {
  for (const c of svc.state().claims) {
    if (c.evidenceDoc && await evidenceHash(c.evidenceDoc) === req.params.hash) return res.type('json').send(canonicalJson(c.evidenceDoc));
  }
  json(res, { error: 'no such evidence document' }, 404);
});

/** Appeals panel: open appeals and votes (public), and a juror's signed vote. */
app.get('/appeals', (_req, res) => json(res, svc.openAppeals()));
app.post('/appeals/:id/vote', async (req, res) => {
  const juror = String(req.header('x-kuasa-payer') ?? '');
  // the juror signs with its own account key (same signed-request format as an agent payer proof)
  const ok = await verifyPayerProof({ header: (n) => req.header(n), payer: juror, audience: PUBLIC_URL, accountInfo: (a) => grpc.getAccountInfo(a) }).catch(() => false);
  if (!ok) return json(res, { error: 'juror signature required' }, 401);
  try {
    const r = await svc.panelVote(big(req.params.id), juror, req.body?.approve === true);
    audit.append({ kind: 'panel-vote', claimId: req.params.id, juror, approve: req.body?.approve === true, decided: r.decided });
    if (r.decided && 'approve' in r) publishDecision(big(req.params.id), 'panel', r.approve ? 'approved' : 'rejected', 'paid' in r ? r.paid : undefined);
    json(res, r);
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

/** Owner-facing: parametric detections and the purchase hold on an agent (both public on-chain anyway). */
app.get('/detections/:payer', (req, res) => json(res, { detections: svc.detectionsOf(req.params.payer), hold: svc.holdOf(req.params.payer) }));
/** The owner resumes a paused agent (console = the owner's side in the demo). */
app.post('/holds/:payer/clear', consoleOnly, async (req, res) => {
  try {
    const cleared = await svc.clearHold(String(req.params.payer));
    if (cleared) audit.append({ kind: 'hold-cleared', payer: req.params.payer, by: 'owner (console)' });
    json(res, { cleared });
  } catch (e) { json(res, { error: (e as Error).message }, 400); }
});

/**
 * Parametric monitoring: follow finalized blocks and feed every kuasa-registry receipt to the
 * insurer, which spots duplicate orders on insured agents within seconds of the second receipt.
 */
let watchHeight: bigint | null = null;
let watching = false;
async function watchBlocks() {
  if (watching) return;
  watching = true;
  try {
    const top = await finalizedHeight(grpc);
    watchHeight ??= top - BigInt(process.env.KUASA_WATCH_LOOKBACK ?? 300); // ~10 minutes back at start
    for (let n = 0; watchHeight < top && n < 100; n++) {
      const seen = await registryReceiptsAt(grpc, watchHeight + 1n, registryIndex);
      const found = await svc.onReceipts(seen);
      for (const d of found) {
        audit.append({ kind: 'duplicate-detected', payer: d.payer, policyId: String(d.policyId), orders: d.orders, paymentTxs: d.paymentTxs });
        console.log(`[insurer] duplicate orders detected for ${d.payer} (policy #${d.policyId}); purchases held`);
      }
      watchHeight += 1n;
    }
    await svc.publishHolds();
  } catch (e) {
    console.error('[insurer] block watch', (e as Error).message); // same height is retried next tick
  } finally {
    watching = false;
  }
}
setInterval(() => { void watchBlocks(); }, 4_000);

setInterval(() => { void svc.retryUnissued(); }, 60_000);
setInterval(() => { void svc.givebackExpired().catch((e) => console.error('[insurer] giveback failed', (e as Error).message)); }, 300_000);
setInterval(() => {
  const before = svc.state().refunds.length;
  void svc.refundCancelled()
    .then(() => { for (const r of svc.state().refunds.slice(before)) audit.append({ kind: 'premium-refunded', policyId: String(r.policyId), to: r.to, amount: String(r.amount), tx: r.tx }); })
    .catch((e) => console.error('[insurer] refund failed', (e as Error).message));
}, 60_000);
// claims paid automatically before this start were audited then (the set itself is not persisted)
const publishChecked = new Set<string>();
const autoAudited = new Set<string>(svc.state().claims.filter((c) => c.decidedBy === 'auto' && c.paid).map((c) => String(c.claimId)));
setInterval(() => {
  void svc.runAutoPay().then(() => {
    for (const c of svc.state().claims) {
      if (c.decidedBy !== 'auto' || !c.paid) continue;
      // once per process: publishDecision reads first and writes only if the decision is missing on-chain
      if (!publishChecked.has(String(c.claimId))) { publishChecked.add(String(c.claimId)); publishDecision(c.claimId, 'auto', 'approved', c.paid); }
      if (autoAudited.has(String(c.claimId))) continue;
      autoAudited.add(String(c.claimId));
      audit.append({ kind: 'claim-decided', claimId: String(c.claimId), approve: true, by: c.autoApproveTx ? 'automatic, accepted on-chain by the contract rules (autoApprove)' : 'automatic (below the auto-pay limit, objection window passed)', autoApproveTx: c.autoApproveTx, paid: c.paid });
    }
  });
}, 15_000);
app.listen(PORT, process.env.HOST ?? '127.0.0.1', () => console.log(`[insurer] http://localhost:${PORT}  cover <${state.cover},0>  treasury ${treasury.address.address}`));
