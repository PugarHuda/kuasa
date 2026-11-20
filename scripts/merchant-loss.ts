/**
 * The other side of the market: a merchant harmed by an insured agent claims on the agent's cover.
 *   1. Alice's agent buys period cover, then a perishable order (bread).
 *   2. The order is refused at delivery; the shop files an incident on Alice's mandate (on-chain).
 *   3. The shop's recorder account files a MerchantLoss claim on Alice's policy (fee sponsored).
 *      Only a recorder named in the mandate may file this kind; the assessor needs the receipt and
 *      the incident. A loss this small is paid to the shop automatically after the objection window.
 * Needs shop, insurer and console running. Usage: tsx merchant-loss.ts
 */
import { readFileSync } from 'node:fs';
import { KuasaAgent } from '@kuasa/agent';
import { loadProfile } from './lib/identity.js';

const EUR = 1_000_000n;
const SHOP = process.env.KUASA_SHOP_URL ?? 'http://localhost:4021';
const CONSOLE = process.env.KUASA_CONSOLE_URL ?? 'http://localhost:4022';
const alice = KuasaAgent.fromDemo('alice');

const cover = await alice.coverBuy(30n * EUR, 30);
if (!cover.ok) throw new Error(`cover: ${JSON.stringify(cover)}`);
const policyId = String(cover.policy.policyId);
console.log('1. Alice\'s agent insured: policy', policyId, 'premium tx', cover.paymentTx);

const order = await alice.buy('/shop/groceries/bread');
if (!order.ok) throw new Error(`order: ${JSON.stringify(order)}`);
console.log('   perishable order paid', order.paymentTx);
await alice.receiptOf(order.paymentTx); // the shop has recorded the receipt on-chain

const incident = await (await fetch(`${CONSOLE}/api/incident/alice`, { method: 'POST', headers: { 'x-kuasa-console': '1' } })).json() as { tx?: string; error?: string };
if (!incident.tx) throw new Error(`incident: ${incident.error}`);
console.log('2. order refused at delivery; shop filed an incident on the mandate', incident.tx);

const recorder = loadProfile('merchant').accounts.find((a) => a.credNumber === 1)!;
const scope = JSON.parse(readFileSync(new URL('../.kuasa/public/mandate/alice.json', import.meta.url), 'utf8')).scope;
const shop = new KuasaAgent({ shopUrl: SHOP, mandateUrl: `${SHOP}/kuasa/mandate/alice.json`, payer: recorder.address, payerKey: recorder.key, scope });
const claim = await shop.fileClaim('MerchantLoss', [order.paymentTx], 3n * EUR, 'perishable order refused at delivery', policyId);
console.log('3. MerchantLoss claim', JSON.stringify(claim));
process.exit(0);
