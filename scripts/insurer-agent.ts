/**
 * Registers the Kuasa Cover insurer as an agent in the CIS-8004 Agent Registry, owned by the pool
 * account, so other agents can verify it (Verified-by-Concordium badge) and talk to it over A2A.
 * Its Agent Card is built and pinned by `tsx badges.ts build|pin` like the other agents.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { AGENT_REGISTRY, bigintJson, connect, submit, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const STATE = new URL('../.kuasa/state.json', import.meta.url);
const state = JSON.parse(readFileSync(STATE, 'utf8')) as { insurerAgent?: string };
if (state.insurerAgent) { console.log('already registered', state.insurerAgent); process.exit(0); }

const grpc = connect();
const acc = loadProfile('insurer').accounts.find((x) => x.credNumber === 0)!;
const owner = wallet(acc.address, acc.key);
const u = new TextEncoder().encode(`${process.env.KUASA_PAGES_URL ?? 'https://pugarhuda.github.io/kuasa'}/agents/insurer.json`);
// register({ agent_uri: Some(uri), metadata_hash: None, external_reference: None, initial_metadata: [] })
const param = new Uint8Array([1, ...new Uint8Array(new Uint32Array([u.length]).buffer), ...u, 0, 0, 0, 0, 0, 0]);
const method = sdk.ReceiveName.fromString('CIS-8004.register');
const parameter = sdk.Parameter.fromBuffer(param.slice().buffer as ArrayBuffer);
const dry = await grpc.invokeContract({ contract: AGENT_REGISTRY, method, parameter, invoker: owner.address });
if (dry.tag !== 'success' || !dry.returnValue) throw new Error(`register dry-run failed: ${JSON.stringify(dry, bigintJson)}`);
const ret = new Uint8Array(sdk.ReturnValue.toBuffer(dry.returnValue));
const tokenId = Buffer.from(ret.subarray(1, 1 + ret[0])).toString('hex');
const r = await submit(grpc, Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: AGENT_REGISTRY, receiveName: method, message: parameter }, sdk.Energy.create(30_000)) as Transaction.Builder, owner);
if ((r.summary.summary as { transactionType?: string }).transactionType === 'failed') throw new Error('register failed');
writeFileSync(STATE, JSON.stringify({ ...JSON.parse(readFileSync(STATE, 'utf8')), insurerAgent: tokenId }, null, 2));
console.log('insurer agent token', tokenId, r.hash);
process.exit(0);
