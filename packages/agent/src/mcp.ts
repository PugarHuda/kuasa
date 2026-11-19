#!/usr/bin/env -S node --import tsx
/**
 * Kuasa MCP server: lets any MCP client (Claude, etc.) shop as a mandated agent.
 *   KUASA_AGENT=alice node --import tsx packages/agent/src/mcp.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KuasaAgent } from './client.js';

const agent = KuasaAgent.fromDemo(process.env.KUASA_AGENT ?? 'alice');
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: 'kuasa', version: '0.1.0' });
server.tool('kuasa_mandate', 'Show the mandate this agent shops under: budget, categories, merchants, expiry.', async () => text(await agent.mandate()));
server.tool('kuasa_catalog', 'List products at the shop with prices and legal requirements.', async () => text(await agent.catalog()));
server.tool('kuasa_quote', 'Check, without paying, whether this agent may buy a product and why not.', { path: z.string() }, async ({ path }) => text(await agent.quote(path)));
server.tool('kuasa_buy', 'Buy a product (pays over x402 in the mandate asset, e.g. EUDemo; the shop sponsors the fee). Refused if outside the mandate.', { path: z.string() }, async ({ path }) => text(await agent.buy(path)));

await server.connect(new StdioServerTransport());
