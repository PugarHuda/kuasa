/**
 * Verified-by-Concordium badges for the demo agents and the shop.
 *
 *   tsx badges.ts build   writes docs/agents/<name>.json (A2A Agent Card + Kuasa extension + the
 *                         Concordium badge injected by the hosted Agent Registry MCP), served by
 *                         GitHub Pages at https://pugarhuda.github.io/kuasa/agents/<name>.json
 *   tsx badges.ts pin     checks the served bytes, pins agent_uri + sha256 on CIS-8004
 *                         (setAgentURI, signed by the token owner) and runs check_badge
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { AGENT_REGISTRY, bigintJson, connect, submit, wallet } from '@kuasa/chain';
import { sha256Hex } from '@kuasa/core';
import { loadProfile } from './lib/identity.js';
import { mcp } from './lib/registry-mcp.js';

const PAGES = process.env.KUASA_PAGES_URL ?? 'https://pugarhuda.github.io/kuasa';
const OUT = new URL('../docs/agents/', import.meta.url);
const state = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { registry: string; cover: string; agents: Record<string, string>; shopAgent: string };
const tokenDec = (hex: string) => Buffer.from(hex, 'hex').readBigUInt64LE().toString();

const cast = [
  { name: 'alice', profile: 'alice', token: state.agents.alice, title: "Alice's shopping agent", role: 'buyer',
    description: 'Buys groceries and wine for its owner under a Kuasa mandate (budget, categories, merchants) with a ZK proof that the owner is 18+ and an EU resident. Insured with Kuasa Cover.' },
  { name: 'teen', profile: 'teen', token: state.agents.teen, title: "Teen's shopping agent", role: 'buyer',
    description: 'A 16-year-old owner’s agent: may buy groceries, is refused age-restricted goods because no 18+ proof exists. Demo of Kuasa refusing before payment.' },
  { name: 'shop', profile: 'merchant', token: state.shopAgent, title: 'Kuasa demo shop', role: 'merchant',
    description: 'Regulated-goods shop for AI agents: checks mandates, ZK proofs, CIS-8004 status and Kuasa Cover before accepting x402 payments in EUDemo.' },
];

const uriOf = (name: string) => `${PAGES}/agents/${name}.json`;

async function build() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL('../docs/.nojekyll', import.meta.url), '');
  for (const a of cast) {
    const owner = loadProfile(a.profile).accounts.find((x) => x.credNumber === 0)!.address;
    const card = {
      name: a.title, description: a.description, url: uriOf(a.name), version: '1.0.0',
      provider: { organization: 'Kuasa', url: 'https://github.com/PugarHuda/kuasa' },
      defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
      capabilities: {
        extensions: [{
          uri: 'https://github.com/PugarHuda/kuasa/blob/main/docs/agents/kuasa-extension-v1.md',
          description: 'Kuasa: mandated, insured agent commerce on Concordium',
          params: { role: a.role, mandateRegistry: `<${state.registry},0>`, cover: `<${state.cover},0>`, asset: 'EUDemo', network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27' },
        }],
      },
      skills: a.role === 'merchant'
        ? [{ id: 'sell-regulated-goods', name: 'Sell regulated goods', description: 'x402 checkout gated by Kuasa mandates, ZK proofs and Kuasa Cover', tags: ['x402', 'kuasa'] }]
        : [{ id: 'insured-shopping', name: 'Insured shopping', description: 'Shops within its Kuasa mandate and insures itself with Kuasa Cover', tags: ['x402', 'kuasa', 'insurance'] }],
    };
    const res = await mcp<Record<string, unknown>>('build_agent_badge', { card_json: JSON.stringify(card), owner_account: owner, token_id: tokenDec(a.token), network: 'testnet' });
    const json = (res.agent_card_json ?? res.card_json) as string | object | undefined;
    if (!json) throw new Error(`unexpected build_agent_badge result: ${JSON.stringify(res).slice(0, 400)}`);
    const body = typeof json === 'string' ? json : JSON.stringify(json);
    writeFileSync(new URL(`${a.name}.json`, OUT), body);
    console.log(a.name, 'card written', await sha256Hex(body), 'mcp sha256', res.sha256 ?? res.card_sha256 ?? '?');
  }
}

async function pin() {
  const grpc = connect();
  for (const a of cast) {
    const uri = uriOf(a.name);
    const local = readFileSync(new URL(`${a.name}.json`, OUT), 'utf8');
    const served = await (await fetch(uri)).text();
    if (served !== local) throw new Error(`${a.name}: served card differs from docs/agents/${a.name}.json (Pages not deployed yet?)`);
    const hash = await sha256Hex(served);
    const t = Buffer.from(a.token, 'hex');
    const u = Buffer.from(uri);
    const u32 = Buffer.alloc(4); u32.writeUInt32LE(u.length);
    // setAgentURI { token_id: ByteList(u8), agent_uri: Option<String>, metadata_hash: Option<[u8; 32]> }
    const param = Uint8Array.from([t.length, ...t, 1, ...u32, ...u, 1, ...Buffer.from(hash, 'hex')]);
    const acc = loadProfile(a.profile).accounts.find((x) => x.credNumber === 0)!;
    const tx = Transaction.updateContract({
      amount: sdk.CcdAmount.zero(), address: AGENT_REGISTRY, receiveName: sdk.ReceiveName.fromString('CIS-8004.setAgentURI'),
      message: sdk.Parameter.fromBuffer(param.slice().buffer as ArrayBuffer),
    }, sdk.Energy.create(30_000)) as Transaction.Builder;
    const r = await submit(grpc, tx, wallet(acc.address, acc.key));
    const s = r.summary.summary as { transactionType?: string };
    if (s.transactionType === 'failed') throw new Error(`${a.name}: setAgentURI rejected ${JSON.stringify(s, bigintJson)}`);
    const { token_address } = await mcp<{ token_address: string }>('token_address', { contract_index: 12802, token_id: tokenDec(a.token) });
    const check = await mcp<{ agents?: { badge_valid: boolean; issues: unknown[] }[]; badge_valid?: boolean; issues?: unknown[] }>('check_badge', { id: token_address, network: 'testnet' });
    const v = check.agents?.[0] ?? check;
    console.log(a.name, 'pinned', r.hash, 'badge', token_address, 'valid', v.badge_valid, JSON.stringify(v.issues ?? []).slice(0, 300));
  }
}

await (process.argv[2] === 'pin' ? pin() : build());
process.exit(0);
