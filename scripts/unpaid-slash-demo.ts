/**
 * Arbiter-free slashing, live (a STAGED negligence test on Kuasa Re's own book): the teen agent files a
 * claim on its Kuasa Re policy; Kuasa Re's operator assesses and approves it on-chain but deliberately
 * never pays. Anyone (here the investor) flags it on kuasa-market; after the grace period anyone slashes:
 * the market contract reads the claim from Kuasa Re's cover contract itself, sees it is still Approved
 * and unpaid, and pays the penalty from Kuasa Re's bond to the claimant. No arbiter signs anything.
 * Usage: tsx unpaid-slash-demo.ts   (Kuasa Re's service should be stopped, so nobody pays the claim)
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { connect, KuasaCover, submit, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { marketContract: string; market: { cover: string; treasury: string }[] };
const grpc = connect();
const acc = (name: string, n: number) => { const a = loadProfile(name).accounts.find((x) => x.credNumber === n)!; return wallet(a.address, a.key); };
const re = new KuasaCover(grpc, BigInt(st.market[0].cover));
const reOperator = acc('insurer2', 1);
const teenAgent = acc('teen', 1);
const anyone = acc('investor', 1);
const market = sdk.ContractAddress.create(BigInt(st.marketContract), 0n);
const pool = sdk.AccountAddress.fromBase58(st.market[0].treasury);
const ref = (claimId: bigint) => new Uint8Array([...pool.decodedAddress, ...new Uint8Array(new BigUint64Array([claimId]).buffer)]);
const callMarket = (name: string, claimId: bigint) => submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: market, receiveName: sdk.ReceiveName.fromString(`kuasa_market.${name}`), message: sdk.Parameter.fromBuffer(ref(claimId).buffer) }, sdk.Energy.create(60_000)) as Transaction.Builder, anyone);
const ccd = async (a: sdk.AccountAddress.Type) => (await grpc.getAccountInfo(a)).accountAmount.microCcdAmount;

const resume = process.argv.indexOf('--claim'); // --claim <id>: an already flagged claim, slash it now
let claimId: bigint;
if (resume < 0) {
  // 1. the claim: filed by the agent, assessed and approved by Kuasa Re's operator, never paid
  const evidence = Buffer.from(sdk.sha256([Buffer.from(`kuasa staged negligence test ${Date.now()}`)])).toString('hex');
  const orders = [0, 1].map((i) => Buffer.from(sdk.sha256([Buffer.from(`staged-order-${Date.now()}-${i}`)])).toString('hex'));
  const filed = await re.fileClaim({ policyId: 0n, kind: 'AgentMistake', amount: 3_000_000n, evidence, orders }, teenAgent);
  claimId = KuasaCover.idFromEvents(filed.summary, BigInt(st.market[0].cover))!;
  console.log(`1. teen agent filed claim ${claimId} on Kuasa Re`, filed.hash);
  console.log('   Kuasa Re assesses it', (await re.assess(claimId, true, evidence, reOperator)).hash);
  console.log('   Kuasa Re approves it (and will not pay)', (await re.decide(claimId, true, reOperator)).hash);
  console.log("   on Kuasa Re's contract:", show((await re.claim(claimId))?.status));
  // 2. anyone flags it; 3. after the grace period anyone slashes
  console.log('2. the investor flags it on kuasa-market', (await callMarket('flagUnpaid', claimId)).hash);
  const early = await callMarket('slashUnpaid', claimId).then((r) => (r.summary.summary as any).transactionType === 'failed' || 'rejectReason' in (r.summary.summary as any) ? 'rejected (grace period running)' : r.hash).catch((e) => `rejected: ${(e as Error).message.slice(0, 60)}`);
  console.log('   slashing right away:', early);
  console.log('   waiting out the 10-minute grace period…');
  await sleep(10 * 60_000 + 30_000);
} else claimId = BigInt(process.argv[resume + 1]);
console.log("   still on Kuasa Re's contract:", show((await re.claim(claimId))?.status));
const before = await ccd(teenAgent.address);
const slash = await callMarket('slashUnpaid', claimId);
console.log('3. the investor slashes, no arbiter involved', slash.hash, (slash.summary.summary as any).transactionType);
const got = Number((await ccd(teenAgent.address)) - before) / 1e6;
// v2 paid at once; from v3 the penalty sits in escrow for the exit delay (the panel can veto self-dealing), then releaseSlash pays it
console.log(got > 0 ? `   the teen agent received ${got.toFixed(2)} CCD from Kuasa Re's bond` : "   the penalty left Kuasa Re's bond into escrow; anyone can releaseSlash it to the teen agent after the exit delay");
process.exit(0);
