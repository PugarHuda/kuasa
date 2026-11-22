/**
 * Owner actions signed in the owner's own Concordium Wallet, with Kuasa paying the fee (a sponsored
 * transaction, Protocol 10): Kuasa builds the transaction with the owner as sender and itself as sponsor,
 * signs as sponsor and hands the JSON to the page; the wallet shows it, signs as sender and submits.
 * Kuasa never holds the owner's key, and the owner needs no CCD.
 *   register  mint the owner's agent in the Agent Registry (CIS-8004, built by the hosted registry MCP)
 *   issue     the Kuasa mandate for that agent: budget, expiry, who may record its spending
 *   revoke    withdraw the mandate: shops and insurers refuse the agent from the next block
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import type { ConcordiumGRPCClient } from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { encodeIssue, encodeRevoke } from '@kuasa/core';
import { loadProfile } from './identity.js';

const AGENT_REGISTRY = { index: 12802n, subindex: 0n };
const state = () => JSON.parse(readFileSync(new URL('../../.kuasa/state.json', import.meta.url), 'utf8')) as { registry: string; mandates: Record<string, { payer: string }> };
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function sponsor() {
  const a = loadProfile('insurer').accounts.find((x) => x.credNumber === 1)!;
  return { address: sdk.AccountAddress.fromBase58(a.address), signer: sdk.buildBasicAccountSigner(a.key) };
}

async function mcp<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch('https://agent-registry-mcp.concordium.com/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...args, network: 'testnet' } } }),
  });
  const raw = await r.text();
  const res = JSON.parse(raw.slice(raw.indexOf('{'))).result;
  if (res.isError) throw new Error(`registry MCP ${name}: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text) as T;
}

/** 8-byte little-endian hex of a CIS-8004 token id (the form mandates and proof bindings use). */
export const tokenHex = (id: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(id); return b.toString('hex'); };

/** The owner's agents in the Agent Registry, newest last. */
export async function agentsOf(owner: string) {
  const r = await mcp<{ agents?: { token_id: number; status?: string }[] }>('agents_by_owner', { owner_account: owner });
  return (r.agents ?? []).map((a) => ({ tokenId: String(a.token_id), tokenHex: tokenHex(BigInt(a.token_id)), status: a.status ?? null }));
}

async function sponsored(grpc: ConcordiumGRPCClient, tx: Transaction.Builder, owner: string) {
  const sender = sdk.AccountAddress.fromBase58(owner);
  const { nonce } = await grpc.getNextAccountNonce(sender);
  const sp = sponsor();
  const signable = tx.addMetadata({ sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }).addSponsor(sp.address).build();
  const signed = await Transaction.sponsor(signable as Parameters<typeof Transaction.sponsor>[0], sp.signer);
  return JSON.parse(JSON.stringify(Transaction.toJSON(signed as never), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export async function prepareOwnerTx(grpc: ConcordiumGRPCClient, owner: string, action: string, args: { agentToken?: string; mandateId?: string }) {
  sdk.AccountAddress.fromBase58(owner); // an account address or it throws
  if (action === 'register') {
    const b = await mcp<{ contract_address: { index: number; subindex?: number }; receive_name: string; parameter_hex: string; suggested_energy?: number }>('build_register', { sender: owner });
    // only ever the Agent Registry's register entrypoint, whatever the MCP returns
    if (BigInt(b.contract_address.index) !== AGENT_REGISTRY.index || !/\.register$/.test(b.receive_name)) throw new Error('unexpected registry transaction');
    const tx = Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: sdk.ContractAddress.create(AGENT_REGISTRY.index, AGENT_REGISTRY.subindex), receiveName: sdk.ReceiveName.fromString(b.receive_name), message: sdk.Parameter.fromHexString(b.parameter_hex) }, sdk.Energy.create(b.suggested_energy ?? 30_000)) as Transaction.Builder;
    return { transaction: await sponsored(grpc, tx, owner), what: 'Register your agent in the Agent Registry' };
  }
  const registry = sdk.ContractAddress.create(BigInt(state().registry), 0n);
  if (action === 'issue') {
    if (!/^[0-9a-f]{16}$/.test(args.agentToken ?? '')) throw new Error('agentToken: 16 hex characters');
    const mine = await agentsOf(owner);
    if (!mine.some((a) => a.tokenHex === args.agentToken)) throw new Error('that agent is not yours in the Agent Registry');
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    const shopPayTo = loadProfile('merchant').accounts.find((a) => a.credNumber === 0)!.address;
    const insurer = loadProfile('insurer').accounts.find((a) => a.credNumber === 0)!.address;
    const param = encodeIssue({
      id, payer: owner, agentRegistry: AGENT_REGISTRY, agentToken: args.agentToken!, uri: 'https://kuasa-explorer.vercel.app/owner.html',
      maxTotal: 50_000_000n, validUntilMs: BigInt(Date.now() + 30 * 86_400_000), recorders: [shopPayTo, insurer],
    });
    const tx = Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: registry, receiveName: sdk.ReceiveName.fromString('kuasa.issue'), message: sdk.Parameter.fromBuffer(ab(param)) }, sdk.Energy.create(30_000)) as Transaction.Builder;
    return { transaction: await sponsored(grpc, tx, owner), mandateId: id, what: 'Give your agent a mandate: 50 EUDemo over 30 days' };
  }
  if (action === 'revoke') {
    if (!/^[0-9a-f]{64}$/.test(args.mandateId ?? '')) throw new Error('mandateId: 64 hex characters');
    const reason = Buffer.from(sdk.sha256([Buffer.from('revoked by its owner from the Concordium Wallet')])).toString('hex');
    const tx = Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: registry, receiveName: sdk.ReceiveName.fromString('kuasa.revoke'), message: sdk.Parameter.fromBuffer(ab(encodeRevoke(args.mandateId!, reason))) }, sdk.Energy.create(30_000)) as Transaction.Builder;
    return { transaction: await sponsored(grpc, tx, owner), what: 'Revoke the mandate' };
  }
  throw new Error('action: register, issue or revoke');
}
