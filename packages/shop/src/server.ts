/**
 * Kuasa demo shop: a regulated-goods merchant that sells to AI agents over x402.
 *
 * - x402 (exact scheme) priced in EUDemo, an allow-listed euro PLT: only identity-verified EU
 *   accounts can hold or move it, so compliance is enforced by the token itself. An in-process
 *   facilitator (merchant account #1) sponsors the fee, so the agent never needs CCD for gas.
 * - KuasaGuard hooks: before any money moves, the agent's mandate, its owner's ZK proof and the
 *   on-chain registry entry are checked; after settlement a receipt is anchored on-chain.
 * - Also serves the public Kuasa documents (mandates, proofs, agent cards) from .kuasa/public.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { x402Facilitator } from '@x402/core/facilitator';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { CONCORDIUM_TESTNET_CAIP2, toConcordiumFacilitatorSigner } from '@x402/concordium';
import { ExactConcordiumScheme as FacilitatorScheme } from '@x402/concordium/exact/facilitator';
import { ExactConcordiumScheme as ServerScheme } from '@x402/concordium/exact/server';
import { AuditLog, bigintJson, cis8004GetMetadata, cis8004SetMetadata, claimKey, connect, KuasaCover, KuasaRegistry, registerData, TESTNET, wallet } from '@kuasa/chain';
import { Cis8004Registry, KuasaGuard, MANDATE_HEADER, type Offer, signDeliveryNote, verifyPayerProof } from '@kuasa/merchant';

const ROOT = new URL('../../../.kuasa/', import.meta.url);
const PORT = Number(process.env.PORT ?? 4021);
const state = JSON.parse(readFileSync(new URL('state.json', ROOT), 'utf8')) as { registry: string; cover?: string; shopAgent?: string; insurerAgent?: string; market?: { name: string; cover: string }[] };
const merchant = JSON.parse(readFileSync(new URL('accounts/merchant.json', ROOT), 'utf8')).accounts as { credNumber: number; address: string; key: string }[];
const payTo = merchant.find((a) => a.credNumber === 0)!.address;
const sponsor = merchant.find((a) => a.credNumber === 1)!;

/** Payment asset: a PLT token id (6 decimals) or "CCD". */
const ASSET = process.env.KUASA_ASSET ?? 'EUDemo';
const UNIT = 1_000_000n;
const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];

/** Catalog: path -> product. Paths are the x402 route patterns, which KuasaGuard keys offers by. */
/** Wine needs Kuasa Cover for the order once the cover contract is deployed. */
const WINE_COVER = state.cover ? { minCover: 20n * UNIT } : {};
const catalog: Record<string, { name: string; price: bigint } & Offer> = {
  '/shop/wine/rioja': { name: 'Rioja Reserva 2019, 75cl', price: 24n * UNIT, category: 'wine', requirements: { minAge: 18, residencyIn: EU, ...WINE_COVER } },
  '/shop/wine/case': { name: 'Case of 6 Rioja Reserva', price: 60n * UNIT, category: 'wine', requirements: { minAge: 18, residencyIn: EU, ...WINE_COVER } },
  '/shop/groceries/bread': { name: 'Sourdough loaf', price: 3n * UNIT, category: 'groceries', requirements: {} },
  '/shop/vape/mint': { name: 'Mint e-liquid 10ml', price: 10n * UNIT, category: 'vape', requirements: { minAge: 18, residencyIn: EU } },
};

/** Staged warehouse mis-picks for the demo: route -> what actually gets packed. */
const mispick = new Map<string, string>();
const recorderWallet = wallet(sponsor.address, sponsor.key);

const grpc = connect();
/** Signed requests may be addressed to the shop locally or at its public URL (e.g. a tunnel). */
const AUDIENCES = [`http://localhost:${PORT}`, ...(process.env.KUASA_PUBLIC_URL ? [process.env.KUASA_PUBLIC_URL.replace(/\/$/, '')] : [])];
const registry = new KuasaRegistry(grpc, BigInt(state.registry));
/**
 * Cover from every insurer on the market counts: period cover adds up (co-insurance: each insurer pays
 * its own policy), order cover is the largest single order policy. One unreadable insurer fails closed.
 */
