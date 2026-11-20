/**
 * Stands in for the owner's wallet: fetches a transaction the console prepared, shows what it does,
 * checks it targets the expected contract and is for this owner, then signs it with the owner's own
 * key and submits it. The console never sees the key.
 * Usage: tsx owner-sign.ts <alice|teen> <publish-cover|revoke>
 */
import { Transaction } from '@concordium/web-sdk/transactions';
import { connect, signAndSend, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const [name, action] = process.argv.slice(2);
if (!['publish-cover', 'revoke'].includes(action)) throw new Error('usage: owner-sign.ts <name> <publish-cover|revoke>');
const CONSOLE = process.env.KUASA_CONSOLE_URL ?? 'http://localhost:4022';
const prep = await (await fetch(`${CONSOLE}/api/prepare/${action}/${name}`, { method: 'POST', headers: { 'x-kuasa-console': '1' } })).json() as { signer: string; action: string; value?: string; transaction: unknown; error?: string };
if (prep.error) throw new Error(prep.error);

const owner = loadProfile(name).accounts.find((a) => a.credNumber === 0)!;
const tx = Transaction.signableFromJSON(prep.transaction) as unknown as { header: { sender: { address: string } }; payload: { receiveName: { value?: string } | string } };
const sender = String((tx.header.sender as unknown as { address?: string }).address ?? tx.header.sender);
const receive = JSON.stringify(tx.payload.receiveName);
const expected = action === 'revoke' ? 'kuasa.revoke' : 'CIS-8004.setMetadata';
console.log(`wallet: ${prep.action}${prep.value ? ` = ${prep.value}` : ''}\n        call ${receive}, sender ${sender}`);
if (sender !== owner.address) throw new Error('refusing: the transaction is not for this owner account');
if (!receive.includes(expected)) throw new Error(`refusing: expected a call to ${expected}`);
const r = await signAndSend(connect(), prep.transaction, wallet(owner.address, owner.key));
console.log('signed by the owner and submitted', r.hash);
process.exit(0);
