/**
 * Demo: compliance enforced by the money itself. Alice's agent tries to send 1 EUDemo to an account
 * that never proved EU nationality (the insurer operator, not on the allow list). The chain rejects it; no
 * Kuasa code is involved. Client-side validation is off so the rejection comes from the protocol.
 *
 * Usage: pnpm --filter @kuasa/scripts exec tsx token-compliance.ts
 */
import * as sdk from '@concordium/web-sdk';
import { bigintJson, connect } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const grpc = connect();
const acct = (name: string, n: number) => loadProfile(name).accounts.find((a) => a.credNumber === n)!;
const from = acct('alice', 1);
const to = acct('insurer', 1); // insurer operator: never proved EU nationality, not on the allow list

const token = await sdk.Token.fromId(grpc, sdk.TokenId.fromString('EUDemo'));
const hash = await sdk.Token.transfer(
  token, sdk.AccountAddress.fromBase58(from.address),
  { recipient: sdk.AccountAddress.fromBase58(to.address), amount: sdk.TokenAmount.create(1_000_000n, 6) },
  sdk.buildBasicAccountSigner(from.key), undefined, { autoScale: false, validate: false },
);
const { summary } = await grpc.waitForTransactionFinalization(hash);
const s = summary as any;
console.log('tx', sdk.TransactionHash.toHexString(hash));
console.log(s.transactionType === 'failed' ? `REJECTED by the chain: ${JSON.stringify(s.rejectReason, bigintJson)}` : `unexpectedly accepted: ${JSON.stringify(s, bigintJson)}`);
process.exit(0);
