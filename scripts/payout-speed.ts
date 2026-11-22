/**
 * Mistake-to-payout time, measured on-chain: for each recorded parametric run, the block time of the
 * agent's second (duplicate) payment and of the insurer's payout. Writes docs/explorer/payout-speed.json,
 * which the explorer shows. Usage: tsx payout-speed.ts
 */
import { writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { connect } from '@kuasa/chain';

// claim, duplicate payment, payout (from scripts/try.ts runs; docs/TESTNET.md lists them)
const RUNS: [number, string, string][] = [
  [6, '889f7a1c2115e7660978a8823a682eef763780d98babee56220756cbeb0d72f1', '160be143ab1d9f6f3907b03aad004456ab89bf20c7a44c111abe9e29809d7793'],
  [7, 'ae47544348d3892f36a9fe85daaa977e3b9ad2f98a9546b92f7c84ace9156a17', '77e89087d01c44f1f4158ec53b0d6818cd8aee24b71451c75cb33a0df9102150'],
  [8, '13584e1381dac7038c817c01af23c3b8d8deacfa5675595b722d7297239644d4', '0cba1a6aaabf3e7d72983c794bf0766abc975b891efcb085efe5ad75552d0039'],
  [9, '3dde0ad7ef5e92bcf6cddd5ae855ce55115a47b520c189fbc2f9f3629cb75699', 'b6864cce7f39838231807461d212b2e78c8edb264c09e5397a10815db19da16d'],
];
const grpc = connect();
async function timeOf(hash: string) {
  const s = await grpc.getBlockItemStatus(sdk.TransactionHash.fromHexString(hash));
  if (s.status !== 'finalized') throw new Error(`${hash} not finalized`);
  return (await grpc.getBlockInfo(s.outcome.blockHash)).blockSlotTime.getTime();
}
const runs = [];
for (const [claim, mistake, payout] of RUNS) {
  const seconds = Math.round(((await timeOf(payout)) - (await timeOf(mistake))) / 1000);
  runs.push({ claim, mistake, payout, seconds });
  console.log(`claim ${claim}: ${seconds}s from the duplicate payment to the payout`);
}
const sorted = runs.map((r) => r.seconds).sort((a, b) => a - b);
const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
writeFileSync(new URL('../docs/explorer/payout-speed.json', import.meta.url), JSON.stringify({ cover: 13105, medianSeconds: median, runs }, null, 2));
console.log(`median ${median}s over ${runs.length} runs`);
process.exit(0);
