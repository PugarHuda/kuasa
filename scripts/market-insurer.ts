/**
 * A second insurer on the Kuasa market ("Kuasa Re"), the Etherisc GIF / Nexus Mutual pattern: each
 * insurer runs its own instance of the same kuasa-cover v3 module, with its own operator and its own
 * pool account, and prices risk itself. No contract change: "one operator" is per instance.
 * Writes state.market = [{ name, cover, url, treasury, operator }]. Idempotent.
 * Usage: tsx market-insurer.ts   (after provision.ts insurer2 and allowlist.ts)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { bigintJson, connect, submit, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const STATE = new URL('../.kuasa/state.json', import.meta.url);
const state = JSON.parse(readFileSync(STATE, 'utf8')) as { registry: string; coverModuleRef: string; market?: { name: string; cover: string; url: string; treasury: string; operator: string }[] };
const grpc = connect();
const p = loadProfile('insurer2');
const pool = p.accounts.find((a) => a.credNumber === 0)!;
const op = p.accounts.find((a) => a.credNumber === 1)!;

if (!state.market?.some((m) => m.name === 'Kuasa Re')) {
  // InitParams v3 { operator, registry, auto_pay_limit, objection_window_ms, objection_bond, pool }: the same rules as the first insurer
  const init = new Uint8Array([...sdk.AccountAddress.fromBase58(op.address).decodedAddress, ...new Uint8Array(new BigUint64Array([BigInt(state.registry), 0n, 10_000_000n, 120_000n, 1_000_000n]).buffer), ...sdk.AccountAddress.fromBase58(pool.address).decodedAddress]);
  const r = await submit(grpc, Transaction.initContract({
    amount: sdk.CcdAmount.zero(), moduleRef: sdk.ModuleReference.fromHexString(state.coverModuleRef),
    initName: sdk.ContractName.fromString('kuasa_cover'), param: sdk.Parameter.fromBuffer(init.slice().buffer as ArrayBuffer),
  }, sdk.Energy.create(30_000)) as Transaction.Builder, wallet(op.address, op.key));
  const s = r.summary.summary as any;
  if (s?.transactionType === 'failed' || !s?.contractInitialized) throw new Error(`init rejected (tx ${r.hash}): ${JSON.stringify(s, bigintJson)}`);
  const cover = String(s.contractInitialized.address.index);
  state.market = [...(state.market ?? []), { name: 'Kuasa Re', cover, url: 'http://localhost:4024', treasury: pool.address, operator: op.address }];
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`Kuasa Re: kuasa-cover <${cover},0> (same v3 module), pool ${pool.address}, operator ${op.address}`, r.hash);
} else console.log('Kuasa Re already on the market', JSON.stringify(state.market));
process.exit(0);