function marketCover(indexes: string[]) {
  const books = indexes.map((i) => new KuasaCover(grpc, BigInt(i)));
  return {
    coverOf: async (payer: string, order?: string) => {
      const vs = await Promise.all(books.map((b) => b.coverOf(payer, order)));
      return {
        periodRemaining: vs.reduce((a, v) => a + v.periodRemaining, 0n),
        orderLimit: vs.reduce((a, v) => (v.orderLimit > a ? v.orderLimit : a), 0n),
        policyId: vs.find((v) => v.policyId !== null)?.policyId ?? null,
      };
    },
  };
}
const guard = new KuasaGuard({
  grpc, network: 'Testnet', registry,
  offers: Object.fromEntries(Object.entries(catalog).map(([p, o]) => [p, { category: o.category, requirements: o.requirements }])),
  recorder: wallet(sponsor.address, sponsor.key),
  localOrigin: `http://localhost:${PORT}`, // demo: documents are served by this same process
  agents: new Cis8004Registry(grpc),
  cover: state.cover ? marketCover([state.cover, ...(state.market ?? []).map((m) => m.cover)]) : undefined,
  // the insurer's circuit breaker, read from its CIS-8004 entry
  holdOf: state.insurerAgent ? (payer) => cis8004GetMetadata(grpc, state.insurerAgent!, `kuasa:hold:${payer}`) : undefined,
});

const grpcCfg = { host: TESTNET.grpc.host, port: TESTNET.grpc.port, useTls: true };
const facilitator = new x402Facilitator().register(CONCORDIUM_TESTNET_CAIP2,
  new FacilitatorScheme({ signer: toConcordiumFacilitatorSigner(sponsor.address, sponsor.key, grpcCfg) }));
const server = new x402ResourceServer(facilitator as never).register(CONCORDIUM_TESTNET_CAIP2, new ServerScheme()).registerExtension(bazaarResourceServerExtension);
// Receipts survive restarts (buyers look them up to file claims).
const RECEIPTS = new URL('shop-receipts.json', ROOT);
if (existsSync(RECEIPTS)) guard.receipts.push(...JSON.parse(readFileSync(RECEIPTS, 'utf8')));
const saveReceipts = () => { const tmp = new URL('shop-receipts.json.tmp', ROOT); writeFileSync(tmp, JSON.stringify(guard.receipts)); renameSync(tmp, RECEIPTS); };
// EU AI Act Art. 12: every guard decision is logged; batches are anchored on-chain every minute.
const audit = new AuditLog({ dir: new URL('audit/shop/', ROOT), register: (d) => registerData(grpc, d, wallet(sponsor.address, sponsor.key)) })
  .start(60_000, (e) => console.error('[audit]', e.message));
server.onBeforeVerify((async (ctx: Parameters<typeof guard.beforeVerify>[0]) => {
  const r = await guard.beforeVerify(ctx);
  const payer = (ctx.paymentPayload.payload as { signedTransaction?: { header?: { sender?: string } } })?.signedTransaction?.header?.sender;
  audit.append({ kind: 'guard-decision', payer, payTo: ctx.requirements.payTo, amount: ctx.requirements.amount, outcome: r ? 'refused' : 'allowed', reason: r?.message });
  return r;
}) as never)
  .onAfterSettle((async (ctx: Parameters<typeof guard.afterSettle>[0]) => {
    await guard.afterSettle(ctx);
    // Fulfilment scan: what was actually packed for this order (a staged mis-pick ships something else).
    const r = guard.receipts.find((x) => x.paymentTx === ctx.result.transaction);
    const wrong = r?.route ? mispick.get(r.route) : undefined;
    if (r && wrong) { r.shipped = wrong; mispick.delete(r.route!); }
    saveReceipts(); audit.append({ kind: 'settled', paymentTx: ctx.result.transaction, amount: ctx.requirements.amount }); }) as never)
  .onSettleFailure(guard.settleFailed as never)
  .onAfterVerify(guard.afterVerify as never)
  .onVerifyFailure(guard.verifyFailed as never)
  .onVerifiedPaymentCanceled(guard.verifiedCanceled as never);

