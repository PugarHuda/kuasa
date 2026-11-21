/**
 * Appeals panel (Kleros-style), live: Alice's agent appeals a rejected claim by re-filing its orders;
 * the insurer recognises the appeal, and independent jurors (accounts named in KUASA_JURORS, never a
 * party to the claim) vote with signed requests. The first verdict with a majority decides it.
 * Usage: tsx appeal-panel-demo.ts <rejectedClaimId> <approve|reject> <paymentTx...>
 * Needs shop and insurer (started with KUASA_JURORS = teen #0, teen #1) running.
 */
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { KuasaAgent } from '@kuasa/agent';
import { makePayerProof } from '@kuasa/merchant';
import { loadProfile } from './lib/identity.js';

const INSURER = process.env.KUASA_INSURER_URL ?? 'http://localhost:4023';
const [rejected, verdict, ...txs] = process.argv.slice(2);
if (!rejected || !['approve', 'reject'].includes(verdict) || txs.length === 0) throw new Error('usage: appeal-panel-demo.ts <rejectedClaimId> <approve|reject> <paymentTx...>');
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));

const alice = KuasaAgent.fromDemo('alice');
const filed = await alice.fileClaim('AgentMistake', txs, 3_000_000n, `appeal of #${rejected}: the agent was charged twice`, undefined, 'AM10') as { claimId?: string; tx?: string; assessment?: unknown; error?: string };
console.log('1. appeal filed', show({ claimId: filed.claimId, tx: filed.tx, assessment: filed.assessment, error: filed.error }));
if (!filed.claimId) process.exit(1);
console.log('   open appeals:', show((await (await fetch(`${INSURER}/appeals`)).json() as { claimId: string; appealOf: string }[]).map((a) => ({ claimId: a.claimId, appealOf: a.appealOf }))));

for (const n of [0, 1]) {
  const juror = loadProfile('teen').accounts.find((a) => a.credNumber === n)!;
  const proof = await makePayerProof(juror.address, buildBasicAccountSigner(juror.key), INSURER);
  const r = await (await fetch(`${INSURER}/appeals/${filed.claimId}/vote`, { method: 'POST', headers: { 'content-type': 'application/json', ...proof }, body: JSON.stringify({ approve: verdict === 'approve' }) })).json();
  console.log(`2. juror ${juror.address.slice(0, 6)} votes ${verdict}:`, show(r));
}
