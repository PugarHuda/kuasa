import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { AccountAddress, buildBasicAccountSigner } from '@concordium/web-sdk';
import { makePayerProof, verifyPayerProof } from '../src/payer-proof.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64u = (s: string) => Buffer.from(s, 'base64url').toString('hex');
const priv = b64u(privateKey.export({ format: 'jwk' }).d!);
const pub = b64u(publicKey.export({ format: 'jwk' }).x!);
const PAYER = AccountAddress.fromBuffer(new Uint8Array(32).fill(2).buffer).address;
const OTHER = AccountAddress.fromBuffer(new Uint8Array(32).fill(3).buffer).address;
const accountInfo = async () => ({
  accountAddress: AccountAddress.fromBase58(PAYER), accountThreshold: 1,
  accountCredentials: { 0: { v: 0, value: { type: 'normal', contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: 'Ed25519', verifyKey: pub } } } } } } },
}) as never;

test('a payer proof from the payer key verifies for its audience and window only', async () => {
  const now = 1_800_000_000_000;
  const h = await makePayerProof(PAYER, buildBasicAccountSigner(priv), 'http://localhost:4023', now);
  const get = (k: string) => (h as Record<string, string>)[k];
  assert.equal(await verifyPayerProof({ header: get, payer: PAYER, audience: 'http://localhost:4023', now, accountInfo }), true);
  assert.equal(await verifyPayerProof({ header: get, payer: PAYER, audience: 'http://localhost:4021', now, accountInfo }), false, 'bound to the service');
  assert.equal(await verifyPayerProof({ header: get, payer: OTHER, audience: 'http://localhost:4023', now, accountInfo }), false, 'bound to the payer');
  assert.equal(await verifyPayerProof({ header: get, payer: PAYER, audience: 'http://localhost:4023', now: now + 6 * 60_000, accountInfo }), false, 'expires');
  assert.equal(await verifyPayerProof({ header: () => undefined, payer: PAYER, audience: 'http://localhost:4023', now, accountInfo }), false, 'missing');
  const forged = { ...h, 'x-kuasa-payer-ts': String(now + 1) };
  assert.equal(await verifyPayerProof({ header: (k) => (forged as Record<string, string>)[k], payer: PAYER, audience: 'http://localhost:4023', now, accountInfo }), false, 'tampered');
});
