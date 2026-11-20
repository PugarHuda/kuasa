/**
 * One-shot, idempotent testnet setup for the demo. Every step is skipped if already done.
 *
 *   1. deploy + init the kuasa-registry contract (merchant #1 pays)
 *   2. register each owner's shopping agent in the CIS-8004 Agent Registry <12802,0>
 *   3. owner proves attributes once (Verify & Access V1), bound to the agent
 *   4. build the mandate document and issue it on-chain
 *
 * Public documents (mandates, proofs, agent cards) go to .kuasa/public/, served by the shop.
 * State goes to .kuasa/state.json. Run: pnpm --filter @kuasa/scripts exec tsx setup.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { bigintJson, connect, KuasaRegistry, submit, TESTNET, wallet, type Wallet } from '@kuasa/chain';
import { canonicalJson, type Mandate, mandateId, proofBinding, sha256Hex } from '@kuasa/core';
import { loadProfile } from './lib/identity.js';
import { createMandateProof } from './lib/proof.js';

export const PUBLIC_URL = process.env.KUASA_PUBLIC_URL ?? 'http://localhost:4021';
const ROOT = new URL('../.kuasa/', import.meta.url);
const STATE = new URL('state.json', ROOT);
const PUB = new URL('public/', ROOT);
const AGENT_REGISTRY = { index: 12802n, subindex: 0n };
const ASSET = process.env.KUASA_ASSET ?? 'EUDemo'; // allow-listed euro PLT (6 decimals)
const UNIT = 1_000_000n;

type State = {
  moduleRef?: string;
  coverModuleRef?: string;
  cover?: string; // kuasa-cover contract index
  shopAgent?: string; // the shop's own CIS-8004 token (two-way trust)
  registry?: string; // contract index
  agents: Record<string, string>; // name -> CIS-8004 token id (hex)
  mandates: Record<string, { id: string; owner: string; payer: string; issueTx: string; proofAnchorTx: string }>;
};
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { agents: {}, mandates: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
// `setup.ts --reissue alice` issues a fresh mandate (new proof, new id) e.g. after a revoke demo.
const ri = process.argv.indexOf('--reissue');
if (ri >= 0) for (const n of process.argv.slice(ri + 1)) delete state.mandates[n];
const publish = (path: string, body: string) => {
  const f = new URL(path, PUB);
  mkdirSync(new URL('.', f), { recursive: true });
  writeFileSync(f, body);
  return `${PUBLIC_URL}/kuasa/${path}`;
};
const ab = (u: Uint8Array) => u.slice().buffer as ArrayBuffer;
const log = (...a: unknown[]) => console.log('[setup]', ...a);

const grpc = connect();
const acct = (name: string, n: number): Wallet => { const a = loadProfile(name).accounts.find((x) => x.credNumber === n)!; return wallet(a.address, a.key); };
const merchantFacilitator = acct('merchant', 1);
const merchantPayTo = acct('merchant', 0).address.address;
const insurerTreasury = acct('insurer', 0).address.address;
const insurerOperator = acct('insurer', 1);

function ok(r: Awaited<ReturnType<typeof submit>>, what: string) {
  const s = r.summary.summary as any;
  if (!s || s.type !== 'accountTransaction' || s.transactionType === 'failed') throw new Error(`${what} rejected (tx ${r.hash}): ${JSON.stringify(s, bigintJson)}`);
  return s;
}

// 1. contract
if (!state.registry) {
  const source = new Uint8Array(readFileSync(new URL('../contracts/kuasa-registry/concordium-out/module.wasm.v1', import.meta.url)));
  if (!state.moduleRef) {
    const r = await submit(grpc, Transaction.deployModule({ source }) as Transaction.Builder, merchantFacilitator);
    const s = r.summary.summary as any;
    state.moduleRef = s.moduleDeployed?.contents ?? s.rejectReason?.contents; // ModuleHashAlreadyExists also carries the ref
    if (!state.moduleRef) throw new Error(`deploy failed: ${JSON.stringify(s, bigintJson)}`);
    state.moduleRef = String(state.moduleRef); save();
    log('module', state.moduleRef, r.hash);
  }
  const r = await submit(grpc, Transaction.initContract({
    amount: sdk.CcdAmount.zero(), moduleRef: sdk.ModuleReference.fromHexString(state.moduleRef),
    initName: sdk.ContractName.fromString('kuasa'), param: sdk.Parameter.empty(),
  }, sdk.Energy.create(30_000)) as Transaction.Builder, merchantFacilitator);
  state.registry = String(ok(r, 'init').contractInitialized.address.index); save();
  log('kuasa-registry', `<${state.registry},0>`, r.hash);
}
const registry = new KuasaRegistry(grpc, BigInt(state.registry));

// 1b. Kuasa Cover contract (books for policies and claims; operator = insurer #1)
// --cover-v2 deploys the v2 module (automation rules enforced on-chain) next to the v1 instance,
// which is kept as coverV1 for its history.
if (process.argv.includes('--cover-v2') && !(state as { coverV1?: string }).coverV1) {
  Object.assign(state, { coverV1: state.cover, coverV1ModuleRef: state.coverModuleRef });
  state.cover = undefined as never;
  state.coverModuleRef = undefined;
  save();
}
if (!state.cover) {
  const source = new Uint8Array(readFileSync(new URL('../contracts/kuasa-cover/concordium-out/module.wasm.v1', import.meta.url)));
  if (!state.coverModuleRef) {
    const r = await submit(grpc, Transaction.deployModule({ source }) as Transaction.Builder, merchantFacilitator);
    const s = r.summary.summary as any;
    state.coverModuleRef = String(s.moduleDeployed?.contents ?? s.rejectReason?.contents ?? '');
    if (!state.coverModuleRef) throw new Error(`cover deploy failed: ${JSON.stringify(s, bigintJson)}`);
    save();
    log('cover module', state.coverModuleRef, r.hash);
  }
  // InitParams { operator, registry, auto_pay_limit: u64, objection_window_ms: u64 } (v2)
  const AUTO_PAY_LIMIT = BigInt(process.env.KUASA_AUTOPAY_LIMIT ?? 10_000_000);
  const OBJECTION_WINDOW_MS = BigInt(process.env.KUASA_AUTOPAY_DELAY_MS ?? 120_000);
  const init = new Uint8Array([...insurerOperator.address.decodedAddress, ...new Uint8Array(new BigUint64Array([BigInt(state.registry), 0n, AUTO_PAY_LIMIT, OBJECTION_WINDOW_MS]).buffer)]);
  const r = await submit(grpc, Transaction.initContract({
    amount: sdk.CcdAmount.zero(), moduleRef: sdk.ModuleReference.fromHexString(state.coverModuleRef),
    initName: sdk.ContractName.fromString('kuasa_cover'), param: sdk.Parameter.fromBuffer(ab(init)),
  }, sdk.Energy.create(30_000)) as Transaction.Builder, merchantFacilitator);
  state.cover = String(ok(r, 'cover init').contractInitialized.address.index); save();
  log('kuasa-cover', `<${state.cover},0>`, r.hash);
}

// 2. CIS-8004 agent registration: register({ agent_uri: Some(uri), metadata_hash: None, external_reference: None, initial_metadata: [] })
async function registerAgent(name: string, owner: Wallet) {
  if (state.agents[name]) return state.agents[name];
  const card = { name: `${name}'s shopping agent`, description: 'Buys within a Kuasa mandate', url: `${PUBLIC_URL}/kuasa/mandate/${name}.json`, protocols: ['x402', 'kuasa/v1'] };
  const uri = publish(`agents/${name}.json`, JSON.stringify(card, null, 2));
  const u = new TextEncoder().encode(uri);
  const param = new Uint8Array([1, ...new Uint8Array(new Uint32Array([u.length]).buffer), ...u, 0, 0, 0, 0, 0, 0]);
  const contract = sdk.ContractAddress.create(AGENT_REGISTRY.index, AGENT_REGISTRY.subindex);
  const method = sdk.ReceiveName.fromString('CIS-8004.register');
  const parameter = sdk.Parameter.fromBuffer(ab(param));
  const dry = await grpc.invokeContract({ contract, method, parameter, invoker: owner.address });
  if (dry.tag !== 'success' || !dry.returnValue) throw new Error(`CIS-8004.register dry-run failed: ${JSON.stringify(dry, bigintJson)}`);
  const ret = new Uint8Array(sdk.ReturnValue.toBuffer(dry.returnValue));
  const tokenId = Buffer.from(ret.subarray(1, 1 + ret[0])).toString('hex');
  const r = await submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: contract, receiveName: method, message: parameter }, sdk.Energy.create(30_000)) as Transaction.Builder, owner);
  ok(r, 'CIS-8004.register');
  state.agents[name] = tokenId; save();
  log(name, 'agent token', tokenId, r.hash);
  return tokenId;
}

// 3 + 4. proof + mandate
async function mandate(name: string, want: { minAge?: number; euResidency?: boolean }) {
  if (state.mandates[name]) return;
  const owner = acct(name, 0);
  const payer = acct(name, 1);
  const tokenId = await registerAgent(name, owner);
  const agent: Mandate['agent'] = { registry: { index: String(AGENT_REGISTRY.index), subindex: '0', tokenId }, payer: payer.address.address };
  const proof = await createMandateProof(grpc, loadProfile(name), 1, proofBinding({ network: TESTNET.caip2, agent }), want);
  const now = Math.floor(Date.now() / 1000);
  const m: Mandate = {
    v: 1, network: TESTNET.caip2,
    principal: { kind: 'person', account: owner.address.address, displayName: name },
    agent,
    scope: {
      // premiums to the insurer are spending under the mandate like any other purchase
      asset: ASSET, maxPerOrder: String(50n * UNIT), maxTotal: String(150n * UNIT),
      categories: ['groceries', 'wine', 'insurance'], merchants: [merchantPayTo, insurerTreasury],
      validFrom: now - 60, validUntil: now + 30 * 86400,
    },
    proof: { auditRecordUri: publish(`proof/${name}.json`, proof.json), auditRecordSha256: await sha256Hex(proof.json) },
    createdAt: now,
  };
  const uri = publish(`mandate/${name}.json`, canonicalJson(m));
  const id = await mandateId(m);
  const r = await registry.issue({
    id, payer: payer.address.address, agentRegistry: AGENT_REGISTRY, agentToken: tokenId, uri,
    maxTotal: BigInt(m.scope.maxTotal), validUntilMs: BigInt(m.scope.validUntil) * 1000n, recorders: [merchantFacilitator.address.address, insurerOperator.address.address],
  }, owner);
  state.mandates[name] = { id, owner: owner.address.address, payer: payer.address.address, issueTx: r.hash, proofAnchorTx: proof.anchorTx }; save();
  log(name, 'mandate', id, r.hash);
}

// The shop registers itself too, so buying agents can verify who they pay.
state.shopAgent ??= await registerAgent('shop', acct('merchant', 0));
save();

await mandate('alice', { minAge: 18, euResidency: true });
await mandate('teen', { euResidency: true }); // a 16-year-old cannot prove 18+, so the shop will refuse wine

console.log(JSON.stringify(state, null, 2));
process.exit(0);
