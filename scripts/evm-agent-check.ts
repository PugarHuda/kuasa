/**
 * What a merchant or agent on an EVM chain does before trusting Alice's agent: the agent signs a
 * fresh challenge with its Ethereum key, and the public Kuasa A2A endpoint answers with its
 * Concordium badge and Kuasa Cover (via the CIS-8 binding made by cross-chain.ts).
 * Usage: tsx evm-agent-check.ts [a2a url]
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

const url = process.argv[2] ?? 'https://kuasa-explorer.vercel.app/a2a';
const eth = privateKeyToAccount(JSON.parse(readFileSync(new URL('../.kuasa/eth-alice-agent.json', import.meta.url), 'utf8')).privateKey);
// The relying party issues a fresh nonce; the agent signs it for this verifier.
const nonce = randomBytes(16).toString('hex');
const message = `kuasa-evm-agent:v1:${new URL(url).host}:${nonce}:${Date.now()}`;
const signature = await eth.signMessage({ message });
console.log('EVM agent', eth.address, 'signed', message);
const r = await fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'evm-check', parts: [{ kind: 'data', data: { skill: 'verify-evm-agent', message, signature, nonce } }] } } }),
});
const out = await r.json() as { result?: { parts: { data: { nonce?: string } }[] } };
if (out.result && out.result.parts[0].data.nonce !== nonce) throw new Error('answer is not for our nonce');
console.log(JSON.stringify(out, null, 2));
process.exit(0);
