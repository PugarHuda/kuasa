/**
 * Produces the principal's Verify & Access (V1) audit record for a mandate, headlessly.
 *
 * The proof is made with the *agent payer account's* credential (same identity as the owner),
 * and its request context carries proofBinding(mandate), so it only works for this agent.
 * Commitment randomness is re-derived from the identity seed, so nothing extra is stored.
 */
import * as sdk from '@concordium/web-sdk';
import type { ConcordiumGRPCClient } from '@concordium/web-sdk';
import { VerifiablePresentationV1, VerificationAuditRecordV1, VerificationRequestV1 } from '@concordium/web-sdk/wasm';
import type { Profile } from './identity.js';

const IP_INDEX = 0;

export async function createMandateProof(grpc: ConcordiumGRPCClient, p: Profile, payerCredNumber: number, binding: string, want: { minAge?: number; euResidency?: boolean }) {
  const acc = p.accounts.find((a) => a.credNumber === payerCredNumber)!;
  const sender = { sender: sdk.AccountAddress.fromBase58(acc.address), signer: sdk.buildBasicAccountSigner(acc.key) };

  const claims = VerificationRequestV1.claimsBuilder()
    .addAccountClaims([new sdk.IdentityProviderDID('Testnet', IP_INDEX)], (b) => {
      if (want.minAge) b.addMinimumAge(want.minAge);
      if (want.euResidency) b.addEUResidency();
    })
    .getClaims();

  const request = await VerificationRequestV1.createAndAnchor(grpc, sender, {
    given: [
      { label: 'Nonce', context: crypto.getRandomValues(new Uint8Array(32)) },
      { label: 'ConnectionID', context: `kuasa-${p.name}` },
      { label: 'ResourceID', context: 'kuasa-mandate' },
      { label: 'ContextString', context: binding },
    ],
    requested: ['BlockHash'],
  }, claims);
  await grpc.waitForTransactionFinalization(request.transactionRef);

  const values: Record<string, string> = (p.idObject.value ?? p.idObject).attributeList.chosenAttributes;
  const hd = sdk.ConcordiumHdWallet.fromHex(p.seed, 'Testnet');
  const randomness = Object.fromEntries(Object.keys(values).map((k) => [k, hd.getAttributeCommitmentRandomness(IP_INDEX, 0, payerCredNumber, sdk.AttributesKeys[k as keyof typeof sdk.AttributesKeys]).toString('hex')]));

  const statements = VerifiablePresentationV1.noRevealRequestedStatements(claims[0].statements);
  const accountClaims = VerifiablePresentationV1.createAccountClaims('Testnet', sdk.CredentialRegistrationId.fromHexString(acc.credId), IP_INDEX, statements);
  // The requested BlockHash context is filled by the SDK with the anchor's block.
  const presentation = await VerifiablePresentationV1.createFromAnchor(
    grpc, request, [accountClaims], [{ type: 'account', issuer: IP_INDEX, values, randomness }], [],
  );

  const checked = await VerificationAuditRecordV1.createChecked(crypto.randomUUID(), request, presentation, grpc, 'Testnet');
  if (checked.type === 'failed') throw new Error(`own proof failed verification: ${checked.error.message}`);
  // third step of the V1 flow: the Verification Audit Anchor, the record's hash registered on-chain
  const { nonce } = await grpc.getNextAccountNonce(sender.sender);
  const vaa = await VerificationAuditRecordV1.registerAnchor(checked.result, grpc, { ...sender, sequenceNumber: nonce }, { service: 'kuasa-cover', purpose: 'mandate' });
  await grpc.waitForTransactionFinalization(vaa);
  return { json: JSON.stringify(checked.result), anchorTx: sdk.TransactionHash.toHexString(request.transactionRef), auditAnchorTx: sdk.TransactionHash.toHexString(vaa) };
}
