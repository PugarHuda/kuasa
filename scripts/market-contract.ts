/**
 * Deploys the open, bonded insurer registry (contracts/kuasa-market) and registers both insurers: each
 * insurer's pool account registers itself with a 10 CCD bond. Arbiter: an appeals-panel juror (teen #0)
 * on testnet; in production a panel multisig or a Kleros court. Writes state.marketContract. Idempotent.
 * Usage: tsx market-contract.ts   (after cargo concordium build in contracts/kuasa-market)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { bigintJson, connect, submit, wallet, type Wallet } from '@kuasa/chain';
import { privateKeyToAccount } from 'viem/accounts';
import { loadProfile } from './lib/identity.js';

const STATE = new URL('../.kuasa/state.json', import.meta.url);
const state = JSON.parse(readFileSync(STATE, 'utf8')) as { cover: string; coverModuleRef: string; marketModuleRef?: string; marketContract?: string; marketContractV1?: string; marketContractV2?: string; market: { name: string; cover: string; url: string }[] };
// --v2: the registry with arbiter-free slashing (flagUnpaid/slashUnpaid) and the 2-of-3 panel as arbiter;
// the first registry is kept as marketContractV1 and both insurers leave it (bonds back after 7 days)
if (process.argv.includes('--v2') && !state.marketContractV1) {
  state.marketContractV1 = state.marketContract; state.marketContract = undefined; state.marketModuleRef = undefined;
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}
// --v3: covers bound at registration, checked against the kuasa-cover module and their own pool
if (process.argv.includes('--v3') && !state.marketContractV2) {
  state.marketContractV2 = state.marketContract; state.marketContract = undefined; state.marketModuleRef = undefined;
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}
const previous = state.marketContractV2 ?? state.marketContractV1;
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const grpc = connect();
const acct = (name: string, n: number): Wallet => { const a = loadProfile(name).accounts.find((x) => x.credNumber === n)!; return wallet(a.address, a.key); };
const deployer = acct('insurer', 1);
const ok = (r: Awaited<ReturnType<typeof submit>>, what: string) => {
  const s = r.summary.summary as any;
  if (!s || s.transactionType === 'failed') throw new Error(`${what} rejected (tx ${r.hash}): ${JSON.stringify(s, bigintJson)}`);
  return s;
};
const str = (s: string) => { const b = new TextEncoder().encode(s); return [...new Uint8Array(new Uint32Array([b.length]).buffer), ...b]; };
const u64 = (n: bigint) => [...new Uint8Array(new BigUint64Array([n]).buffer)];
const u32 = (n: number) => [...new Uint8Array(new Uint32Array([n]).buffer)];

if (!state.marketModuleRef) {
  const source = new Uint8Array(readFileSync(new URL('../contracts/kuasa-market/concordium-out/module.wasm.v1', import.meta.url)));
  const r = await submit(grpc, Transaction.deployModule({ source }) as Transaction.Builder, deployer);
  state.marketModuleRef = String(ok(r, 'module deploy').moduleDeployed.contents); save();
  console.log('kuasa-market module', state.marketModuleRef, r.hash);
}
if (!state.marketContract) {
  // InitParams { arbiter, min_bond: Amount, exit_delay_ms, grace_ms, unpaid_penalty: Amount }; arbiter: the
  // 2-of-3 juror panel account (panel-multisig.ts); grace 10 minutes on testnet (days in production)
  const arbiter = sdk.AccountAddress.fromBase58(loadProfile('panel').accounts[0].address);
  // ...and cover_module: the kuasa-cover module both insurers run (only its contracts count as evidence)
  const coverModule = sdk.ModuleReference.fromHexString(state.coverModuleRef).decodedModuleRef;
  const init = new Uint8Array([...arbiter.decodedAddress, ...u64(10_000_000n), ...u64(7n * 86_400_000n), ...u64(10n * 60_000n), ...u64(2_000_000n), ...coverModule]);
  const r = await submit(grpc, Transaction.initContract({ amount: sdk.CcdAmount.zero(), moduleRef: sdk.ModuleReference.fromHexString(state.marketModuleRef), initName: sdk.ContractName.fromString('kuasa_market'), param: sdk.Parameter.fromBuffer(init.buffer) }, sdk.Energy.create(30_000)) as Transaction.Builder, deployer);
  state.marketContract = String(ok(r, 'market init').contractInitialized.address.index); save();
  console.log(`kuasa-market <${state.marketContract},0>`, r.hash);
}
const market = sdk.ContractAddress.create(BigInt(state.marketContract), 0n);
const evmOf = (f: string) => { const u = new URL(`../.kuasa/${f}`, import.meta.url); return existsSync(u) ? privateKeyToAccount(JSON.parse(readFileSync(u, 'utf8')).privateKey).address : ''; };
const insurers = [
  { pool: acct('insurer', 0), name: 'Kuasa Cover', cover: BigInt(state.cover), url: 'http://localhost:4023', price: 10_000, evm: evmOf('eth-insurer.json') },
  ...state.market.map((m) => ({ pool: acct('insurer2', 0), name: m.name, cover: BigInt(m.cover), url: m.url, price: 8_500, evm: '' })),
];
if (previous) {
  // leave the previous registry: listed as leaving at once, bonds return after its 7-day exit delay
  const v1 = sdk.ContractAddress.create(BigInt(previous), 0n);
  for (const i of insurers) {
    const r = await submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: v1, receiveName: sdk.ReceiveName.fromString('kuasa_market.leave'), message: sdk.Parameter.empty() }, sdk.Energy.create(30_000)) as Transaction.Builder, i.pool).catch((e) => ({ hash: `skipped: ${(e as Error).message.slice(0, 60)}`, summary: { summary: {} } }));
    console.log(`${i.name} leaves the previous registry <${previous},0>`, r.hash);
  }
}
for (const i of insurers) {
  // RegisterParams { name, cover: ContractAddress, url, price_bps: u32, evm }
  const param = new Uint8Array([...str(i.name), ...u64(i.cover), ...u64(0n), ...str(i.url), ...u32(i.price), ...str(i.evm)]);
  const r = await submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.fromMicroCcd(10_000_000n), address: market, receiveName: sdk.ReceiveName.fromString('kuasa_market.register'), message: sdk.Parameter.fromBuffer(param.buffer) }, sdk.Energy.create(30_000)) as Transaction.Builder, i.pool);
  ok(r, `register ${i.name}`);
  console.log(`${i.name} registered itself with a 10 CCD bond`, r.hash);
}
process.exit(0);
