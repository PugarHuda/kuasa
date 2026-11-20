/**
 * Stands in for the owner's wallet. It fetches a transaction the console prepared, rebuilds the
 * transaction it expects from what the owner knows (their agent token, their mandate id, the
 * contracts), and signs only if the console's version is exactly that: same contract, entrypoint,
 * amount (zero), parameter bytes, sender and energy, with no sponsor. Only the nonce and expiry are
 * taken from the console. The console never sees the key.
 * Usage: tsx owner-sign.ts <alice|teen> <publish-cover|revoke>   (DRY=1 verifies without signing)
 */
import { readFileSync } from 'node:fs';
import { connect, encodeSetMetadata, signAndSend, wallet } from '@kuasa/chain';
import { encodeRevoke } from '@kuasa/core';
import { loadProfile } from './lib/identity.js';

const [name, action] = process.argv.slice(2);
if (!['publish-cover', 'revoke'].includes(action)) throw new Error('usage: owner-sign.ts <name> <publish-cover|revoke>');
const CONSOLE = process.env.KUASA_CONSOLE_URL ?? 'http://localhost:4022';
const state = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { registry: string; cover: string; agents: Record<string, string>; mandates: Record<string, { id: string }> };
const owner = loadProfile(name).accounts.find((a) => a.credNumber === 0)!;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const prep = await (await fetch(`${CONSOLE}/api/prepare/${action}/${name}`, { method: 'POST', headers: { 'x-kuasa-console': '1' } })).json() as { action: string; value?: string; transaction: { header: Record<string, unknown>; payload: Record<string, unknown> }; error?: string };
if (prep.error) throw new Error(prep.error);
const { header, payload } = prep.transaction;

// What the owner expects, built from the owner's own data.
let expected: { address: number; receiveName: string; message: string };
if (action === 'publish-cover') {
  const value = String(prep.value ?? '');
  if (!new RegExp(`^policy=\\d+;limit=\\d+;cover=${state.cover}\\.0;at=\\d+$`).test(value)) throw new Error(`refusing: unexpected cover status value "${value}"`);
  expected = { address: 12802, receiveName: 'CIS-8004.setMetadata', message: hex(encodeSetMetadata(state.agents[name], 'kuasa:cover', value)) };
} else {
  // the revoke reason is a free hash chosen by the console; everything else must be the owner's mandate
  const reason = String(payload.message ?? '').slice(-64);
  if (!/^[0-9a-f]{64}$/.test(reason)) throw new Error('refusing: malformed revoke parameter');
  expected = { address: Number(state.registry), receiveName: 'kuasa.revoke', message: hex(encodeRevoke(state.mandates[name].id, reason)) };
}

const problems = [
  payload.type !== 'update' && 'not a contract update',
  String(payload.amount) !== '0' && 'amount is not zero',
  ((payload.address as { index?: number })?.index !== expected.address || (payload.address as { subindex?: number })?.subindex !== 0) && 'wrong contract',
  payload.receiveName !== expected.receiveName && 'wrong entrypoint',
  payload.message !== expected.message && 'parameter differs from what the owner expects',
  header.sender !== owner.address && 'not for this owner account',
  Number(header.executionEnergyAmount) !== 30_000 && 'unexpected energy',
  'sponsor' in header && header.sponsor !== undefined && 'unexpected sponsor',
].filter(Boolean);
if (problems.length) throw new Error(`refusing to sign: ${problems.join('; ')}`);

console.log(`wallet: ${prep.action}${prep.value ? ` = ${prep.value}` : ''}\n        verified: ${expected.receiveName} on <${expected.address},0>, amount 0, parameter rebuilt locally`);
if (process.env.DRY) { console.log('DRY=1: verified, not signed'); process.exit(0); }
const r = await signAndSend(connect(), prep.transaction, wallet(owner.address, owner.key));
console.log('signed by the owner and submitted', r.hash);
process.exit(0);
