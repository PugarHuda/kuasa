/**
 * Kuasa in an existing agent stack: an OpenAI Agents SDK agent that shops, insures itself and files
 * claims through the Kuasa MCP server. Nothing Kuasa-specific is needed beyond adding the server.
 *
 *   OPENAI_API_KEY=... pnpm start "Buy one bottle of Rioja (/shop/wine/rioja)"
 *
 * Without a key it still connects through the SDK, lists the Kuasa tools and calls two of them, so
 * you can check the wiring. The shop and insurer must be running (see the main README).
 */
import { fileURLToPath } from 'node:url';
import { Agent, MCPServerStdio, run } from '@openai/agents';

const env = Object.fromEntries(Object.entries({ ...process.env, KUASA_AGENT: process.env.KUASA_AGENT ?? 'alice' }).filter((e): e is [string, string] => typeof e[1] === 'string'));
const kuasa = new MCPServerStdio({
  name: 'kuasa',
  command: 'node',
  args: ['--import', 'tsx', 'src/mcp.ts'],
  cwd: fileURLToPath(new URL('../../packages/agent/', import.meta.url)),
  env,
});

await kuasa.connect();
try {
  if (process.env.OPENAI_API_KEY) {
    const agent = new Agent({
      name: "Alice's shopping agent",
      instructions: "You shop for Alice under her Kuasa mandate on Concordium. Use the kuasa tools. Tool outputs show atomic EUDemo (6 decimals); tool inputs take whole EUDemo. Spend carefully and keep any insurance cover as small as the purchase needs.",
      mcpServers: [kuasa],
    });
    const result = await run(agent, process.argv[2] ?? 'What are you allowed to buy, and are you insured?');
    console.log(result.finalOutput);
  } else {
    const tools = await kuasa.listTools();
    console.log(`OpenAI Agents SDK connected to the Kuasa MCP server: ${tools.length} tools`);
    console.log(tools.map((t) => `  - ${t.name}`).join('\n'));
    for (const name of ['kuasa_mandate', 'cover_status']) {
      const out = await kuasa.callTool(name, {});
      console.log(`\n${name} ->`, JSON.stringify(out).slice(0, 400));
    }
    console.log('\nSet OPENAI_API_KEY to let the agent act on its own.');
  }
} finally {
  await kuasa.close();
}