const routes = Object.fromEntries(Object.entries(catalog).map(([path, p]) => [`GET ${path}`, {
  accepts: { scheme: 'exact', network: CONCORDIUM_TESTNET_CAIP2, payTo, price: { amount: String(p.price), asset: ASSET }, maxTimeoutSeconds: 120 },
  description: p.name, mimeType: 'application/json', serviceName: 'Kuasa demo shop', tags: ['kuasa', p.category],
  // x402 Bazaar discovery: agents can find this resource and how to call it
  extensions: declareDiscoveryExtension({ input: {}, output: { example: { ok: true, item: p.name, shipped: 'order confirmed' } } }),
}]));

const app = express();
const json = (res: express.Response, body: unknown, status = 200) => res.status(status).type('json').send(JSON.stringify(body, bigintJson));

app.use((_, res, next) => { res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*'); res.setHeader('access-control-expose-headers', '*'); next(); });
app.use('/kuasa', express.static(fileURLToPath(new URL('public/', ROOT))));

/** A2A Agent Card with the Kuasa extension: buying agents check this token in CIS-8004 before paying. */
app.get('/.well-known/agent-card.json', (_, res) => json(res, {
  name: 'Kuasa demo shop', description: 'Regulated goods for AI agents (age and residency checked with ZK proofs; insured purchases).',
  url: `http://localhost:${PORT}`, protocols: ['x402', 'kuasa/v1'],
  kuasa: { payTo, agentToken: state.shopAgent, agentRegistry: '<12802,0>', asset: ASSET, cover: state.cover ? `<${state.cover},0>` : undefined },
}));

/** x402 discovery listing (Bazaar shape) of every paid resource, with the Kuasa requirements an agent must meet. */
app.get('/discovery/resources', (_req, res) => json(res, { x402Version: 2, items: Object.entries(catalog).map(([path, p]) => ({ resource: `http://localhost:${PORT}${path}`, type: 'http', method: 'GET', accepts: [{ scheme: 'exact', network: CONCORDIUM_TESTNET_CAIP2, payTo, amount: String(p.price), asset: ASSET }], metadata: { description: p.name, category: p.category, kuasa: { requirements: p.requirements, mandateHeader: MANDATE_HEADER } } })) }));

app.get('/catalog', (_, res) => json(res, Object.entries(catalog).map(([path, p]) => ({ path, name: p.name, price: p.price, asset: ASSET, category: p.category, requirements: p.requirements }))));

/** Free pre-flight: would this agent be allowed to buy `path`? Same decision as the paid route. */
app.get('/quote', async (req, res) => {
  const path = String(req.query.path ?? '');
  const p = catalog[path];
  if (!p) return json(res, { ok: false, reasons: ['unknown product'] }, 404);
  const payer = String(req.query.payer ?? '');
  const d = await guard.decide({ mandateUrl: req.header(MANDATE_HEADER), route: path, payer, payTo, asset: ASSET, amount: p.price });
  // An order reference lets the agent buy per-order cover before paying (send it back in x-kuasa-order).
  // Only for a requester who proves control of the payer (mandate URLs are public).
  let orderRef: string | undefined;
  let orderRefNote: string | undefined;
  if (d.ok || d.reasons.every((r) => r.startsWith('cover required'))) {
    const proven = await verifyPayerProof({ header: (n) => req.header(n), payer, audience: AUDIENCES, accountInfo: (a) => grpc.getAccountInfo(a) });
    if (!proven) orderRefNote = 'payer proof required for an order reference';
    else orderRef = await guard.issueOrderRef({ payer, payTo, route: path, amount: p.price }).catch((e) => { orderRefNote = (e as Error).message; return undefined; });
  }
  json(res, { ...d, orderRef, orderRefNote, amount: p.price, payTo });
});

// Operator view for the console: loopback only.
/** Lets a buyer find the on-chain receipt for its own payment (both are public on-chain). */
app.get('/receipt/:paymentTx', (req, res) => {
  const r = guard.receipts.find((x) => x.paymentTx === req.params.paymentTx);
  return r ? json(res, { order: r.order, orderRef: r.orderRef, receiptTx: r.receiptTx, amount: r.amount }) : json(res, { pending: true }, 404);
});

/** The agent's own purchase history (needs its payer proof: what was bought is not on-chain). */
app.get('/payments/:payer', async (req, res) => {
  const payer = req.params.payer;
  const ok = await verifyPayerProof({ header: (n) => req.header(n), payer, audience: AUDIENCES, accountInfo: (a) => grpc.getAccountInfo(a) }).catch(() => false);
  if (!ok) return json(res, { error: 'payer proof required' }, 401);
  json(res, guard.receipts.filter((r) => r.payer === payer).slice(-20).map(({ route, amount, paymentTx, at }) => ({ item: route, amount, paymentTx, at: at && new Date(at).toISOString() })));
});

/**
 * Signed delivery note for one of the buyer's orders: ordered vs. shipped item, signed by the account
 * that recorded the receipt on-chain. It is the evidence for a wrong-item or outside-intent claim.
 */
app.get('/delivery/:paymentTx', async (req, res) => {
  const r = guard.receipts.find((x) => x.paymentTx === req.params.paymentTx);
  if (!r?.payer || !r.route) return json(res, { error: 'unknown order' }, 404);
  const ok = await verifyPayerProof({ header: (n) => req.header(n), payer: r.payer, audience: AUDIENCES, accountInfo: (a) => grpc.getAccountInfo(a) }).catch(() => false);
  if (!ok) return json(res, { error: 'payer proof required' }, 401);
  const note = { v: 1 as const, order: r.order, paymentTx: r.paymentTx, ordered: r.route, shipped: r.shipped ?? r.route, at: r.at ?? 0 };
  json(res, await signDeliveryNote(note, sponsor.address, recorderWallet.signer));
});

const loopback = (req: express.Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
/** Demo only (loopback): the warehouse mis-picks the next order of `route` and ships `ship` instead. */
app.post('/demo/mispick', express.json(), (req, res) => {
  const { route, ship } = req.body ?? {};
  if (!loopback(req)) return json(res, { error: 'forbidden' }, 403);
  if (!catalog[route] || !catalog[ship] || route === ship) return json(res, { error: 'route and ship must be two different catalog paths' }, 400);
  mispick.set(route, ship);
  json(res, { staged: { route, ship } });
});

app.get('/kuasa-log', (req, res) => !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ? json(res, { error: 'forbidden' }, 403) : json(res, { log: guard.log.slice(-50), receipts: guard.receipts, audit: audit.anchors(), unrecorded: guard.unrecorded, registry: `<${state.registry},0>`, payTo, sponsor: sponsor.address }));

app.use(paymentMiddleware(routes as never, server));
for (const [path, p] of Object.entries(catalog)) {
  app.get(path, (_, res) => json(res, { ok: true, item: p.name, price: p.price, asset: ASSET, shipped: 'order confirmed; ships to the address on file' }));
}

/**
 * Counterparty attestation for every new Kuasa Cover claim: is each claimed order in our sales book,
 * sold under the mandate of the policy being claimed on? Published as kuasa:attest:<id> on the shop's
 * own CIS-8004 entry (owner account). scripts/merchant-attest.ts backfills older claims.
 */
const owner = merchant.find((a) => a.credNumber === 0)!;
let attestFrom = 0n;
async function attestNewClaims() {
  if (!state.cover || !state.shopAgent) return;
  const cover = new KuasaCover(grpc, BigInt(state.cover));
  for (let id = attestFrom; ; id++) {
    const c = await cover.claim(id);
    if (!c) { attestFrom = id; return; }
    const key = claimKey('attest', state.cover, id);
    if (await cis8004GetMetadata(grpc, state.shopAgent, key)) continue;
    const mandateId = (await cover.policy(c.policyId))?.mandate.id;
    const found = c.orders.filter((o) => guard.receipts.some((r) => r.order === o && r.mandate === mandateId)).length;
    const verdict = new Set(c.orders).size < c.orders.length ? 'orders-duplicate' : found === c.orders.length ? 'orders-match' : found === 0 ? 'orders-unknown' : 'orders-partial';
    const value = `${verdict};orders=${found}/${c.orders.length};src=sales-book;by=merchant;at=${Math.floor(Date.now() / 1000)}`;
    await cis8004SetMetadata(grpc, state.shopAgent, key, value, wallet(owner.address, owner.key));
    audit.append({ kind: 'claim-attested', claimId: String(id), verdict });
  }
}
setInterval(() => { void attestNewClaims().catch((e) => console.error('[shop] attestation failed', (e as Error).message)); }, 60_000);

app.listen(PORT, process.env.HOST ?? '127.0.0.1', () => console.log(`[shop] http://localhost:${PORT}  registry <${state.registry},0>  payTo ${payTo}`));
