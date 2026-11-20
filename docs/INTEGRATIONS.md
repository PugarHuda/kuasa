# Plug Kuasa into the agent stack you already use

Kuasa reaches agents in two ways:

- **MCP:** the Kuasa MCP server (`packages/agent/src/mcp.ts`). Any MCP client can use it to shop under a mandate, insure itself and file claims.
- **A2A:** the insurer's own endpoint, for agents that talk to other agents.

## MCP server

Nine tools:

| Tool | What it does |
|---|---|
| `kuasa_mandate` | Shows the mandate the agent shops under. |
| `kuasa_catalog` | Lists the shop's products and requirements. |
| `kuasa_quote` | Checks a purchase without paying. |
| `kuasa_buy` | Buys over x402. |
| `kuasa_my_payments` | Lists the agent's own purchases (signed request). |
| `cover_quote` | Prices Kuasa Cover. |
| `cover_buy` | Buys Kuasa Cover. |
| `cover_status` | Shows live cover and policies. |
| `file_claim` | Files a claim. |

The server runs as `node --import tsx src/mcp.ts` from `packages/agent`, with `KUASA_AGENT=alice` (or `teen`) choosing the demo agent.

| Stack | How | Verified here |
|---|---|---|
| **Claude Code** (headless) | `claude -p "<task>" --mcp-config kuasa.json --strict-mcp-config --allowedTools mcp__kuasa`. This is what the demo runner does (`packages/console/src/ai-agent.ts`). | Yes: the agent bought cover itself and filed a claim on testnet (see TESTNET.md) |
| **OpenAI Agents SDK** | `new MCPServerStdio({ command: 'node', args: ['--import','tsx','src/mcp.ts'], cwd: 'packages/agent' })`, passed as `mcpServers` of an `Agent`. Code: [`examples/openai-agents`](../examples/openai-agents/index.ts). | Wiring yes: the SDK lists the 9 tools and calls `kuasa_mandate` / `cover_status` against testnet. Model run: needs `OPENAI_API_KEY` |
| Claude Desktop, Cursor, other MCP clients | Add `{ "mcpServers": { "kuasa": { "command": "node", "args": ["--import", "tsx", "src/mcp.ts"], "cwd": "<repo>/packages/agent", "env": { "KUASA_AGENT": "alice" } } } }` to the client's MCP config. | Same server, not tested per client |

`kuasa.json` for Claude Code:

```json
{ "mcpServers": { "kuasa": { "command": "node", "args": ["--import", "tsx", "src/mcp.ts"], "env": { "KUASA_AGENT": "alice" } } } }
```

Run `claude` from `packages/agent`, so that `tsx` resolves.

## A2A: talking to the insurer

The insurer is a registered agent:

- **CIS-8004 token:** `2205000000000000`.
- **Badge:** `JyP9UXdod6ZP39bFGudSW` (Verified by Concordium, valid).
- **Agent Card:** [`pugarhuda.github.io/kuasa/agents/insurer.json`](https://pugarhuda.github.io/kuasa/agents/insurer.json). The insurer also serves it at `/.well-known/agent-card.json`.

Send JSON-RPC `message/send` to `POST /a2a` with a data part:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": { "role": "user", "messageId": "m1",
    "parts": [{ "kind": "data", "data": { "skill": "risk", "payer": "<agent payer account>" } }] } } }
```

| Skill | Data | Answer |
|---|---|---|
| `solvency` | none | Pool, live exposure, coverage, recomputed from the cover contract |
| `risk` | `payer` | Paid claims and premium multiplier (experience rating) |
| `cover-status` | `payer` | Live cover and policies |
| `quote` | `mandateUrl`, `limit`, `days`, `proof` | A priced quote. `proof` holds the `x-kuasa-payer`, `x-kuasa-payer-ts` and `x-kuasa-payer-sig` fields, signed by the agent payer key (see `makePayerProof`). Pay it over x402 at `/cover/buy`. |

Before an agent deals with the insurer, it can check the insurer's badge through Concordium's hosted Agent Registry MCP (`check_badge`), as Kuasa agents already do for the shop.
