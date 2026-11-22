/**
 * The Kuasa MCP server for one agent, transport-free: stdio below (mcp.ts), HTTP on the hosted demo
 * (scripts/render.ts). `spend` is asked before every call that can move money; a message refuses it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { KuasaAgent } from './client.js';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) }] });
const eur = (n: number) => BigInt(Math.round(n * 1e6));

export function buildServer(agent: KuasaAgent, spend: (tool: string) => string | null = () => null) {
  const server = new McpServer({ name: 'kuasa', version: '0.3.0' });
  const guarded = <A,>(tool: string, run: (a: A) => Promise<unknown>) => async (a: A) => { const no = spend(tool); return text(no ? { refused: no } : await run(a)); };

server.tool('kuasa_mandate', 'Show the mandate this agent shops under: budget, categories, merchants, expiry.', async () => text(await agent.mandate()));
server.tool('kuasa_catalog', 'List products at the shop with prices and legal requirements (some require Kuasa Cover).', async () => text(await agent.catalog()));
server.tool('kuasa_quote', 'Check, without paying, whether this agent may buy a product and why not.', { path: z.string() }, async ({ path }) => text(await agent.quote(path)));
server.tool('kuasa_buy', 'Buy a product (pays over x402 in the mandate asset, e.g. EUDemo; the shop sponsors the fee). Refused if outside the mandate or uninsured where cover is required.', { path: z.string() }, guarded('kuasa_buy', async ({ path }: { path: string }) => agent.buy(path)));
server.tool('cover_quote', 'Price Kuasa Cover (insurance) for this agent: limit in EUDemo, days. Shows how each risk factor moves the premium.', { limit: z.number().positive(), days: z.number().int().min(1).max(365).default(30) }, async ({ limit, days }) => text(await agent.coverQuote(eur(limit), days)));
server.tool('cover_buy', 'Buy Kuasa Cover for this agent (premium paid over x402 under the mandate). Returns the policy.', { limit: z.number().positive(), days: z.number().int().min(1).max(365).default(30) }, guarded('cover_buy', async ({ limit, days }: { limit: number; days: number }) => agent.coverBuy(eur(limit), days)));
server.tool('kuasa_my_payments', "List this agent's recent purchases at the shop (item, amount in atomic EUDemo with 6 decimals, payment tx, time). Use it to spot mistakes such as being charged twice.", async () => text(await agent.myPayments()));
server.tool('cover_status', "Show this agent's live cover and policies.", async () => text(await agent.coverStatus()));
server.tool('file_claim', 'File an insurance claim for a mistake this agent made. Reason codes: AM10 duplicate order (AgentMistake, two payments); AM20 bought something outside the user’s intent, e.g. after a prompt injection (AgentMistake, one payment); WI10 the shop shipped the wrong item (WrongItem, one payment). AM20 and WI10 attach the shop’s signed delivery note automatically. Small duplicate-order claims are paid automatically after an objection window; others wait for a human claims handler.',
  { kind: z.enum(['AgentMistake', 'WrongItem']), amount: z.number().positive(), paymentTxs: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(2), reason: z.enum(['AM10', 'AM20', 'WI10']).optional(), note: z.string().max(280).default('') },
  guarded('file_claim', async ({ kind, amount, paymentTxs, reason, note }: { kind: 'AgentMistake' | 'WrongItem'; amount: number; paymentTxs: string[]; reason?: 'AM10' | 'AM20' | 'WI10'; note: string }) => agent.fileClaim(kind, paymentTxs, eur(amount), note, undefined, reason)));
server.tool('cover_detected', 'Check whether the insurer spotted a mistake of yours on-chain (duplicate orders) and whether your purchases are paused because of it. Pass file=true to file every open detection as a claim.',
  { file: z.boolean().default(false) }, async ({ file }) => { const no = file ? spend('cover_detected') : null; return text(no ? { refused: no } : file ? await agent.claimDetected() : await agent.detections()); });
server.tool('appeal_claim', 'Appeal a rejected claim: re-file the same payments, ideally with a better explanation. The insurer recognises the re-filed orders as an appeal of the earlier claim; appeals are always decided by a human.',
  { rejectedClaimId: z.string().regex(/^\d+$/), kind: z.enum(['AgentMistake', 'WrongItem']), amount: z.number().positive(), paymentTxs: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(2), reason: z.string().max(280) },
  guarded('appeal_claim', async ({ rejectedClaimId, kind, amount, paymentTxs, reason }: { rejectedClaimId: string; kind: 'AgentMistake' | 'WrongItem'; amount: number; paymentTxs: string[]; reason: string }) => agent.fileClaim(kind, paymentTxs, eur(amount), `appeal of #${rejectedClaimId}: ${reason}`)));

// claim in chat: the owner asks once, the agent checks its own payments and files what it finds
server.prompt('claim_my_mistakes', 'Check my recent purchases for mistakes (double charges, wrong items) and file an insurance claim for each one.', () => ({
  messages: [{ role: 'user', content: { type: 'text', text: 'Check my recent purchases with kuasa_my_payments and cover_detected. For every mistake you find (two payments for the same item, an item outside my intent, a wrong item shipped), file a claim with file_claim using the right reason code, then tell me what you filed and when it will be paid. If you find nothing, say so.' } }],
}));
  return server;
}

/** One stateless MCP request over HTTP (Streamable HTTP): a fresh server per request, no sessions. */
export async function serveHttp(agent: KuasaAgent, spend: (tool: string) => string | null, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const server = buildServer(agent, spend);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
