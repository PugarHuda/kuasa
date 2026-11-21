/**
 * The market directory on-chain (CIS-8004), so agents find insurers on the chain, not in a config file:
 *   1. each insurer has its own CIS-8004 entry, owned by its pool account (registered here if missing);
 *   2. each insurer writes `kuasa:insurer` on its own entry: cover contract, pool, operator, price, URL.
 *      Only the entry's owner (the pool) can write it: a self-attestation by the pool that backs the cover;
 *   3. the first insurer's entry lists the market's insurer tokens under `kuasa:market`.
 * An agent reads the list, checks each entry is owned by the pool it advertises, and uses an insurer only
 * if its owner's mandate names that pool. Usage: tsx market-directory.ts (idempotent).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { AGENT_REGISTRY, bigintJson, cis8004GetMetadata, cis8004SetMetadata, connect, submit, wallet, type Wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const STATE = new URL('../.kuasa/state.json', import.meta.url);
type Market = { name: string; cover: string; url: string; treasury: string; operator: string; agent?: string; price?: number };
const state = JSON.parse(readFileSync(STATE, 'utf8')) as { cover: string; insurerAgent: string; market: Market[] };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const grpc = connect();
const pool = (profile: string): Wallet => { const a = loadProfile(profile).accounts.find((x) => x.credNumber === 0)!; return wallet(a.address, a.key); };
const op = (profile: string) => loadProfile(profile).accounts.find((x) => x.credNumber === 1)!.address;

async function register(owner: Wallet, card: string) {
  const u = new TextEncoder().encode(card);
  const param = new Uint8Array([1, ...new Uint8Array(new Uint32Array([u.length]).buffer), ...u, 0, 0, 0, 0, 0, 0]);
  const method = sdk.ReceiveName.fromString('CIS-8004.register');
  const parameter = sdk.Parameter.fromBuffer(param.slice().buffer as ArrayBuffer);
  const dry = await grpc.invokeContract({ contract: AGENT_REGISTRY, method, parameter, invoker: owner.address });
  if (dry.tag !== 'success' || !dry.returnValue) throw new Error(`register dry-run failed: ${JSON.stringify(dry, bigintJson)}`);
  const ret = new Uint8Array(sdk.ReturnValue.toBuffer(dry.returnValue));
  const tokenId = Buffer.from(ret.subarray(1, 1 + ret[0])).toString('hex');
  const r = await submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: AGENT_REGISTRY, receiveName: method, message: parameter }, sdk.Energy.create(30_000)) as Transaction.Builder, owner);
  if ((r.summary.summary as { transactionType?: string }).transactionType === 'failed') throw new Error('register failed');
  console.log('registered', tokenId, r.hash);
  return tokenId;
}

async function advertise(token: string, owner: Wallet, value: string) {
  if ((await cis8004GetMetadata(grpc, token, 'kuasa:insurer')) === value) return console.log('kuasa:insurer up to date on', token);
  const r = await cis8004SetMetadata(grpc, token, 'kuasa:insurer', value, owner);
  console.log('kuasa:insurer on', token, '=', value, r.hash);
}

// Kuasa Re (and any later insurer) gets its own entry, owned by its pool
for (const m of state.market) {
  if (!m.agent) { m.agent = await register(pool('insurer2'), 'https://kuasa-explorer.vercel.app/?insurer=kuasa-re'); save(); }
}
// evm: the address this insurer posts ERC-8004 feedback from (other insurers trust ratings from listed addresses only)
const evmOf = (f: string) => { const u = new URL(`../.kuasa/${f}`, import.meta.url); return existsSync(u) ? `;evm=${privateKeyToAccount(JSON.parse(readFileSync(u, 'utf8')).privateKey).address}` : ''; };
await advertise(state.insurerAgent, pool('insurer'), `name=Kuasa Cover;cover=${state.cover};pool=${pool('insurer').address.address};operator=${op('insurer')};price=10000;url=http://localhost:4023${evmOf('eth-insurer.json')}`);
for (const m of state.market) await advertise(m.agent!, pool('insurer2'), `name=${m.name};cover=${m.cover};pool=${m.treasury};operator=${m.operator};price=${m.price ?? 8500};url=${m.url}`);
const list = [state.insurerAgent, ...state.market.map((m) => m.agent!)].join(',');
if ((await cis8004GetMetadata(grpc, state.insurerAgent, 'kuasa:market')) !== list) {
  const r = await cis8004SetMetadata(grpc, state.insurerAgent, 'kuasa:market', list, pool('insurer'));
  console.log('kuasa:market =', list, r.hash);
} else console.log('kuasa:market up to date', list);
process.exit(0);
