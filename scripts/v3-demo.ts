/**
 * kuasa-cover v3 live on testnet:
 *   1. Alice's agent buys period cover under her owner-signed AP2 intent; the insurer anchors the
 *      intent hash on the policy (setTerms). Alice then bonds her agent with 10 CCD (postBond); the
 *      next quote shows the "operator bond" discount.
 *   2. Fully parametric: the agent pays twice for bread. The insurer spots it on-chain, pauses the
 *      agent and files the claim itself (fileClaimFor); after the objection window the contract
 *      accepts autoApprove and it is paid. Nobody filed anything by hand.
 *   3. Bonded objection: a second duplicate is filed by the insurer; the shop objects on-chain and
 *      locks the 1 CCD objection bond. The contract now refuses autoApprove; a human decides, and
 *      the bond is returned (objection upheld) or goes to the pool (objection failed).
 *   4. Merchant-paid cover: the shop pays the per-order premium for Alice's wine order; the quote
 *      shows order velocity after the agent's burst of orders. The agent then buys the insured wine.
 * Needs shop (4021), insurer (4023) and console (4022) running on v3.
 * Usage: tsx v3-demo.ts [--steps=policy,parametric,objection,sponsor]
 */
import { readFileSync } from 'node:fs';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { KuasaAgent } from '@kuasa/agent';
import { connect, KuasaCover, wallet } from '@kuasa/chain';
import { makePayerProof, signAp2Intent } from '@kuasa/merchant';
import { loadProfile } from './lib/identity.js';

const SHOP = process.env.KUASA_SHOP_URL ?? 'http://localhost:4021';
const INSURER = process.env.KUASA_INSURER_URL ?? 'http://localhost:4023';
const CONSOLE = process.env.KUASA_CONSOLE_URL ?? 'http://localhost:4022';
const EUR = 1_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const steps = process.argv.find((a) => a.startsWith('--steps='))?.slice(8).split(',') ?? ['policy', 'parametric', 'objection', 'sponsor'];

const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { cover: string; mandates: Record<string, { payer: string }> };
const cover = new KuasaCover(connect(), BigInt(st.cover));
const alice = KuasaAgent.fromDemo('alice');
const payer = st.mandates.alice.payer;
const owner = loadProfile('alice').accounts.find((a) => a.credNumber === 0)!;
const recorder = loadProfile('merchant').accounts.find((a) => a.credNumber === 1)!;
const merchant = loadProfile('merchant').accounts.find((a) => a.credNumber === 0)!;
const insurerState = async () => (await fetch(`${INSURER}/state`, { headers: { 'x-kuasa-console': '1' } })).json() as Promise<{ claims: { claimId: string; paid?: string; autoApproveTx?: string; reason?: string; assessment: { ok: boolean; reason: string } }[]; policies: { policyId: string; terms?: unknown }[] }>;
const resume = async () => (await fetch(`${CONSOLE}/api/resume/alice`, { method: 'POST', headers: { 'x-kuasa-console': '1' } })).json();

/** Buys bread twice and waits until the insurer has detected the pair, held the agent and filed the claim. */
async function duplicateFiledByInsurer() {
  const two = await alice.buyTwice('/shop/groceries/bread');
  const txs = [two.first, two.second].map((x) => (x as { paymentTx?: string }).paymentTx);
  console.log('   bread paid twice', show(txs));
  if (txs.some((t) => !t)) throw new Error(`a purchase failed: ${show(two)}`);
  for (let i = 0; i < 60; i++) {
    const d = (await alice.detections()).detections.find((x) => x.paymentTxs.every((t) => txs.includes(t)));
    if (d?.claimId !== undefined) return d as typeof d & { claimId: string };
    if ((d as { fileError?: string } | undefined)?.fileError) throw new Error(`insurer could not file: ${(d as { fileError?: string }).fileError}`);
    await sleep(5000);
  }
  throw new Error('no detection filed within 5 minutes');
}

