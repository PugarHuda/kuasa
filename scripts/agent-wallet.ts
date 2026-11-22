/**
 * Binds each agent's payment wallet on-chain (CIS-8004 setAgentWallet), the official way: the hosted Agent
 * Registry MCP gives the 162-byte canonical message, the wallet's own key signs it (proof the wallet agrees),
 * and the agent's owner submits the payload. The registry clears the wallet when the agent NFT is
 * transferred, so the binding cannot outlive an ownership change.
 *   buyers: the mandate payer (the account that pays); shop: its payTo; insurer: its treasury.
 * Usage: tsx agent-wallet.ts [name ...]   (idempotent: skips agents whose wallet is already set)
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { bigintJson, connect } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';
import { mcp } from './lib/registry-mcp.js';

const state = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { agents: Record<string, string>; shopAgent: string; insurerAgent: string };
const tokenDec = (hex: string) => Buffer.from(hex, 'hex').readBigUInt64LE().toString();
const acct = (profile: string, n: number) => loadProfile(profile).accounts.find((a) => a.credNumber === n)!;
const cast = [
  { name: 'alice', profile: 'alice', token: state.agents.alice, wallet: acct('alice', 1) },
  { name: 'teen', profile: 'teen', token: state.agents.teen, wallet: acct('teen', 1) },
  { name: 'bob', profile: 'bob', token: state.agents.bob, wallet: acct('bob', 1) },
  { name: 'carol', profile: 'carol', token: state.agents.carol, wallet: acct('carol', 1) },
  { name: 'shop', profile: 'merchant', token: state.shopAgent, wallet: acct('merchant', 0) },
  { name: 'insurer', profile: 'insurer', token: state.insurerAgent, wallet: acct('insurer', 0) },
].filter((a) => a.token && (process.argv.length <= 2 || process.argv.slice(2).includes(a.name)));

const grpc = connect();
for (const a of cast) {
  const token_id = tokenDec(a.token);
  const current = await mcp<{ wallet?: string | null; agent_wallet?: string | null } | string | null>('get_agent_wallet', { token_id, network: 'testnet' });
  const cur = typeof current === 'string' ? current : current?.wallet ?? current?.agent_wallet ?? null;
  if (cur === a.wallet.address) { console.log(`${a.name} (#${token_id}): wallet already ${cur}`); continue; }
  const deadline = Date.now() + 10 * 60_000;
  const canon = await mcp<Record<string, string>>('set_agent_wallet_canonical_bytes', { token_id, new_wallet: a.wallet.address, deadline_unix_ms: deadline, network: 'testnet' });
  const hex = canon.canonical_bytes_hex ?? canon.bytes_hex ?? canon.hex;
  const ownerAddr = canon.owner ?? canon.owner_account;
  // the wallet agrees: a raw ed25519 signature by its key over the canonical bytes
  const sig = await sdk.buildBasicAccountSigner(a.wallet.key).sign(Buffer.from(hex, 'hex'));
  const signature_hex = (sig as unknown as Record<number, Record<number, string>>)[0][0];
  const owner = loadProfile(a.profile).accounts.find((x) => x.address === ownerAddr) ?? acct(a.profile, 0);
  const built = await mcp<{ contract_address: { index: number; subindex?: number }; receive_name: string; parameter_hex: string; suggested_energy?: number }>('build_set_agent_wallet', { token_id, new_wallet: a.wallet.address, deadline_unix_ms: deadline, signature_hex, sender: owner.address, network: 'testnet' });
  const sender = sdk.AccountAddress.fromBase58(owner.address);
  const { nonce } = await grpc.getNextAccountNonce(sender);
  const tx = {
    type: sdk.AccountTransactionType.Update,
    header: { sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(5) },
    payload: {
      amount: sdk.CcdAmount.zero(),
      address: sdk.ContractAddress.create(BigInt(built.contract_address.index), BigInt(built.contract_address.subindex ?? 0)),
      receiveName: sdk.ReceiveName.fromString(built.receive_name),
      message: sdk.Parameter.fromHexString(built.parameter_hex),
      maxContractExecutionEnergy: sdk.Energy.create(built.suggested_energy ?? 30_000),
    },
  } as unknown as sdk.AccountTransaction;
  const hash = await grpc.sendAccountTransaction(tx, await sdk.signTransaction(tx, sdk.buildBasicAccountSigner(owner.key)));
  const done = await grpc.waitForTransactionFinalization(hash);
  const s = done.summary as unknown as Record<string, unknown>;
  if (s.transactionType === 'failed') throw new Error(`${a.name}: setAgentWallet rejected ${JSON.stringify(s, bigintJson)}`);
  console.log(`${a.name} (#${token_id}): wallet ${a.wallet.address} bound, tx ${sdk.TransactionHash.toHexString(hash)}`);
}
process.exit(0);
