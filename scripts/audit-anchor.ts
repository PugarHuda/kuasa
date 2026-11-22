/**
 * Verification Audit Anchors for the mandate proofs already in use: the third step of the Verify & Access
 * V1 flow (request anchor, presentation, audit anchor). Each stored audit record (.kuasa/public/proof/*.json,
 * whose sha256 the mandate carries) gets its hash registered on-chain by the account that made the proof,
 * then is checked back with verifyAnchor. The records and mandates are not changed (their hashes are bound).
 * Writes docs/explorer/vaa.json: { name: { auditRecordId, anchorTx } }.  Usage: tsx audit-anchor.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { VerificationAuditRecordV1 } from '@concordium/web-sdk/wasm';
import { connect } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const dir = new URL('../.kuasa/public/proof/', import.meta.url);
const outFile = new URL('../docs/explorer/vaa.json', import.meta.url);
const out: Record<string, { auditRecordId: string; anchorTx: string }> = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};
const state = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { mandates: Record<string, { payer: string }> };
const grpc = connect();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const name = f.replace(/\.json$/, '');
  if (out[name]) { console.log(`${name}: already anchored ${out[name].anchorTx}`); continue; }
  const record = VerificationAuditRecordV1.fromJSON(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
  const payer = state.mandates[name]?.payer;
  const acc = payer && loadProfile(name).accounts.find((a) => a.address === payer);
  if (!acc) { console.log(`${name}: no proving account found, skipped`); continue; }
  const sender = sdk.AccountAddress.fromBase58(acc.address);
  const { nonce } = await grpc.getNextAccountNonce(sender);
  const tx = await VerificationAuditRecordV1.registerAnchor(record, grpc, { sender, sequenceNumber: nonce, signer: sdk.buildBasicAccountSigner(acc.key) }, { service: 'kuasa-cover', purpose: 'mandate' });
  await grpc.waitForTransactionFinalization(tx);
  await VerificationAuditRecordV1.verifyAnchor(record, tx, grpc); // throws if the on-chain hash does not match
  out[name] = { auditRecordId: record.id, anchorTx: sdk.TransactionHash.toHexString(tx) };
  console.log(`${name}: audit anchor ${out[name].anchorTx} (verified)`);
}
writeFileSync(outFile, JSON.stringify(out, null, 2));
process.exit(0);
