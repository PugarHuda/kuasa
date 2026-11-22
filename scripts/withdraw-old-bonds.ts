/**
 * Takes both insurers' bonds back from the kuasa-market registries they left (v1, v2, v3), once each
 * registry's 7-day exit delay has passed. Every withdraw is dry-run first: before the delay it only says so.
 * Usage: tsx withdraw-old-bonds.ts   (from about 30 Nov 2026)
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { connect, submit, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as Record<string, string>;
const grpc = connect();
const acct = (name: string) => { const a = loadProfile(name).accounts.find((x) => x.credNumber === 0)!; return wallet(a.address, a.key); };
const pools = [['Kuasa Cover', acct('insurer')], ['Kuasa Re', acct('insurer2')]] as const;

for (const key of ['marketContractV1', 'marketContractV2', 'marketContractV3']) {
  if (!st[key]) continue;
  const market = sdk.ContractAddress.create(BigInt(st[key]), 0n);
  for (const [name, pool] of pools) {
    const method = sdk.ReceiveName.fromString('kuasa_market.withdraw');
    const dry = await grpc.invokeContract({ contract: market, invoker: pool.address, method, parameter: sdk.Parameter.empty(), energy: sdk.Energy.create(30_000) });
    if (dry.tag !== 'success') { console.log(`<${st[key]},0> ${name}: not yet (or nothing to withdraw), code ${(dry.reason as { rejectReason?: number })?.rejectReason}`); continue; }
    const r = await submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: market, receiveName: method, message: sdk.Parameter.empty() }, sdk.Energy.create(30_000)) as Transaction.Builder, pool);
    console.log(`<${st[key]},0> ${name}: bond withdrawn`, r.hash);
  }
}
process.exit(0);
