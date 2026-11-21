/**
 * Kuasa Cover reputation on Ethereum, live: registers Alice's agent in the official ERC-8004 Identity
 * Registry on Ethereum Sepolia (with the agent's own EVM key), then the insurer (a separate EVM key: an
 * agent's owner may not rate its own agent) posts each claim outcome to the ERC-8004 Reputation Registry.
 *
 * - The registration file and every feedback file are published next to the explorer
 *   (docs/explorer/erc8004/...), and feedbackHash = keccak256 of the feedback file, so anyone can check it.
 * - Feedback entries come from the explorer's public A2A skill `erc8004-feedback`, recomputed from the
 *   Concordium cover contracts.
 * - Progress is kept in .kuasa/erc8004.json, so a rerun posts only what is new.
 * Usage: tsx erc8004-post.ts [agent name, default alice] [--register-only]. Redeploy the explorer after it writes files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, parseEther, parseEventLogs, toBytes, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { cis8004GetMetadata, cis8004SetMetadata, connect, wallet as cwallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const RPC = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const SITE = 'https://kuasa-explorer.vercel.app';
const NAME = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'alice';
const demo = JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')) as { agents: Record<string, string>; mandates: Record<string, { payer: string }> };
const ALICE_PAYER = demo.mandates[NAME].payer; // the agent's Concordium payer account
const ALICE_TOKEN = demo.agents[NAME]; // its CIS-8004 token on <12802,0>
const Display = NAME[0].toUpperCase() + NAME.slice(1);

const kuasa = new URL('../.kuasa/', import.meta.url);
const out = new URL('../docs/explorer/erc8004/', import.meta.url);
const abi = (n: string) => { const j = JSON.parse(readFileSync(new URL(`erc8004/${n}.json`, import.meta.url), 'utf8')); return Array.isArray(j) ? j : j.abi; };
const key = (f: string) => JSON.parse(readFileSync(new URL(f, kuasa), 'utf8')).privateKey as Hex;
// each agent has its own EVM key (created once, kept in .kuasa, never in git)
const agentKeyFile = new URL(`eth-${NAME}-agent.json`, kuasa);
if (!existsSync(agentKeyFile)) writeFileSync(agentKeyFile, JSON.stringify({ privateKey: generatePrivateKey() }));
const agentKey = privateKeyToAccount(key(`eth-${NAME}-agent.json`));
const insurerKey = privateKeyToAccount(key('eth-insurer.json'));
const stateFile = new URL('erc8004.json', kuasa);
// one progress file for every agent (and for the insurer's automatic posting): posted entries are keyed by claim
const all = (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { posted: {} }) as { agentId?: string; registerTx?: string; posted: Record<string, { tx: string; uri: string }>; agents?: Record<string, { agentId: string; registerTx: string }> };
const mine = NAME === 'alice' ? (all.agentId ? { agentId: all.agentId, registerTx: all.registerTx! } : undefined) : all.agents?.[NAME];
const state = { agentId: mine?.agentId, registerTx: mine?.registerTx, posted: all.posted };
const save = () => {
  const cur = (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { posted: {} }) as typeof all;
  cur.posted = { ...cur.posted, ...state.posted };
  if (NAME === 'alice') { cur.agentId = state.agentId; cur.registerTx = state.registerTx; }
  else cur.agents = { ...(cur.agents ?? {}), [NAME]: { agentId: state.agentId!, registerTx: state.registerTx! } };
  writeFileSync(stateFile, JSON.stringify(cur, null, 2));
};

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = (account: typeof agentKey) => createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const wait = async (hash: Hex) => { const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(`reverted: ${hash}`); return r; };
mkdirSync(new URL('feedback/', out), { recursive: true });

// 1. gas for the agent key (the insurer key got Sepolia ETH from a faucet)
if (await pub.getBalance({ address: agentKey.address }) < parseEther('0.003')) {
  const tx = await wallet(insurerKey).sendTransaction({ to: agentKey.address, value: parseEther('0.01') });
  await wait(tx);
  console.log('1. funded the agent key with 0.01 Sepolia ETH', tx);
}

// 2. register Alice's agent (once), pointing at a registration file that names its Concordium identity
const regPath = `erc8004/${NAME}-agent.json`;
if (!state.agentId) {
  const tx = await wallet(agentKey).writeContract({ address: IDENTITY, abi: abi('IdentityRegistry'), functionName: 'register', args: [`${SITE}/${regPath}`] });
  const r = await wait(tx);
  const ev = parseEventLogs({ abi: abi('IdentityRegistry'), logs: r.logs, eventName: 'Registered' })[0] as unknown as { args: { agentId: bigint } };
  state.agentId = String(ev.args.agentId); state.registerTx = tx; save();
  console.log(`2. registered ${Display}'s agent: ERC-8004 agentId ${state.agentId}`, tx);
}
writeFileSync(new URL(`${NAME}-agent.json`, out), JSON.stringify({
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: `${Display}'s shopping agent (Kuasa Cover insured)`,
  description: 'An AI shopping agent with a mandate on Concordium testnet, insured by Kuasa Cover. Its claim outcomes are posted here as ERC-8004 feedback by the insurer.',
  endpoints: [
    { name: 'Concordium CIS-8004', endpoint: `ccd:testnet:<12802,0>:${ALICE_TOKEN}` },
    { name: 'Concordium payer account', endpoint: `ccd:testnet:${ALICE_PAYER}` },
    { name: 'Kuasa Cover badge', endpoint: `${SITE}/?badge=${ALICE_PAYER}` },
    { name: 'agentWallet', endpoint: `eip155:11155111:${agentKey.address}` },
  ],
  registrations: [{ agentId: Number(state.agentId), agentRegistry: `eip155:11155111:${IDENTITY}` }],
  supportedTrust: ['reputation'],
}, null, 2));
// link it from the agent's Concordium identity: its owner writes kuasa:erc8004 on the agent's CIS-8004 entry,
// so insurers can read its ERC-8004 reputation (written by the owner: nobody else can claim it)
{
  const link = `eip155:11155111:${IDENTITY}:${state.agentId}`;
  const grpc = connect();
  if ((await cis8004GetMetadata(grpc, ALICE_TOKEN, 'kuasa:erc8004')) !== link) {
    const o = loadProfile(NAME).accounts.find((a) => a.credNumber === 0)!;
    const r = await cis8004SetMetadata(grpc, ALICE_TOKEN, 'kuasa:erc8004', link, cwallet(o.address, o.key));
    console.log('   linked on the CIS-8004 entry: kuasa:erc8004 =', link, r.hash);
  }
}
// ...and the other way round: the ERC-8004 owner names the CIS-8004 entry on Ethereum (a two-way binding)
{
  const back = `ccd:testnet:<12802,0>:${ALICE_TOKEN}`;
  const cur = await pub.readContract({ address: IDENTITY, abi: abi('IdentityRegistry'), functionName: 'getMetadata', args: [BigInt(state.agentId!), 'kuasa:cis8004'] }) as Hex;
  if (Buffer.from(cur.slice(2), 'hex').toString('utf8') !== back) {
    const tx = await wallet(agentKey).writeContract({ address: IDENTITY, abi: abi('IdentityRegistry'), functionName: 'setMetadata', args: [BigInt(state.agentId!), 'kuasa:cis8004', toHex(back)] });
    await wait(tx);
    console.log('   bound on Ethereum: kuasa:cis8004 =', back, tx);
  }
}
if (process.argv.includes('--register-only')) process.exit(0);

// 3. the insurer posts each claim outcome it has not posted yet
const a2a = await (await fetch(`${SITE}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'data', data: { skill: 'erc8004-feedback', payer: ALICE_PAYER } }] } } }) })).json() as { result: { parts: { data: { feedback: { score: number; tag1: string; tag2: string; createdAt: string; evidence: { contract: string; claimId?: string; policyId: string; status: string } }[] } }[] } };
const entries = a2a.result.parts[0].data.feedback;
console.log(`3. ${entries.length} feedback entries from the A2A skill`);
for (const f of entries) {
  const id = `${f.evidence.contract}:${f.evidence.claimId ?? `policy-${f.evidence.policyId}`}`;
  if (state.posted[id]) continue;
  const body = JSON.stringify({ agentRegistry: `eip155:11155111:${IDENTITY}`, agentId: Number(state.agentId), clientAddress: `eip155:11155111:${insurerKey.address}`, createdAt: f.createdAt, value: f.score, tag1: f.tag1, tag2: f.tag2, source: 'Kuasa Cover claim outcome on Concordium testnet', evidence: f.evidence }, null, 2);
  const hash = keccak256(toBytes(body));
  const file = `feedback/${hash.slice(2)}.json`;
  writeFileSync(new URL(file, out), body);
  const uri = `${SITE}/erc8004/${file}`;
  const tx = await wallet(insurerKey).writeContract({ address: REPUTATION, abi: abi('ReputationRegistry'), functionName: 'giveFeedback', args: [BigInt(state.agentId!), BigInt(f.score), 0, f.tag1, f.tag2, `${SITE}/a2a`, uri, hash] });
  await wait(tx);
  state.posted[id] = { tx, uri }; save();
  console.log(`   posted ${id}: ${f.tag2} ${f.score}`, tx);
}
console.log('done; agentId', state.agentId, '; redeploy the explorer to publish docs/explorer/erc8004/');
process.exit(0);
