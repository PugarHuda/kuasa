/**
 * Deploys kuasa-certificate (contracts/kuasa-certificate) for each insurer's cover contract: a CIS-2 token per
 * policy whose balance is read live from the cover contract. Then announces every live policy (logs the CIS-2
 * mint so explorers list it). Writes state.certificates. Idempotent.
 * Usage: tsx certificate-contract.ts   (after cargo concordium build in contracts/kuasa-certificate)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { connect, KuasaCover, submit, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const STATE = new URL('../.kuasa/state.json', import.meta.url);
const state = JSON.parse(readFileSync(STATE, 'utf8')) as { cover: string; market: { cover: string }[]; certificateModuleRef?: string; certificates?: Record<string, string> };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const grpc = connect();
const a = loadProfile('insurer').accounts.find((x) => x.credNumber === 1)!;
const deployer = wallet(a.address, a.key);
const ok = (r: Awaited<ReturnType<typeof submit>>, what: string) => {
  const s = r.summary.summary as any;
  if (!s || s.transactionType === 'failed') throw new Error(`${what} rejected (tx ${r.hash})`);
  return s;
};
const u64 = (n: bigint) => [...new Uint8Array(new BigUint64Array([n]).buffer)];

if (!state.certificateModuleRef) {
  const source = new Uint8Array(readFileSync(new URL('../contracts/kuasa-certificate/concordium-out/module.wasm.v1', import.meta.url)));
  const r = await submit(grpc, Transaction.deployModule({ source }) as Transaction.Builder, deployer);
  state.certificateModuleRef = String(ok(r, 'module deploy').moduleDeployed.contents); save();
  console.log('kuasa-certificate module', state.certificateModuleRef, r.hash);
}
state.certificates ??= {};
for (const cover of [state.cover, ...state.market.map((m) => m.cover)]) {
  if (!state.certificates[cover]) {
    // InitParams { cover: ContractAddress, metadata_url: String (u16 length, as concordium-std serialises String) }
    const param = new Uint8Array([...u64(BigInt(cover)), ...u64(0n), ...[...new Uint8Array(new Uint32Array([new TextEncoder().encode('https://kuasa-explorer.vercel.app/certificate.json').length]).buffer)], ...new TextEncoder().encode('https://kuasa-explorer.vercel.app/certificate.json')]);
    const r = await submit(grpc, Transaction.initContract({ amount: sdk.CcdAmount.zero(), moduleRef: sdk.ModuleReference.fromHexString(state.certificateModuleRef!), initName: sdk.ContractName.fromString('kuasa_certificate'), param: sdk.Parameter.fromBuffer(param.buffer) }, sdk.Energy.create(30_000)) as Transaction.Builder, deployer);
    state.certificates[cover] = String(ok(r, 'init').contractInitialized.address.index); save();
    console.log(`certificates for cover <${cover},0>: <${state.certificates[cover]},0>`, r.hash);
  }
  // announce every live policy (a rejected announce = not live or already announced: skip)
  const c = new KuasaCover(grpc, BigInt(cover));
  const certAddr = sdk.ContractAddress.create(BigInt(state.certificates[cover]), 0n);
  for (let id = 0n; ; id++) {
    const p = await c.policy(id).catch(() => null);
    if (!p) break;
    if (p.status !== 'Active' || Number(p.validUntilMs) < Date.now() || p.paidOut >= p.limit) continue;
    const tokenParam = new Uint8Array([8, ...u64(id)]); // TokenIdU64: length byte + 8 bytes
    const r = await submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: certAddr, receiveName: sdk.ReceiveName.fromString('kuasa_certificate.announce'), message: sdk.Parameter.fromBuffer(tokenParam.buffer) }, sdk.Energy.create(30_000)) as Transaction.Builder, deployer).catch((e) => ({ hash: `skipped (${(e as Error).message.slice(0, 50)})`, summary: { summary: {} } }));
    console.log(`  policy ${id} (${p.agentPayer.slice(0, 8)}…) announced`, r.hash);
  }
}
process.exit(0);
