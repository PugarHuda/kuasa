/**
 * The market arbiter as a Concordium-native multisig: the panel account's credential is re-keyed to the
 * three jurors' public keys with threshold 2 (UpdateCredentialKeys), so no single juror can slash a bond.
 * Then proves it on-chain: a registerData signed by one juror key is rejected, by two keys accepted.
 * Usage: tsx panel-multisig.ts   (after provision.ts panel). Idempotent: skips the re-key if done.
 */
import * as sdk from '@concordium/web-sdk';
import { connect } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const grpc = connect();
const acc = (name: string, n: number) => loadProfile(name).accounts.find((a) => a.credNumber === n)!;
const panel = acc('panel', 0);
const jurors = [acc('teen', 0), acc('teen', 1), acc('investor', 0)];
const verifyKeyOf = async (address: string) => {
  const info = await grpc.getAccountInfo(sdk.AccountAddress.fromBase58(address));
  const cred = (info.accountCredentials as any)[0].value.contents;
  return cred.credentialPublicKeys.keys[0].verifyKey as string;
};
const info = await grpc.getAccountInfo(sdk.AccountAddress.fromBase58(panel.address));
const cred = (info.accountCredentials as any)[0].value.contents;
const current = cred.credentialPublicKeys;
console.log('panel', panel.address, 'keys now:', Object.keys(current.keys).length, 'threshold', current.threshold);

if (Object.keys(current.keys).length !== 3) {
  const keys: Record<number, { schemeId: string; verifyKey: string }> = {};
  for (const [i, j] of jurors.entries()) keys[i] = { schemeId: 'Ed25519', verifyKey: await verifyKeyOf(j.address) };
  const credId = sdk.CredentialRegistrationId.fromHexString(cred.credId ?? cred.regId);
  // the builder API does not cover UpdateCredentialKeys yet: the legacy account-transaction path does
  const sender = sdk.AccountAddress.fromBase58(panel.address);
  const { nonce } = await grpc.getNextAccountNonce(sender);
  const accountTransaction = {
    header: { sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) },
    type: sdk.AccountTransactionType.UpdateCredentialKeys,
    payload: { credId, keys: { keys, threshold: 2 }, currentNumberOfCredentials: 1n },
  } as unknown as sdk.AccountTransaction;
  const signature = await sdk.signTransaction(accountTransaction, sdk.buildBasicAccountSigner(panel.key));
  const hash = await grpc.sendAccountTransaction(accountTransaction, signature);
  const done = await grpc.waitForTransactionFinalization(hash);
  console.log('re-keyed to the 3 jurors, threshold 2:', sdk.TransactionHash.toHexString(hash), (done.summary as any).transactionType);
}

// a registerData needs the account threshold: one juror key fails, two succeed (legacy path: the
// number of signatures is derived from the signer)
const signer = (idx: number[]) => sdk.buildAccountSigner(Object.fromEntries([[0, Object.fromEntries(idx.map((i) => [i, jurors[i].key]))]]) as sdk.SimpleAccountKeys);
async function note(text: string, idx: number[]) {
  const sender = sdk.AccountAddress.fromBase58(panel.address);
  const { nonce } = await grpc.getNextAccountNonce(sender);
  const t = { header: { sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }, type: sdk.AccountTransactionType.RegisterData, payload: { data: new sdk.DataBlob(Buffer.from(text)) } } as unknown as sdk.AccountTransaction;
  const hash = await grpc.sendAccountTransaction(t, await sdk.signTransaction(t, signer(idx)));
  const done = await grpc.waitForTransactionFinalization(hash);
  return `${sdk.TransactionHash.toHexString(hash)} ${(done.summary as any).transactionType}`;
}
try { console.log('one juror key:', await note('kuasa panel: one juror alone', [0])); } catch (e) { console.log('one juror key: rejected by the node -', (e as Error).message.slice(0, 80)); }
console.log('two juror keys (teen #0 + investor):', await note('kuasa panel: two of three jurors', [0, 2]));
process.exit(0);
