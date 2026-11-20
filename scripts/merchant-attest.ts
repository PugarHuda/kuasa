/**
 * Counterparty attestation (the ERC-8004 "validation" pattern, on CIS-8004): the shop, the other
 * party to every purchase, checks each Kuasa Cover claim's orders against its own sales records and
 * publishes the result on its own CIS-8004 entry as kuasa:attest:<claimId>. A claim then rests on
 * three independent records: the on-chain receipts, the insurer's decision, and the merchant's word.
 * The shop's records are its sales book and the receipts its recorder account signed on-chain (the
 * book can be lost; its own signatures cannot). Re-running re-checks claims not attested as a match.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { cis8004GetMetadata, cis8004SetMetadata, claimKey, connect, KuasaCover, registryEventsOfTx, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const root = new URL('../.kuasa/', import.meta.url);
const state = JSON.parse(readFileSync(new URL('state.json', root), 'utf8')) as { cover: string; registry: string; shopAgent: string };
const archives = readdirSync(new URL('archive/', root)).map((d) => new URL(`archive/${d}/`, root));
const files = [new URL('shop-receipts.json', root), ...archives.map((d) => new URL('shop-receipts.json', d))].filter(existsSync);
const sold = new Map<string, { mandate: string; paymentTx: string; amount: string }>();
for (const f of files) for (const r of JSON.parse(readFileSync(f, 'utf8')) as { mandate: string; order: string; paymentTx: string; amount: string }[]) sold.set(r.order, r);

const grpc = connect();
const cover = new KuasaCover(grpc, BigInt(state.cover));
const acc = loadProfile('merchant').accounts.find((a) => a.credNumber === 0)!;
const recorder = loadProfile('merchant').accounts.find((a) => a.credNumber === 1)!.address;

// Receipt transactions referenced by claims (hints only: each is checked on-chain to be signed by our recorder).
const hints = new Map<string, string[]>();
for (const f of [new URL('insurer-state.json', root), ...archives.map((d) => new URL('insurer-state.json', d))].filter(existsSync)) {
  for (const c of (JSON.parse(readFileSync(f, 'utf8')).claims ?? []) as { claimId: { $big?: string } | string; receiptTxs?: string[] }[]) {
    hints.set(String((c.claimId as { $big?: string }).$big ?? c.claimId), c.receiptTxs ?? []);
  }
}
async function signedByUs(order: string, mandateId: string, txs: string[]) {
  for (const tx of txs) {
    const st = await grpc.getBlockItemStatus(sdk.TransactionHash.fromHexString(tx)).catch(() => null);
    const sender = st?.status === 'finalized' ? (st.outcome?.summary as { sender?: sdk.AccountAddress.Type } | undefined)?.sender : undefined;
    if (!sender || sdk.AccountAddress.toBase58(sender) !== recorder) continue; // only receipts our own recorder signed
    const ev = await registryEventsOfTx(grpc, tx, BigInt(state.registry));
    if (ev?.events.some((e) => e.type === 'Receipt' && e.order === order && e.id === mandateId)) return true;
  }
  return false;
}
const backed = new Set<string>();
for (let id = 0n; ; id++) {
  const c = await cover.claim(id);
  if (!c) break;
  const key = claimKey('attest', state.cover, id);
  const prior = await cis8004GetMetadata(grpc, state.shopAgent, key);
  // An order counts only if it was sold under the mandate of the policy being claimed on.
  const policy = await cover.policy(c.policyId);
  const mandateId = policy?.mandate.id ?? '';
  let found = 0, onChain = 0;
  for (const o of new Set(c.orders)) {
    if (sold.get(o)?.mandate === mandateId) found++;
    else if (await signedByUs(o, mandateId, hints.get(String(id)) ?? [])) { found++; onChain++; }
  }
  const reused = c.orders.some((o) => backed.has(o));
  const verdict = new Set(c.orders).size < c.orders.length ? 'orders-duplicate'
    : reused ? 'orders-reused'
    : found === c.orders.length ? 'orders-match' : found === 0 ? 'orders-unknown' : 'orders-partial';
  if (verdict === 'orders-match') for (const o of c.orders) backed.add(o); // one purchase backs one claim
  const value = `${verdict};orders=${found}/${c.orders.length};src=${onChain ? 'signed-receipts' : 'sales-book'};by=merchant;at=${Math.floor(Date.now() / 1000)}`;
  if (prior && prior.split(';')[0] === verdict) { console.log(key, 'unchanged', verdict); continue; }
  const r = await cis8004SetMetadata(grpc, state.shopAgent, key, value, wallet(acc.address, acc.key));
  console.log(key, verdict, `${found}/${c.orders.length}`, r.hash);
}
process.exit(0);
