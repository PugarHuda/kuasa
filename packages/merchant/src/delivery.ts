import { AccountAddress, type AccountInfo, type AccountSigner, signMessage, verifyMessageSignature } from '@concordium/web-sdk';
import { canonicalJson, type DeliveryNote, deliveryMessage, type SignedDeliveryNote } from '@kuasa/core';

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

/**
 * AP2 Intent Mandates are authorised by the user. Kuasa's form of that authorisation: the mandate's
 * principal signs the intent (without its `user_authorization` field) with their Concordium account.
 */
export const ap2IntentMessage = (intent: object) => {
  const { user_authorization: _omit, ...rest } = intent as { user_authorization?: unknown };
  return `kuasa-ap2-intent:v1:${canonicalJson(rest)}`;
};

export async function signAp2Intent<T extends object>(intent: T, owner: string, key: AccountSigner): Promise<T & { user_authorization: string }> {
  const sig = await signMessage(AccountAddress.fromBase58(owner), ap2IntentMessage(intent), key);
  return { ...intent, user_authorization: Buffer.from(JSON.stringify(sig)).toString('base64url') };
}

/** True iff `owner` signed this intent. */
export async function verifyAp2Intent(intent: object, owner: string, accountInfo: (a: AccountAddress.Type) => Promise<AccountInfo>): Promise<boolean> {
  const auth = (intent as { user_authorization?: unknown }).user_authorization;
  if (typeof auth !== 'string') return false;
  try {
    const sig = JSON.parse(Buffer.from(auth, 'base64url').toString());
    return await verifyMessageSignature(ap2IntentMessage(intent), sig, await accountInfo(AccountAddress.fromBase58(owner)));
  } catch {
    return false;
  }
}
