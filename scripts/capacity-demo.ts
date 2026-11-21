/**
 * Underwriting capacity, live: every live limit must be backed by the pool. The teen agent asks for
 * period cover while the pool is fully used: refused. A capital provider adds EUDemo to the pool
 * (memo "kuasa capital", registered with the insurer), and the same quote is then sold.
 * Usage: tsx capacity-demo.ts [provider name:n] [deposit EUDemo]. Needs shop and insurer running.
 */
import * as sdk from '@concordium/web-sdk';
import { KuasaAgent } from '@kuasa/agent';
import { connect } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const INSURER = process.env.KUASA_INSURER_URL ?? 'http://localhost:4023';
const [who = 'merchant:0', dep = '30'] = process.argv.slice(2);
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const solvency = async () => { const s = await (await fetch(`${INSURER}/solvency`)).json() as { pool: string; exposure: string }; return { pool: s.pool, exposure: s.exposure }; };
const teen = KuasaAgent.fromDemo('teen');
const LIMIT = 20_000_000n;
const brief = (q: { premium?: string; refused?: string }) => q.refused ?? { premium: q.premium };

console.log('1. pool vs live limits', show(await solvency()));
console.log('2. teen asks for 20 EUDemo period cover ->', show(brief(await teen.coverQuote(LIMIT, 30))));

const [name, n] = who.split(':');
const lp = loadProfile(name).accounts.find((a) => a.credNumber === Number(n))!;
const grpc = connect();
const info = await (await fetch(`${INSURER}/info`)).json() as { treasury: string };
const token = await sdk.Token.fromId(grpc, sdk.TokenId.fromString('EUDemo'));
const hash = await sdk.Token.transfer(token, sdk.AccountAddress.fromBase58(lp.address),
  { recipient: sdk.AccountAddress.fromBase58(info.treasury), amount: sdk.TokenAmount.create(BigInt(dep) * 1_000_000n, 6), memo: sdk.CborMemo.fromString('kuasa capital') },
  sdk.buildBasicAccountSigner(lp.key), undefined, { autoScale: false, validate: true });
await grpc.waitForTransactionFinalization(hash);
const tx = sdk.TransactionHash.toHexString(hash);
const reg = await (await fetch(`${INSURER}/capital/deposit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx }) })).json();
console.log(`3. ${who} added ${dep} EUDemo of capital`, tx, reg.error ?? 'registered');

console.log('4. pool vs live limits', show(await solvency()));
console.log('5. the same quote ->', show(brief(await teen.coverQuote(LIMIT, 30))));
process.exit(0);
