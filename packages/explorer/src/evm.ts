/**
 * Cross-chain check for agents that live on EVM chains: the agent signs a short, timestamped
 * message with its Ethereum key; we recover the key, find the Concordium agent bound to it through
 * the CIS-8 External Key Registry, and return its Verified-by-Concordium badge and Kuasa Cover.
 */
import type { Hex } from 'viem';
import { hashMessage, recoverPublicKey, publicKeyToAddress } from 'viem/utils';
import { decodePolicy, encodeU64 } from '@kuasa/core';
import { COVER_V1, COVERS, coverOf, riskOf, viewCover } from './chain.js';

const MCP = 'https://agent-registry-mcp.concordium.com/mcp';
const WINDOW_MS = 5 * 60_000;
const SKEW_MS = 30_000;
export const AUDIENCE = 'kuasa-explorer.vercel.app';
/** The relying party picks a fresh random nonce; the agent signs it for this verifier only. */
export const evmChallenge = (nonce: string, ts: number) => `kuasa-evm-agent:v1:${AUDIENCE}:${nonce}:${ts}`;

/** Little-endian u64 token id as the cover contract stores it (hex). */
const tokenHex = (id: string) => { let v = BigInt(id); let h = ''; for (let i = 0; i < 8; i++) { h += (v & 0xffn).toString(16).padStart(2, '0'); v >>= 8n; } return h; };
/** A policy counts for an agent only if it was issued for that agent token and that owner. */
export const coverBindsToAgent = (p: { agentToken: string; holder: string }, a: { token_id: string; owner_account: string }) =>
  p.agentToken === tokenHex(a.token_id) && p.holder === a.owner_account;

/** One retry for transient failures of the hosted registry service, and a short cache of answers. */
export function withRetryAndCache<T>(fn: (key: string) => Promise<T>, ttlMs: number, max = 500) {
  const cache = new Map<string, { at: number; v: T }>();
  return async (key: string): Promise<T> => {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.v;
    if (hit) cache.delete(key);
    const v = await fn(key).catch(() => new Promise((r) => setTimeout(r, 400)).then(() => fn(key)));
    if (v === null || v === undefined) return v; // empty answers are not cached (keys can be attacker-chosen)
    for (const [k, e] of cache) if (now - e.at >= ttlMs) cache.delete(k);
    while (cache.size >= max) cache.delete(cache.keys().next().value as string); // bounded: oldest out
    cache.set(key, { at: now, v });
    return v;
  };
}

const mcpCached = withRetryAndCache((key: string) => { const { name, args } = JSON.parse(key) as { name: string; args: object }; return mcpOnce(name, args); }, 30_000);
const mcp = <T>(name: string, args: object) => mcpCached(JSON.stringify({ name, args })) as Promise<T>;

async function mcpOnce(name: string, args: object): Promise<unknown> {
  const r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await r.text();
  const res = JSON.parse(raw.slice(raw.indexOf('{'))).result;
  if (res?.isError) throw new Error(res.content?.[0]?.text ?? `${name} failed`);
  return JSON.parse(res.content[0].text);
}

export async function verifyEvmAgent(d: { message?: unknown; signature?: unknown; nonce?: unknown }, now = Date.now()) {
  const message = String(d.message ?? '');
  const nonce = String(d.nonce ?? '');
  if (!/^[0-9a-f]{32,64}$/i.test(nonce)) throw new Error('send the random nonce you issued (32-64 hex chars)');
  // strict unix-ms digits only: NaN or Infinity would make every window comparison false (fail open)
  const ts = Number(/:(\d{13})$/.exec(message)?.[1] ?? NaN);
  if (!Number.isSafeInteger(ts)) throw new Error(`sign "kuasa-evm-agent:v1:${AUDIENCE}:<your nonce>:<unix ms>" with the agent's Ethereum key`);
  if (message !== evmChallenge(nonce, ts)) throw new Error(`sign "kuasa-evm-agent:v1:${AUDIENCE}:<your nonce>:<unix ms>" with the agent's Ethereum key`);
  if (now - ts > WINDOW_MS || ts - now > SKEW_MS) throw new Error('challenge outside the 5-minute window');
  const publicKey = await recoverPublicKey({ hash: hashMessage(message), signature: String(d.signature ?? '') as Hex });
  const evmAddress = publicKeyToAddress(publicKey);
  const agent = await mcp<{ token_address: string; token_id: string; owner_account: string; status: string; agent_uri: string } | null>('agent_by_external_reference', {
    network: 'testnet',
    external_reference: { contract_address: { index: 12801, subindex: 0 }, kind: 'Cis8', key: { namespace: 'eip155:1', key_type: 'secp256k1-uncompressed', public_key_hex: publicKey.slice(2) } },
  });
  if (!agent) return { nonce, evmAddress, concordiumAgent: null, insured: false, note: 'this Ethereum key is not bound to a Concordium agent (CIS-8)' };
  const [badge, coverMeta] = await Promise.all([
    mcp<{ agents?: { badge_valid: boolean }[]; badge_valid?: boolean }>('check_badge', { id: agent.token_address, network: 'testnet' }),
    mcp<{ value_text?: string } | null>('get_metadata', { network: 'testnet', token_id: agent.token_id, key: 'kuasa:cover' }).catch(() => null),
  ]);
  // The published status only points at a policy; it counts only if that policy is this agent's.
  const policyId = coverMeta?.value_text?.match(/^policy=(\d+);/)?.[1];
  const coverIdx = BigInt(coverMeta?.value_text?.match(/;cover=(d+)./)?.[1] ?? COVER_V1); // statuses before v2 named no contract
  const found = policyId && COVERS.includes(coverIdx) ? decodePolicy(await viewCover('policy', encodeU64(BigInt(policyId)), coverIdx)) : null;
  const policy = found && coverBindsToAgent(found, agent) ? found : null;
  const cover = policy ? await coverOf(policy.agentPayer, coverIdx) : null;
  return {
    nonce, evmAddress,
    concordiumAgent: { tokenAddress: agent.token_address, owner: agent.owner_account, status: agent.status, agentCard: agent.agent_uri },
    badgeValid: badge.agents?.[0]?.badge_valid ?? badge.badge_valid ?? false,
    insured: !!cover && cover.policyId !== null && cover.periodRemaining > 0n,
    cover, risk: policy ? await riskOf(policy.agentPayer) : null, published: coverMeta?.value_text ?? null,
  };
}
