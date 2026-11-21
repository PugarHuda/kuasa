import { AccountAddress, type AccountInfo, type AccountSigner, signMessage, verifyMessageSignature } from '@concordium/web-sdk';
import { type DeliveryNote, deliveryMessage, type SignedDeliveryNote } from '@kuasa/core';

/** Signs a delivery note with the merchant's receipt-recorder account. */
export async function signDeliveryNote(note: DeliveryNote, signer: string, key: AccountSigner): Promise<SignedDeliveryNote> {
  return { note, signer, sig: await signMessage(AccountAddress.fromBase58(signer), deliveryMessage(note), key) };
}

/** True iff `expectedSigner` (the account that recorded the order's receipt on-chain) signed this note. */
export async function verifyDeliveryNote(d: SignedDeliveryNote, expectedSigner: string, accountInfo: (a: AccountAddress.Type) => Promise<AccountInfo>): Promise<boolean> {
  if (d.signer !== expectedSigner) return false;
  try {
    return await verifyMessageSignature(deliveryMessage(d.note), d.sig as never, await accountInfo(AccountAddress.fromBase58(d.signer)));
  } catch {
    return false;
  }
}