if (steps.includes('policy')) {
  console.log('1. Policy under the owner-signed AP2 intent');
  const ap2 = await signAp2Intent({ user_cart_confirmation_required: false, natural_language_description: 'Bread for the week', merchants: ['Kuasa demo shop', 'Kuasa Cover'], skus: ['/shop/groceries/bread'], intent_expiry: '2027-01-31T00:00:00Z' }, owner.address, buildBasicAccountSigner(owner.key));
  const bought = await alice.coverBuy(50n * EUR, 30, ap2) as { policy?: { policyId: string } };
  console.log('   policy', show(bought.policy?.policyId), 'premium', show((bought as { premium?: string }).premium));
  const id = BigInt(bought.policy!.policyId);
  for (let i = 0; i < 20 && !(await cover.terms(id)); i++) await sleep(3000);
  console.log('   terms on-chain (setTerms):', show(await cover.terms(id)));
  const bond = await cover.postBond(payer, 10_000_000n, wallet(owner.address, owner.key));
  console.log('   owner bonded the agent with 10 CCD (postBond)', bond.hash, show(await cover.bondOf(payer)));
  const q = await alice.coverQuote(50n * EUR, 30);
  console.log('   a new quote now shows:', show((q as { factors?: { name: string }[]; refused?: string }).factors?.map((f) => f.name) ?? q));
}

if (steps.includes('parametric')) {
  console.log('2. Fully parametric duplicate (the insurer files it)');
  const d = await duplicateFiledByInsurer();
  console.log('   insurer filed claim', d.claimId, 'filedBy', show((d as { filedBy?: string }).filedBy));
  for (let i = 0; i < 40; i++) {
    const c = (await insurerState()).claims.find((x) => String(x.claimId) === String(d.claimId));
    if (c?.paid) { console.log('   paid automatically', c.paid, 'autoApprove', c.autoApproveTx, 'reason', c.reason); break; }
    await sleep(10_000);
  }
  console.log('   owner resumes:', show(await resume()));
}

if (steps.includes('objection')) {
  console.log('3. Bonded objection');
  await sleep(5000);
  const d = await duplicateFiledByInsurer();
  const bond = (await cover.objectionBond())!;
  const r = await cover.objectClaim(BigInt(d.claimId), wallet(recorder.address, recorder.key), bond);
  console.log(`   shop objected to claim ${d.claimId} on-chain, locking ${Number(bond) / 1e6} CCD`, r.hash);
  const proof = await makePayerProof(recorder.address, buildBasicAccountSigner(recorder.key), INSURER);
  console.log('   and told the insurer why:', show(await (await fetch(`${INSURER}/claims/${d.claimId}/object`, { method: 'POST', headers: { 'content-type': 'application/json', ...proof }, body: JSON.stringify({ reason: 'The second loaf was never collected; it was refunded at the till.' }) })).json()));
  console.log('   owner resumes:', show(await resume()));
}

if (steps.includes('sponsor')) {
  console.log('4. Merchant-paid cover');
  await sleep(5000);
  const q = await alice.quote('/shop/wine/rioja') as { orderRef?: string; amount?: string; reasons?: string[] };
  if (!q.orderRef) throw new Error(`no order reference: ${show(q)}`);
  const shop = new KuasaAgent({ ...alice.opts, payer: merchant.address, payerKey: merchant.key });
  const sponsored = await shop.sponsorOrderCover({ ref: q.orderRef, amount: BigInt(q.amount!) }) as { policy?: { policyId: string; sponsor?: string }; factors?: { name: string; multiplier: number }[]; premium?: string };
  console.log('   the shop paid', show(sponsored.premium), 'for policy', show(sponsored.policy?.policyId), 'factors', show(sponsored.factors?.map((f) => `${f.name} x${f.multiplier}`)));
  const bought = await alice.buy('/shop/wine/rioja', true, q.orderRef) as { ok: boolean; paymentTx?: string; reasons?: string[] };
  console.log('   insured wine bought by the agent:', show(bought.ok ? bought.paymentTx : bought));
}
