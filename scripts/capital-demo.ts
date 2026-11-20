/**
 * A capital provider joins the pool: sends EUDemo to the pool, registers the transfer (verified
 * on-chain by the insurer), then withdraws part of it with a signed request. Withdrawals that would
 * leave live cover uncovered are refused. Usage: tsx capital-demo.ts [name:n] [deposit] [withdraw]
 */
import * as sdk from '@concordium/web-sdk';
import { connect } from '@kuasa/chain';
import { makePayerProof } from '@kuasa/merchant';
import { loadProfile } from './lib/identity.js';

const INSURER = process.env.KUASA_INSURER_URL ?? 'http://localhost:4023';
const [who = 'teen:1', dep = '20', wd = '5'] = process.argv.slice(2);
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
console.log('1. sent', dep, 'EUDemo to the pool', tx);
const reg = await (await fetch(`${INSURER}/capital/deposit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx }) })).json();
console.log('2. registered', JSON.stringify(reg.providers ?? reg));
const proof = await makePayerProof(lp.address, sdk.buildBasicAccountSigner(lp.key), INSURER);
const out = await (await fetch(`${INSURER}/capital/withdraw`, { method: 'POST', headers: { 'content-type': 'application/json', ...proof }, body: JSON.stringify({ amount: String(BigInt(wd) * 1_000_000n) }) })).json();
console.log('3. withdrew', wd, out.tx ?? out.error);
const big = await (await fetch(`${INSURER}/capital/withdraw`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await makePayerProof(lp.address, sdk.buildBasicAccountSigner(lp.key), INSURER)) }, body: JSON.stringify({ amount: '1000000000' }) })).json();
console.log('4. withdraw 1000 EUDemo ->', big.error ?? big.tx);
process.exit(0);
