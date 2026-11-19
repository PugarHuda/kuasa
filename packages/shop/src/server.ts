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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { x402Facilitator } from '@x402/core/facilitator';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { CONCORDIUM_TESTNET_CAIP2, toConcordiumFacilitatorSigner } from '@x402/concordium';
import { ExactConcordiumScheme as FacilitatorScheme } from '@x402/concordium/exact/facilitator';
import { ExactConcordiumScheme as ServerScheme } from '@x402/concordium/exact/server';
import { bigintJson, connect, KuasaCover, KuasaRegistry, TESTNET, wallet } from '@kuasa/chain';
import { Cis8004Registry, KuasaGuard, MANDATE_HEADER, type Offer } from '@kuasa/merchant';

const ROOT = new URL('../../../.kuasa/', import.meta.url);
const PORT = Number(process.env.PORT ?? 4021);
const state = JSON.parse(readFileSync(new URL('state.json', ROOT), 'utf8')) as { registry: string; cover?: string; shopAgent?: string };
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

const grpc = connect();
const registry = new KuasaRegistry(grpc, BigInt(state.registry));
const guard = new KuasaGuard({
  grpc, network: 'Testnet', registry,
  offers: Object.fromEntries(Object.entries(catalog).map(([p, o]) => [p, { category: o.category, requirements: o.requirements }])),
  recorder: wallet(sponsor.address, sponsor.key),
  localOrigin: `http://localhost:${PORT}`, // demo: documents are served by this same process
  agents: new Cis8004Registry(grpc),
  cover: state.cover ? new KuasaCover(grpc, BigInt(state.cover)) : undefined,
});

const grpcCfg = { host: TESTNET.grpc.host, port: TESTNET.grpc.port, useTls: true };
const facilitator = new x402Facilitator().register(CONCORDIUM_TESTNET_CAIP2,
  new FacilitatorScheme({ signer: toConcordiumFacilitatorSigner(sponsor.address, sponsor.key, grpcCfg) }));
const server = new x402ResourceServer(facilitator as never).register(CONCORDIUM_TESTNET_CAIP2, new ServerScheme());
server.onBeforeVerify(guard.beforeVerify as never).onAfterSettle(guard.afterSettle as never).onSettleFailure(guard.settleFailed as never);

const routes = Object.fromEntries(Object.entries(catalog).map(([path, p]) => [`GET ${path}`, {
  accepts: { scheme: 'exact', network: CONCORDIUM_TESTNET_CAIP2, payTo, price: { amount: String(p.price), asset: ASSET }, maxTimeoutSeconds: 120 },
  description: p.name, mimeType: 'application/json',
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

app.get('/catalog', (_, res) => json(res, Object.entries(catalog).map(([path, p]) => ({ path, name: p.name, price: p.price, asset: ASSET, category: p.category, requirements: p.requirements }))));

/** Free pre-flight: would this agent be allowed to buy `path`? Same decision as the paid route. */
app.get('/quote', async (req, res) => {
  const path = String(req.query.path ?? '');
  const p = catalog[path];
  if (!p) return json(res, { ok: false, reasons: ['unknown product'] }, 404);
  const payer = String(req.query.payer ?? '');
  const d = await guard.decide({ mandateUrl: req.header(MANDATE_HEADER), route: path, payer, payTo, asset: ASSET, amount: p.price });
  // An order reference lets the agent buy per-order cover before paying (send it back in x-kuasa-order).
  const orderRef = d.ok || d.reasons.every((r) => r.startsWith('cover required')) ? await guard.issueOrderRef({ payer, payTo, route: path, amount: p.price }) : undefined;
  json(res, { ...d, orderRef, amount: p.price, payTo });
});

// Operator view for the console: loopback only.
/** Lets a buyer find the on-chain receipt for its own payment (both are public on-chain). */
app.get('/receipt/:paymentTx', (req, res) => {
  const r = guard.receipts.find((x) => x.paymentTx === req.params.paymentTx);
  return r ? json(res, { order: r.order, orderRef: r.orderRef, receiptTx: r.receiptTx, amount: r.amount }) : json(res, { pending: true }, 404);
});

app.get('/kuasa-log', (req, res) => !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ? json(res, { error: 'forbidden' }, 403) : json(res, { log: guard.log.slice(-50), receipts: guard.receipts, unrecorded: guard.unrecorded, registry: `<${state.registry},0>`, payTo, sponsor: sponsor.address }));

app.use(paymentMiddleware(routes as never, server));
for (const [path, p] of Object.entries(catalog)) {
  app.get(path, (_, res) => json(res, { ok: true, item: p.name, price: p.price, asset: ASSET, shipped: 'order confirmed; ships to the address on file' }));
}

app.listen(PORT, () => console.log(`[shop] http://localhost:${PORT}  registry <${state.registry},0>  payTo ${payTo}`));
