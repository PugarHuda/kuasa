/**
 * "Try it" for judges: the parametric claim, live on testnet, narrated line by line.
 *   1. the insurers on kuasa-market, read from the contract
 *   2. Alice's agent holds Kuasa Cover (bought if none is live)
 *   3. it pays twice for the same loaf; the insurer spots the pair on-chain, pauses the agent at every
 *      shop and files the claim itself
 *   4. the contract approves it after the objection window and the insurer pays; the owner resumes the agent
 * Runs in the same process as the shop and the insurer (scripts/render.ts), against localhost.
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { KuasaAgent } from '@kuasa/agent';
import { connect } from '@kuasa/chain';
import { decodeMarketInsurers } from '@kuasa/core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHOP = 'http://localhost:4021';
const INSURER = 'http://localhost:4023';
const RE = 'http://localhost:4024';
const tx = (h: string) => `https://ccdexplorer.io/testnet/transaction/${h}`;
const EUR = 1_000_000n;
const TRANSIENT = /unavailable|lookup_failed|UNAVAILABLE|502|timed out/i;
const consoleCall = (path: string, init: RequestInit = {}) => fetch(`${INSURER}${path}`, { ...init, headers: { 'x-kuasa-console': '1', 'content-type': 'application/json' } }).then((r) => r.json());

export async function runTry(log: (line: string) => void) {
  const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { marketContract: string; mandates: Record<string, { payer: string }> };
  log('1. The insurance market, read from the kuasa-market contract');
  const iv = await connect().invokeContract({ contract: sdk.ContractAddress.create(BigInt(st.marketContract), 0n), method: sdk.ReceiveName.fromString('kuasa_market.insurers'), parameter: sdk.Parameter.empty() });
  if (iv.tag === 'success' && iv.returnValue) {
    for (const i of decodeMarketInsurers(new Uint8Array(sdk.ReturnValue.toBuffer(iv.returnValue)))) log(`   ${i.name}: cover contract <${i.cover},0>, bond ${Number(i.bond) / 1e6} CCD${i.exitAt ? ' (leaving)' : ''}`);
  }

  // explicit URLs: Kuasa Re's settings share this process's environment (KUASA_INSURER_URL points at Re)
  const alice = KuasaAgent.fromDemo('alice', SHOP, INSURER);
  const payer = st.mandates.alice.payer;
  const bob = KuasaAgent.fromDemo('bob', SHOP, INSURER);
  const order = await bob.quote('/shop/wine/rioja');
  if (order.orderRef) {
    log("   both insurers quote cover for one order: Bob's agent wants a 24 EUDemo bottle of wine");
    for (const [name, at] of [['Kuasa Cover', INSURER], ['Kuasa Re', RE]] as const) {
      const q = await bob.coverQuote(0n, 1, { ref: order.orderRef, amount: BigInt(order.amount!) }, undefined, false, at).catch(() => null) as { premium?: string; refused?: string; factors?: { name: string; multiplier: number }[] } | null;
      log(`   ${name}: ${!q ? 'offline' : q.refused ?? `${Number(q.premium) / 1e6} EUDemo [${(q.factors ?? []).map((f) => `${f.name} x${f.multiplier}`).join(', ')}]`}`);
    }
  }
  log("2. Alice's agent and its cover");
  const status = await alice.coverStatus();
  if (BigInt(status.onChain.periodRemaining || '0') < 10n * EUR) {
    log('   no live cover: the agent buys 50 EUDemo of cover for 30 days over x402');
    const bought = await alice.coverBuy(50n * EUR, 30) as { ok?: boolean; premium?: string; paymentTx?: string; reasons?: string[] };
    if (!bought.ok) throw new Error(`cover not bought: ${JSON.stringify(bought.reasons)}`);
    log(`   premium ${Number(bought.premium) / 1e6} EUDemo paid: ${tx(bought.paymentTx!)}`);
  } else log(`   covered: ${Number(status.onChain.periodRemaining) / 1e6} EUDemo of cover left on policy ${status.onChain.policyId}`);

  log('3. The mistake: the agent pays twice for the same loaf of bread (3 EUDemo)');
  const txs: string[] = [];
  const detected = async () => (await alice.detections()).detections.find((d) => d.paymentTxs.some((t) => txs.includes(t)));
  for (let n = 0; n < 2 && !(await detected()); n++) {
    let r: { ok: boolean; paymentTx?: string; reasons?: string[] } = { ok: false };
    for (let i = 0; i < 5; i++) {
      r = await alice.buy('/shop/groceries/bread') as typeof r;
      if (r.ok || !TRANSIENT.test(JSON.stringify(r.reasons))) break;
      await sleep(3000);
    }
    if (r.ok && r.paymentTx) { txs.push(r.paymentTx); log(`   paid: ${tx(r.paymentTx)}`); }
    else log(`   refused by the shop: ${JSON.stringify(r.reasons)}`);
    for (let i = 0; i < 8 && !(await detected()); i++) await sleep(5000);
  }
  log('   the insurer watches every finalized block for duplicate payments by agents it insures…');
  let d: Awaited<ReturnType<typeof detected>>;
  for (let i = 0; i < 60; i++) {
    d = await detected();
    if (d?.claimId !== undefined) break;
    await sleep(5000);
  }
  if (d?.claimId === undefined) throw new Error('the insurer did not file a claim within 5 minutes');
  log(`   duplicate found. The agent is paused at every shop, and the insurer filed claim ${d.claimId} itself`);
  const refused = await alice.quote('/shop/groceries/bread');
  if (!refused.ok) log(`   a third purchase is refused before any money moves: ${JSON.stringify(refused.reasons)}`);

  log('4. Payout: no human. The contract approves it once the objection window has passed');
  for (let i = 0; i < 40; i++) {
    const c = (await consoleCall('/state') as { claims: { claimId: string; paid?: string; autoApproveTx?: string }[] }).claims.find((x) => String(x.claimId) === String(d!.claimId));
    if (c?.paid) {
      if (c.autoApproveTx) log(`   approved by the contract rules (autoApprove): ${tx(c.autoApproveTx)}`);
      log(`   paid to the agent: ${tx(c.paid)}`);
      break;
    }
    await sleep(10_000);
  }
  await consoleCall(`/holds/${payer}/clear`, { method: 'POST', body: '{}' });
  log('   the owner resumes the agent. Done: every link above is a Concordium testnet transaction.');
}
