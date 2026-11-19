/**
 * Demo: a dishonest claimant. The agent files a claim for an order that never happened (a made-up
 * order hash, no receipt on-chain). The insurer finds no evidence and rejects it without any payout
 * decision; the second such claim drafts a lawful-disclosure request for a human to review.
 *
 * Usage: pnpm --filter @kuasa/scripts exec tsx fraud-demo.ts [name=teen]
 */
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { connect } from '@kuasa/chain';
import { encodeFileClaim } from '@kuasa/core';
import { loadProfile } from './lib/identity.js';

const INSURER = process.env.KUASA_INSURER_URL ?? 'http://localhost:4023';
const name = process.argv[2] ?? 'teen';
const payer = loadProfile(name).accounts.find((a) => a.credNumber === 1)!;
const grpc = connect();
const safe = (_k: string, v: unknown) => (typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v);

const info = await (await fetch(`${INSURER}/info`)).json() as { cover: { index: string }; operator: string };
const status = await (await fetch(`${INSURER}/cover/status?payer=${payer.address}`)).json() as { onChain: { policyId: string | null } };
if (status.onChain.policyId === null) throw new Error(`${name} has no live policy; run: cli.ts ${name} cover-buy 50 30`);

const fake = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const sender = sdk.AccountAddress.fromBase58(payer.address);
const { nonce } = await grpc.getNextAccountNonce(sender);
const message = encodeFileClaim({ policyId: BigInt(status.onChain.policyId), kind: 'WrongItem', amount: 40_000_000n, evidence: fake(), orders: [fake()] });
const tx = (Transaction.updateContract({
  amount: sdk.CcdAmount.zero(), address: sdk.ContractAddress.create(BigInt(info.cover.index), 0n),
  receiveName: sdk.ReceiveName.fromString('kuasa_cover.fileClaim'), message: sdk.Parameter.fromBuffer(message.slice().buffer as ArrayBuffer),
}, sdk.Energy.create(60_000)) as Transaction.Builder)
  .addMetadata({ sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) })
  .addSponsor(sdk.AccountAddress.fromBase58(info.operator))
  .build();
const signed = await Transaction.sign(tx as never, sdk.buildBasicAccountSigner(payer.key));
const res = await fetch(`${INSURER}/claims/sponsor`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tx: JSON.parse(JSON.stringify(Transaction.toJSON(signed), safe)), receiptTxs: [] }),
});
console.log(res.status, JSON.stringify(await res.json(), null, 2));
process.exit(0);
