# Kuasa

Scoped, revocable purchasing mandates for AI agents on Concordium.

A person verifies once with Concordium ID and gives their shopping agent a *kuasa* (power of attorney): budget, per-order limit, categories, merchants, expiry, plus a zero-knowledge proof such as "18+, EU resident" bound to that one agent. Merchants check all of it before an x402 payment is accepted. Every purchase leaves an on-chain receipt, and the owner can revoke the mandate at any moment.

## Packages

| Path | What |
|---|---|
| `contracts/kuasa-registry` | Rust contract: mandates keyed by (owner, id), budget, revocation, receipts, incidents |
| `packages/core` | Mandate schema, claims from ZK statements, the `authorize()` policy, contract codec |
| `packages/chain` | gRPC client, sponsored-transaction submit, registry client |
| `packages/merchant` | `KuasaGuard`: x402 hooks that refuse before any funds move, then record receipts |
| `packages/shop` | Demo regulated-goods shop: x402 priced in EUDemo (allow-listed euro PLT), in-process facilitator that sponsors fees |
| `packages/agent` | Buyer agent: client, CLI, MCP server (`kuasa_catalog/quote/buy/mandate`) |
| `packages/console` | Console + incident desk: on-chain mandates, live decisions, revoke, report |
| `scripts` | Testnet provisioning (headless identities) and one-shot setup |

## Testnet deployment

- Kuasa registry: `<13065,0>` (module `7a7c03f0…1031a`)
- Agents registered in the CIS-8004 Agent Registry `<12802,0>`
- Payments in **EUDemo**, an allow-listed euro PLT: only identity-verified EU accounts can hold or move it (set `KUASA_ASSET=CCD` to use CCD)
- Accounts, keys and mandate state live in `.kuasa/` (gitignored, testnet only)

## Run it

```sh
pnpm install
pnpm --filter @kuasa/scripts exec tsx provision.ts   # alice (adult, DK), teen (16, DK), merchant
pnpm --filter @kuasa/scripts exec tsx allowlist.ts   # prove EU nationality, get on the EUDemo allow list + test EUDemo
pnpm --filter @kuasa/scripts exec tsx setup.ts       # deploy, register agents, prove, issue mandates
pnpm --filter @kuasa/shop start                      # http://localhost:4021
pnpm --filter @kuasa/console start                   # http://localhost:4022
```

Shop as an agent (Git Bash: prefix with `MSYS_NO_PATHCONV=1` so `/shop/...` is not turned into a Windows path):

```sh
cd packages/agent
node --import tsx src/cli.ts alice buy /shop/wine/rioja        # allowed: 18+ and EU proven, within budget
node --import tsx src/cli.ts teen  buy /shop/wine/rioja        # refused: age>=18 not proven
node --import tsx src/cli.ts alice buy /shop/wine/case         # refused: over per-order limit
node --import tsx src/cli.ts alice buy /shop/vape/mint         # refused: category not in mandate
node --import tsx src/cli.ts teen  rogue-buy /shop/wine/rioja  # skips the quote, shop still refuses before payment
```

Revoke from the console, then try again: refused with `mandate revoked`. To reset the demo, reissue the mandate: `tsx setup.ts --reissue alice`.

Claude (or any MCP client) can shop through `KUASA_AGENT=alice node --import tsx packages/agent/src/mcp.ts`.
