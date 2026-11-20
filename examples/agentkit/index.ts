/**
 * Verifies the Kuasa actions end to end against testnet with a real EVM signer (the demo agent's
 * Ethereum key from .kuasa/): the agent proves it is insured, a counterparty checks the same signed
 * challenge, and the insurer's solvency is read. Run: node --import tsx index.ts
 */
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { kuasaActions } from './kuasa.js';

const key = JSON.parse(readFileSync(new URL('../../.kuasa/eth-alice-agent.json', import.meta.url), 'utf8')).privateKey;
const account = privateKeyToAccount(key);
// AgentKit's EvmWalletProvider.signMessage(message) shape, backed by a viem account
const wallet = { address: account.address, signMessage: (message: string) => account.signMessage({ message }) };
const act = (name: string) => kuasaActions.find((a) => a.name === name)!.invoke as (...args: unknown[]) => Promise<string>;
console.log(`EVM agent ${wallet.address}: ${kuasaActions.length} Kuasa actions (${kuasaActions.map((a) => a.name).join(', ')})`);
const proof = JSON.parse(await act('kuasa_prove_insured')(wallet, {}));
console.log('\nkuasa_prove_insured ->', JSON.stringify(proof.verified, null, 2));
const check = JSON.parse(await act('kuasa_check_counterparty')({ message: proof.message, signature: proof.signature, nonce: proof.nonce }));
console.log('\nkuasa_check_counterparty -> insured:', check.insured);
console.log('\nkuasa_insurer_solvency ->', await act('kuasa_insurer_solvency')({}));
