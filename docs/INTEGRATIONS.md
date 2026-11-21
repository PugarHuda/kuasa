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
| **Coinbase AgentKit** (EVM agents) | Three Kuasa actions (`kuasa_prove_insured`, `kuasa_check_counterparty`, `kuasa_insurer_solvency`) in [`examples/agentkit/kuasa.ts`](../examples/agentkit/kuasa.ts), wrapped by `customActionProvider` in `agentkit.ts`. The agent proves its insurance with its own AgentKit wallet. | Actions yes, with a real EVM signer against the public endpoint (`node --import tsx examples/agentkit/index.ts`). AgentKit 0.10.4 itself does not load in this monorepo because of a transitive `@solana/kit` conflict; it is not verified here |
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

**Try it now, no setup:** the read-only skills are public at `https://kuasa-explorer.vercel.app/a2a`. This is a Vercel function with no keys; every answer is recomputed from testnet. It is also the `url` on the insurer's Agent Card. `quote` needs the insurer service itself (payer proof, then x402 checkout), which serves the same endpoint at `POST /a2a`.

```bash
curl -s -X POST https://kuasa-explorer.vercel.app/a2a -H 'content-type: application/json' \n  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","messageId":"m1","parts":[{"kind":"data","data":{"skill":"solvency"}}]}}}'
```

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
| `verify-evm-agent` | `message`, `signature`, `nonce` | **Cross-chain.** The caller issues a random nonce (32-64 hex chars). The agent on an EVM chain signs `kuasa-evm-agent:v1:kuasa-explorer.vercel.app:<nonce>:<unix ms>` with its Ethereum key; the message is bound to this verifier, must be fresh (5-minute window, no future timestamps), and the answer echoes the nonce. Cover counts only if the policy was issued for that agent token and owner. The answer has its EVM address, the Concordium agent bound to that key through the CIS-8 External Key Registry, badge validity, live Kuasa Cover and risk. |
| `quote` | `mandateUrl`, `limit`, `days`, `proof`, optional `ap2` (the user's AP2 Intent Mandate; over HTTP send it base64url in `x-ap2-intent-mandate`) | A priced quote. `proof` holds the `x-kuasa-payer`, `x-kuasa-payer-ts` and `x-kuasa-payer-sig` fields, signed by the agent payer key (see `makePayerProof`). Pay it over x402 at `/cover/buy`. |

Before an agent deals with the insurer, it can check the insurer's badge through Concordium's hosted Agent Registry MCP (`check_badge`), as Kuasa agents already do for the shop.

## Agents on other chains

Alice's agent also has an Ethereum key. The owner bound it to the agent in two steps (`scripts/cross-chain.ts`):

1. **CIS-8 `registerExternalKey`** `<12801,0>`. The proof is an `ethereum-personal-sign` signature by the ETH key itself.
2. **CIS-8004 `setExternalReference`.**

A merchant or agent on Base or Ethereum that only knows the agent's `0x` address asks it to sign a challenge, then calls `verify-evm-agent`. `scripts/evm-agent-check.ts` does exactly that against the public endpoint. The Verified-by-Concordium badge and the insurance status become readable from any EVM stack, without a Concordium wallet.

## Card-network agent protocols (Visa Trusted Agent Protocol, Mastercard Agent Pay)

Card networks are adding their own agent identity: Visa's Trusted Agent Protocol has agents sign their HTTP requests with keys that merchants can look up, and Mastercard Agent Pay registers agents and gives them tokenised credentials scoped to what the user allowed. Kuasa Cover does not depend on the payment rail, so it maps onto these as follows. This is a design mapping; nothing here is integrated with Visa or Mastercard.

| Card-network concept | Kuasa equivalent today | How cover attaches |
|---|---|---|
| A registered, verifiable agent identity | The agent's CIS-8004 entry (Verified by Concordium badge) | The policy names the agent's payer account and CIS-8004 token; a card-network agent id would be one more field on the policy |
| A signed request from the agent to the merchant | The payer proof header (`x-kuasa-payer*`), signed with the agent's account key, which the shop and the insurer verify | A shop that already verifies a card-network agent signature can hand the same verified identity to the insurer instead |
| A credential scoped to what the user allowed | The on-chain mandate (per-order cap, categories, merchants, expiry) and the owner-signed AP2 intent | The insurer prices and pays against that scope; for card payments the scope would come from the agentic token's limits |
| Dispute and chargeback after the fact | Kuasa claims with chargeback-style reason codes (AM10, AM20, WI10, ML10) and signed evidence | Kuasa pays the user within the published rules first; a card chargeback remains the merchant's route against the network |

What it would take: a receipt recorder that reads card authorisations instead of x402 settlements, and the network's agent id stored with the policy. The cover contract, assessor and pool stay as they are.

## Show cover on a shop page

Embed the badge for the agent that is buying (its payer account):

```html
<iframe src="https://kuasa-explorer.vercel.app/?badge=4DRGyL6GkXQXs8CT7KovczM9SbwVgn8KsKAvQtFt4G4puhXKLc" width="360" height="48" style="border:0"></iframe>
```

It reads the cover contract and the insurer's circuit breaker in the visitor's browser and shows "Insured by Kuasa Cover · X of cover left", "agent paused by the insurer" or "Not insured by Kuasa Cover".
