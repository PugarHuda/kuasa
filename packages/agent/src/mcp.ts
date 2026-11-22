#!/usr/bin/env -S node --import tsx
/**
 * Kuasa MCP server: lets any MCP client (Claude, etc.) shop as a mandated, insured agent.
 *   KUASA_AGENT=alice node --import tsx packages/agent/src/mcp.ts
 * Amounts are in whole EUDemo.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KuasaAgent } from './client.js';
import { buildServer } from './mcp-server.js';

await buildServer(KuasaAgent.fromDemo(process.env.KUASA_AGENT ?? 'alice')).connect(new StdioServerTransport());
