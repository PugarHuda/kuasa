/**
 * Links Alice's agent to an Ethereum key, so agents and merchants on EVM chains can find its
 * Verified-by-Concordium badge and its Kuasa Cover by the 0x address they already know:
 *   1. CIS-8 External Key Registry: the owner account registers the ETH key, proven by an
 *      ethereum-personal-sign signature over the canonical bytes (the ETH key signs, not us).
 *   2. CIS-8004 setExternalReference: the agent NFT points at that CIS-8 entry.
 *   3. agent_by_external_reference resolves the ETH key back to the agent.
 * The ETH key is generated once and kept in .kuasa/ (never committed). Idempotent.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { connect, submit, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';
import { mcp } from './lib/registry-mcp.js';

const NS = 'eip155:1';
const KEY_TYPE = 'secp256k1-uncompressed';
const CIS8 = { index: 12801, subindex: 0 };
const KEY = new URL('../.kuasa/eth-alice-agent.json', import.meta.url);
// owner-only: this is a private key (testnet, but still never world-readable)
if (!existsSync(KEY)) writeFileSync(KEY, JSON.stringify({ privateKey: generatePrivateKey() }), { mode: 0o600, flag: 'wx' });
chmodSync(KEY, 0o600);
const eth = privateKeyToAccount(JSON.parse(readFileSync(KEY, 'utf8')).privateKey);
const pub = eth.publicKey.slice(2);
const state = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { agents: Record<string, string> };
const tokenId = Buffer.from(state.agents.alice, 'hex').readBigUInt64LE().toString();
const acc = loadProfile('alice').accounts.find((a) => a.credNumber === 0)!;
const owner = wallet(acc.address, acc.key);
const grpc = connect();
const externalReference = { contract_address: CIS8, kind: 'Cis8', key: { namespace: NS, key_type: KEY_TYPE, public_key_hex: pub } };

async function send(p: { contract_address: { index: number; subindex: number }; receive_name: string; parameter_hex: string; suggested_energy?: number }) {
  const r = await submit(grpc, Transaction.updateContract({
    amount: sdk.CcdAmount.zero(), address: sdk.ContractAddress.create(BigInt(p.contract_address.index), BigInt(p.contract_address.subindex)),
    receiveName: sdk.ReceiveName.fromString(p.receive_name), message: sdk.Parameter.fromHexString(p.parameter_hex),
  }, sdk.Energy.create(p.suggested_energy ?? 30_000)) as Transaction.Builder, owner);
  if ((r.summary.summary as { transactionType?: string }).transactionType === 'failed') throw new Error(`${p.receive_name} rejected: ${JSON.stringify(r.summary.summary, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 400)}`);
  return r.hash;
}

console.log('agent ETH address', eth.address);
const found = await mcp<{ token_id?: unknown } | null>('agent_by_external_reference', { external_reference: externalReference, network: 'testnet' }).catch(() => null);
if (found) {
  console.log('already linked:', JSON.stringify(found).slice(0, 300));
} else {
  const c = await mcp<{ bytes_hex: string }>('build_cis8_canonical_bytes', { network: 'testnet', concordium_account: acc.address, external_namespace: NS, external_key_namespace: NS, external_key_type: KEY_TYPE, external_public_key_hex: pub, proof_scheme: 'ethereum-personal-sign' });
  const signature = await eth.signMessage({ message: { raw: `0x${c.bytes_hex}` } });
  const reg = await mcp<Parameters<typeof send>[0]>('build_cis8_register', {
    network: 'testnet', sender: acc.address, external_key: { namespace: NS, key_type: KEY_TYPE, public_key_hex: pub },
    proof: { scheme: 'ethereum-personal-sign', signature_hex: signature.slice(2) },
    metadata: [{ key: 'role', value: 'kuasa-insured-shopping-agent' }, { key: 'evmAddress', value: eth.address }],
  });
  console.log('CIS-8 registerExternalKey', await send(reg));
  const ext = await mcp<Parameters<typeof send>[0]>('build_set_external_reference', { network: 'testnet', token_id: tokenId, sender: acc.address, external_reference: externalReference });
  console.log('CIS-8004 setExternalReference', await send(ext));
  const back = await mcp<Record<string, unknown> | null>('agent_by_external_reference', { external_reference: externalReference, network: 'testnet' });
  console.log('resolved from the ETH key:', JSON.stringify(back).slice(0, 400));
}
process.exit(0);
