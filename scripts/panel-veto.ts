/**
 * The panel vetoes an escrowed slash on kuasa-market (v4+): the market's arbiter is the panel account,
 * whose credential needs 2 of the 3 juror keys. One key is rejected by the node, two are accepted, and
 * the escrowed penalty goes back into the insurer's bond.
 * Usage: tsx panel-veto.ts <claim id>   (a claim on Kuasa Re's cover slashed into escrow)
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { connect } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const st = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { marketContract: string; market: { cover: string; treasury: string }[] };
const grpc = connect();
const acc = (name: string, n: number) => loadProfile(name).accounts.find((a) => a.credNumber === n)!;
const panel = acc('panel', 0);
const jurors = [acc('teen', 0), acc('teen', 1), acc('investor', 0)];
const claimId = BigInt(process.argv[2]);
const u64 = (v: bigint) => new Uint8Array(new BigUint64Array([v]).buffer);
// EscrowRef { pool, cover: ContractAddress, claim_id }
const param = new Uint8Array([...sdk.AccountAddress.fromBase58(st.market[0].treasury).decodedAddress, ...u64(BigInt(st.market[0].cover)), ...u64(0n), ...u64(claimId)]);
const signer = (idx: number[]) => sdk.buildAccountSigner(Object.fromEntries([[0, Object.fromEntries(idx.map((i) => [i, jurors[i].key]))]]) as sdk.SimpleAccountKeys);

async function veto(idx: number[]) {
  const sender = sdk.AccountAddress.fromBase58(panel.address);
  const { nonce } = await grpc.getNextAccountNonce(sender);
  const t = {
    header: { sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) },
    type: sdk.AccountTransactionType.Update,
    payload: { amount: sdk.CcdAmount.zero(), address: sdk.ContractAddress.create(BigInt(st.marketContract), 0n), receiveName: sdk.ReceiveName.fromString('kuasa_market.vetoSlash'), message: sdk.Parameter.fromBuffer(param.buffer), maxContractExecutionEnergy: sdk.Energy.create(60_000) },
  } as unknown as sdk.AccountTransaction;
  const hash = await grpc.sendAccountTransaction(t, await sdk.signTransaction(t, signer(idx)));
  const done = await grpc.waitForTransactionFinalization(hash);
  const s = done.summary as any;
  return `${sdk.TransactionHash.toHexString(hash)} ${s.transactionType}${s.rejectReason ? ` ${JSON.stringify(s.rejectReason)}` : ''}`;
}
try { console.log('veto with one juror key:', await veto([0])); } catch (e) { console.log('veto with one juror key: rejected by the node -', (e as Error).message.slice(0, 80)); }
console.log('veto with two juror keys (teen #0 + investor):', await veto([0, 2]));
process.exit(0);
