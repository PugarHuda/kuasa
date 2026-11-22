/**
 * Verify & Access V1 against any Concordium wallet: Kuasa (the verifier) anchors a request for 18+ and EU
 * residency bound to the wallet's account; the wallet answers it with requestVerifiablePresentationV1; Kuasa
 * checks the presentation against the chain and anchors the audit record. Used by scripts/wallet-proof.ts
 * and by the hosted /vp endpoints (explorer page wallet.html).
 */
import * as sdk from '@concordium/web-sdk';
import type { ConcordiumGRPCClient } from '@concordium/web-sdk';
import { VerifiablePresentationV1, VerificationAuditRecordV1, VerificationRequestV1 } from '@concordium/web-sdk/wasm';
import { TESTNET } from '@kuasa/chain';
import { loadProfile } from './identity.js';

function verifier() {
  const a = loadProfile('insurer').accounts.find((x) => x.credNumber === 0)!;
  return { sender: sdk.AccountAddress.fromBase58(a.address), signer: sdk.buildBasicAccountSigner(a.key) };
}

export async function anchorWalletRequest(grpc: ConcordiumGRPCClient, account: string) {
  sdk.AccountAddress.fromBase58(account); // throws on anything but an account address
  const ips = [];
  for await (const ip of grpc.getIdentityProviders()) ips.push(new sdk.IdentityProviderDID('Testnet', ip.ipIdentity));
  const claims = VerificationRequestV1.claimsBuilder().addAccountClaims(ips, (b) => { b.addMinimumAge(18); b.addEUResidency(); }).getClaims();
  const request = await VerificationRequestV1.createAndAnchor(grpc, verifier(), {
    given: [
      { label: 'Nonce', context: crypto.getRandomValues(new Uint8Array(32)) },
      { label: 'ConnectionID', context: 'kuasa-browser-wallet' },
      { label: 'ResourceID', context: 'kuasa-mandate' },
      { label: 'ContextString', context: `kuasa:v1:${TESTNET.caip2}:${account}:browser-wallet` },
    ],
    requested: ['BlockHash'],
  }, claims);
  await grpc.waitForTransactionFinalization(request.transactionRef);
  return { request: request.toJSON(), requestAnchorTx: sdk.TransactionHash.toHexString(request.transactionRef) };
}

export async function checkWalletPresentation(grpc: ConcordiumGRPCClient, requestJson: unknown, presentationJson: unknown) {
  const request = VerificationRequestV1.fromJSON(requestJson as VerificationRequestV1.JSON);
  const presentation = VerifiablePresentationV1.fromJSON(presentationJson as VerifiablePresentationV1.JSON);
  const checked = await VerificationAuditRecordV1.createChecked(crypto.randomUUID(), request, presentation, grpc, 'Testnet');
  if (checked.type === 'failed') return { verified: false as const, error: checked.error.message };
  const v = verifier();
  const { nonce } = await grpc.getNextAccountNonce(v.sender);
  const vaa = await VerificationAuditRecordV1.registerAnchor(checked.result, grpc, { ...v, sequenceNumber: nonce }, { service: 'kuasa-cover', purpose: 'mandate-browser-wallet' });
  await grpc.waitForTransactionFinalization(vaa);
  return { verified: true as const, record: checked.result, requestAnchorTx: sdk.TransactionHash.toHexString(request.transactionRef), auditAnchorTx: sdk.TransactionHash.toHexString(vaa) };
}
