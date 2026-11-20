/**
 * Resets the testnet demo for a clean recording (stop shop/insurer/console first):
 *  - cancels alice's live Kuasa Cover policies (so "uninsured → refused" is real again),
 *  - tops alice's agent up with EUDemo from the shop's takings,
 *  - archives the local service state (claims queue, receipts, audit) so the console starts empty.
 * Then run: tsx setup.ts --reissue alice   (fresh mandate and budget)
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { connect, KuasaCover, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';
import { readFileSync } from 'node:fs';

const grpc = connect();
const root = new URL('../.kuasa/', import.meta.url);
const state = JSON.parse(readFileSync(new URL('state.json', root), 'utf8')) as { cover: string };
const acct = (name: string, n: number) => loadProfile(name).accounts.find((a) => a.credNumber === n)!;
const owner = acct('alice', 0);
const cover = new KuasaCover(grpc, BigInt(state.cover));

for (let id = 0n; ; id++) {
  const p = await cover.policy(id);
  if (!p) break;
  if (p.holder === owner.address && p.status === 'Active' && Number(p.validUntilMs) > Date.now()) {
    const r = await cover.cancelPolicy(id, wallet(owner.address, owner.key));
    console.log('cancelled policy', String(id), r.hash);
  }
}

const TOP_UP = BigInt(process.env.TOP_UP ?? 75_000_000);
const shop = acct('merchant', 0);
const payer = acct('alice', 1);
const token = await sdk.Token.fromId(grpc, sdk.TokenId.fromString('EUDemo'));
const hash = await sdk.Token.transfer(token, sdk.AccountAddress.fromBase58(shop.address),
  { recipient: sdk.AccountAddress.fromBase58(payer.address), amount: sdk.TokenAmount.create(TOP_UP, 6) },
  sdk.buildBasicAccountSigner(shop.key), undefined, { autoScale: false, validate: true });
await grpc.waitForTransactionFinalization(hash);
console.log('topped up alice agent with', Number(TOP_UP) / 1e6, 'EUDemo', sdk.TransactionHash.toHexString(hash));

const archive = new URL(`archive/${new Date().toISOString().replace(/[:.]/g, '-')}/`, root);
mkdirSync(archive, { recursive: true });
for (const f of ['insurer-state.json', 'shop-receipts.json', 'audit']) {
  if (existsSync(new URL(f, root))) { renameSync(new URL(f, root), new URL(f, archive)); console.log('archived', f); }
}
process.exit(0);
