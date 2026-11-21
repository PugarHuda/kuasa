/**
 * Optimistic payouts can be challenged, and an AI drafts the review for the human who decides:
 *   1. Alice's agent buys bread twice by mistake and claims; a 2 EUDemo payout is scheduled.
 *   2. Inside the objection window the shop objects (signed by its recorder account): the claim is held.
 *      On a v2 cover contract the objection is also recorded on-chain (objectClaim), so the contract
 *      itself refuses an automatic approval of this claim.
 *   3. Claude drafts a recommendation from the claim's facts (advisory, no tools).
 *   4. A human decides in the console.
 * Needs shop, insurer and console running. Usage: tsx objection-demo.ts
 */
import { KuasaAgent } from '@kuasa/agent';
import { makePayerProof } from '@kuasa/merchant';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { readFileSync } from 'node:fs';
import { connect, KuasaCover, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const INSURER = process.env.KUASA_INSURER_URL ?? 'http://localhost:4023';
const CONSOLE = process.env.KUASA_CONSOLE_URL ?? 'http://localhost:4022';
const alice = KuasaAgent.fromDemo('alice');

const two = await alice.buyTwice('/shop/groceries/bread');
const txs = [two.first, two.second].map((x) => (x.ok ? x.paymentTx : undefined)).filter((x): x is string => !!x);
console.log('1. bread bought twice', txs.join(' '));
const claim = await alice.fileClaim('AgentMistake', txs, 3_000_000n, 'duplicate bread') as { claimId?: string; assessment?: { payout?: string } };
console.log('   claim', claim.claimId, 'payout', claim.assessment?.payout, '(scheduled for automatic payment)');

const recorder = loadProfile('merchant').accounts.find((a) => a.credNumber === 1)!;
const proof = await makePayerProof(recorder.address, buildBasicAccountSigner(recorder.key), INSURER);
const obj = await (await fetch(`${INSURER}/claims/${claim.claimId}/object`, { method: 'POST', headers: { 'content-type': 'application/json', ...proof }, body: JSON.stringify({ reason: 'Only one loaf was collected; the second order was cancelled in the shop and refunded at the till.' }) })).json();
console.log('2. shop objection', JSON.stringify(obj));
const { cover } = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { cover: string };
const book = new KuasaCover(connect(), BigInt(cover));
if (await book.rules()) {
  // v3: an objection locks the contract's objection bond (CCD), returned if the claim is rejected
  const r = await book.objectClaim(BigInt(claim.claimId!), wallet(recorder.address, recorder.key), (await book.objectionBond()) ?? 0n);
  console.log('   objection recorded on-chain (objectClaim)', r.hash);
}

const review = await (await fetch(`${CONSOLE}/api/claims/${claim.claimId}/ai-review`, { method: 'POST', headers: { 'x-kuasa-console': '1' } })).json();
console.log('3. AI draft (advisory)', JSON.stringify(review));
console.log('4. open the console (http://localhost:4022) to decide');
process.exit(0);
