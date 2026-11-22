/**
 * Public keeper for kuasa-market: every call it makes is permissionless, so anyone can run it (here a
 * GitHub Actions cron). For each registered insurer it reads the claims on that insurer's own cover
 * contract and, after a free dry run, flags approved-but-unpaid claims, slashes those past the grace
 * period, and releases escrowed slashes past the exit delay. A call is sent only if its dry run succeeds.
 * Usage: tsx keeper.ts [--market <index>] [--dry]
 * Keys: KUASA_KEEPER_ADDRESS + KUASA_KEEPER_KEY (CI), else the local investor #1 account.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { connect, submit, wallet } from '@kuasa/chain';
import { decodeClaim, decodeMarketInsurers } from '@kuasa/core';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const dry = process.argv.includes('--dry');
const stateFile = new URL('../.kuasa/state.json', import.meta.url);
const marketIndex = BigInt(arg('--market') ?? process.env.KUASA_MARKET ?? JSON.parse(readFileSync(stateFile, 'utf8')).marketContract);
if (process.env.CI && !process.env.KUASA_KEEPER_KEY) { console.log('no KUASA_KEEPER_KEY secret set: nothing to do'); process.exit(0); }
const keeper = process.env.KUASA_KEEPER_KEY
  ? wallet(process.env.KUASA_KEEPER_ADDRESS!, process.env.KUASA_KEEPER_KEY)
  : await (async () => { const { loadProfile } = await import('./lib/identity.js'); const a = loadProfile('investor').accounts.find((x) => x.credNumber === 1)!; return wallet(a.address, a.key); })();
if (!existsSync(stateFile) && !process.env.KUASA_MARKET && !arg('--market')) throw new Error('no market index');

const grpc = connect();
const market = sdk.ContractAddress.create(marketIndex, 0n);
const u64 = (v: bigint) => [...new Uint8Array(new BigUint64Array([v]).buffer)];
const TOO_EARLY = -7, NOT_APPROVED_UNPAID = -11; // kuasa_market::Error variants 6 and 10

async function dryRun(method: string, param: number[]) {
  const r = await grpc.invokeContract({ contract: market, invoker: keeper.address, method: sdk.ReceiveName.fromString(`kuasa_market.${method}`), parameter: sdk.Parameter.fromBuffer(new Uint8Array(param).buffer), energy: sdk.Energy.create(60_000) });
  if (r.tag === 'success') return { ok: true as const };
  return { ok: false as const, code: (r.reason as any)?.rejectReason as number | undefined };
}
async function send(method: string, param: number[], why: string) {
  if (dry) return console.log(`  would ${method}: ${why}`);
  const r = await submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: market, receiveName: sdk.ReceiveName.fromString(`kuasa_market.${method}`), message: sdk.Parameter.fromBuffer(new Uint8Array(param).buffer) }, sdk.Energy.create(60_000)) as Transaction.Builder, keeper);
  console.log(`  ${method}: ${why}`, r.hash);
}

const iv = await grpc.invokeContract({ contract: market, method: sdk.ReceiveName.fromString('kuasa_market.insurers'), parameter: sdk.Parameter.empty() });
if (iv.tag !== 'success' || !iv.returnValue) throw new Error('kuasa-market insurers view failed');
const insurers = decodeMarketInsurers(new Uint8Array(sdk.ReturnValue.toBuffer(iv.returnValue)));
console.log(`keeper ${keeper.address.address} on kuasa-market <${marketIndex},0>${dry ? ' (dry run)' : ''}: ${insurers.length} insurers`);

for (const ins of insurers) {
  const pool = [...sdk.AccountAddress.fromBase58(ins.pool).decodedAddress];
  const cover = sdk.ContractAddress.create(ins.cover, 0n);
  let acted = 0;
  for (let id = 0n; ; id++) {
    const c = await grpc.invokeContract({ contract: cover, method: sdk.ReceiveName.fromString('kuasa_cover.claim'), parameter: sdk.Parameter.fromBuffer(new Uint8Array(u64(id)).buffer) });
    if (c.tag !== 'success' || !c.returnValue) break;
    const claim = decodeClaim(new Uint8Array(sdk.ReturnValue.toBuffer(c.returnValue)));
    if (!claim) break;
    const ref = [...pool, ...u64(id)];
    // an escrowed slash past its release time pays the claimant
    if ((await dryRun('releaseSlash', [...pool, ...u64(ins.cover), ...u64(0n), ...u64(id)])).ok) { await send('releaseSlash', [...pool, ...u64(ins.cover), ...u64(0n), ...u64(id)], `${ins.name} claim ${id}, escrow released to the claimant`); acted++; continue; }
    if (claim.status.tag !== 'Approved') continue;
    const slash = await dryRun('slashUnpaid', ref);
    if (slash.ok) { await send('slashUnpaid', ref, `${ins.name} claim ${id} approved and unpaid past the grace period`); acted++; }
    else if (slash.code === NOT_APPROVED_UNPAID && (await dryRun('flagUnpaid', ref)).ok) { await send('flagUnpaid', ref, `${ins.name} claim ${id} approved, not paid yet: grace period starts`); acted++; }
    else if (slash.code === TOO_EARLY) console.log(`  ${ins.name} claim ${id}: flagged, grace period running`);
  }
  if (!acted) console.log(`  ${ins.name}: nothing to do`);
}
process.exit(0);
