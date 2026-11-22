/**
 * Verify & Access V1 with a real Concordium Browser Wallet, not keys in a script.
 *   tsx wallet-proof.ts request <walletAccount>   Kuasa (the verifier) anchors the request: 18+ and EU
 *                                                 residency, bound to that account; writes the request JSON
 *   (the wallet answers it: window.concordium.requestVerifiablePresentationV1(request), the user approves)
 *   tsx wallet-proof.ts finish <presentation.json> Kuasa checks the wallet's presentation against the chain,
 *                                                 anchors the audit record and writes docs/explorer/wallet-proof.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { VerifiablePresentationV1, VerificationAuditRecordV1, VerificationRequestV1 } from '@concordium/web-sdk/wasm';
import { connect, TESTNET } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const grpc = connect();
const verifier = loadProfile('insurer').accounts.find((a) => a.credNumber === 0)!;
const sender = { sender: sdk.AccountAddress.fromBase58(verifier.address), signer: sdk.buildBasicAccountSigner(verifier.key) };
const reqFile = new URL('../.kuasa/wallet/request.json', import.meta.url);
const [mode, arg] = process.argv.slice(2);

if (mode === 'request') {
  sdk.AccountAddress.fromBase58(arg); // must be an account address
  // any testnet identity provider the wallet's identity may come from
  const ips = [];
  for await (const ip of grpc.getIdentityProviders()) ips.push(new sdk.IdentityProviderDID('Testnet', ip.ipIdentity));
  const claims = VerificationRequestV1.claimsBuilder()
    .addAccountClaims(ips, (b) => { b.addMinimumAge(18); b.addEUResidency(); })
    .getClaims();
  const request = await VerificationRequestV1.createAndAnchor(grpc, sender, {
    given: [
      { label: 'Nonce', context: crypto.getRandomValues(new Uint8Array(32)) },
      { label: 'ConnectionID', context: 'kuasa-browser-wallet' },
      { label: 'ResourceID', context: 'kuasa-mandate' },
      { label: 'ContextString', context: `kuasa:v1:${TESTNET.caip2}:${arg}:browser-wallet` },
    ],
    requested: ['BlockHash'],
  }, claims);
  await grpc.waitForTransactionFinalization(request.transactionRef);
  writeFileSync(reqFile, JSON.stringify(request.toJSON()));
  console.log(`request anchored: ${sdk.TransactionHash.toHexString(request.transactionRef)} -> .kuasa/wallet/request.json`);
} else if (mode === 'finish') {
  const request = VerificationRequestV1.fromJSON(JSON.parse(readFileSync(reqFile, 'utf8')));
  const presentation = VerifiablePresentationV1.fromJSON(JSON.parse(readFileSync(arg, 'utf8')));
  const checked = await VerificationAuditRecordV1.createChecked(crypto.randomUUID(), request, presentation, grpc, 'Testnet');
  if (checked.type === 'failed') throw new Error(`wallet presentation failed verification: ${checked.error.message}`);
  const { nonce } = await grpc.getNextAccountNonce(sender.sender);
  const vaa = await VerificationAuditRecordV1.registerAnchor(checked.result, grpc, { ...sender, sequenceNumber: nonce }, { service: 'kuasa-cover', purpose: 'mandate-browser-wallet' });
  await grpc.waitForTransactionFinalization(vaa);
  const out = {
    what: 'A Verify & Access V1 presentation made by the Concordium Browser Wallet (not by keys in a script): 18+ and EU residency, zero-knowledge, bound to the wallet account',
    requestAnchorTx: sdk.TransactionHash.toHexString(request.transactionRef),
    auditAnchorTx: sdk.TransactionHash.toHexString(vaa),
    record: checked.result,
  };
  writeFileSync(new URL('../docs/explorer/wallet-proof.json', import.meta.url), JSON.stringify(out, null, 1));
  console.log(`verified; audit anchor ${out.auditAnchorTx} -> docs/explorer/wallet-proof.json`);
} else throw new Error('usage: wallet-proof.ts request <account> | finish <presentation.json>');
process.exit(0);
