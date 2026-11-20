# Kuasa Cover

**Insurance for AI agent commerce, on Concordium.**

**[Demo video (3 min)](https://youtu.be/Tqe_CLniIl0)** · **[Live explorer](https://kuasa-explorer.vercel.app)** · [Public A2A endpoint](docs/INTEGRATIONS.md#a2a-talking-to-the-insurer) · [Slides](https://kuasa-explorer.vercel.app/slides/) · [Every testnet transaction](docs/TESTNET.md) · [Integrations (MCP, A2A, OpenAI Agents SDK)](docs/INTEGRATIONS.md)

AI agents can pay on their own now. When one makes a mistake, nobody carries the loss: an agent buys the same thing twice, gets something wrong or counterfeit, or harms a merchant. So owners hesitate to let agents spend, and merchants hesitate to sell to them. Conventional insurers are moving to explicit AI exclusions.

Kuasa Cover makes agent commerce insurable:

- **The owner verifies once** with Concordium ID and gives the agent a *kuasa* (mandate): budget, per-order limit, categories, merchants, expiry, plus a zero-knowledge proof (18+, EU resident) bound to that one agent.
- **The agent insures itself over x402.** The premium is priced from on-chain facts (how tight the mandate is, what the owner proved, the agent's receipt and incident history). It is paid in EUDemo, an allow-listed euro stablecoin, and recorded as spending under the mandate.
- **Merchants check before taking payment:** the mandate, the owner's proof, the agent's CIS-8004 registry entry, and that the order is insured. The agent's "insured" status is published in the Agent Registry.
- **A real AI agent does it.** In the demo, Claude acts as the agent through the Kuasa MCP tools only. It is refused for lacking cover, buys cover itself and retries. Later it reviews its own payments, finds a double charge and files the claim.
- **Claims are paid from on-chain evidence, with tiered autonomy.** The agent files a claim (fee sponsored by the insurer) and the assessor matches the receipts on-chain. **Small claims (≤ 10 EUDemo) are paid automatically** after an objection window, unless a human holds them. Larger claims wait for **a human claims handler**. Payouts go out in EUDemo and are recorded on the cover contract.
- **Solvency anyone can check.** `GET /solvency` recomputes the pool against the cover still owed by live policies, from the contract. Premiums use **experience rating**: each paid claim raises the agent's next premium. The pricing is checked by a Monte Carlo simulation ([docs/PRICING.md](docs/PRICING.md)).
- **Plugs into existing agent stacks.** Claude Code (used in the demo) and the OpenAI Agents SDK ([`examples/openai-agents`](examples/openai-agents/index.ts)) use the Kuasa MCP server as is. The insurer speaks A2A. Owners publish `claims` and `risk` next to `kuasa:cover` in CIS-8004, as reputation any merchant can check against the contract.
- **Readable from other chains.** Alice's agent has an Ethereum key, bound to its CIS-8004 entry through the CIS-8 External Key Registry. An EVM merchant or agent verifies a fresh ETH signature at the public A2A endpoint and gets back the Concordium badge and the Kuasa Cover status.
- **Three independent records per claim.** Each claim has the on-chain receipts, the insurer's published decision (automatic or human), and the merchant's attestation that the orders are real. The fraud attempts show `orders-unknown`. An AgentKit action provider ([`examples/agentkit`](examples/agentkit/kuasa.ts)) lets EVM agents prove or check Kuasa Cover with their own wallet.
- **Both sides of the market.** A merchant harmed by an insured agent claims on the agent's cover (`MerchantLoss`, only mandate recorders may file). Cancelled policies get the unused premium back pro rata, unless a claim was paid. Shop attestations are published automatically for every new claim.
- **AP2 interop.** An agent working under a user's Google AP2 Intent Mandate sends it with its quote. The insurer prices only if the Kuasa mandate sits inside it (merchants and expiry), and refuses otherwise.
- **Appeals and safer autonomy.** Re-filing the orders of a rejected claim is recognised as an appeal (`appeal_claim` MCP tool), and appeals are always decided by a human. Wrong-item claims are never paid automatically, because a receipt cannot prove the item was wrong. Owners can sign their actions in their own wallet; the console only prepares them.
- **Fraud has consequences, privacy has limits.** Claims with no on-chain evidence are rejected without a payout decision. Repeat offenders get a lawful-disclosure request, drafted automatically but anchored only after a human reviews it, for the Concordium identity provider / Privacy Guardians process. Nobody, insurer included, ever holds the person's identity data.

Escrow protects you from bad sellers (Concordium's Protocol-Enforced Escrow covers non-delivery). **Kuasa Cover protects you from your agent, and merchants from agents.**

## Concordium components

| Component | Used for |
|---|---|
| Concordium ID + Verify & Access (V1) | Owner proves 18+ and EU residency once, bound to the agent's payer account; shops and the insurer re-verify from chain data (underwriting input) |
| Web3 ID proof (V0) | EU-nationality proof to join the EUDemo allow list |
| Protocol-Level Token **EUDemo** (allow-listed) | Prices, premiums and payouts; only identity-verified EU accounts can hold it (compliance enforced by the token) |
| x402 (`@x402/concordium`) | Shop purchases and premium payments; in-process facilitators |
| Sponsored transactions | Shop and insurer pay the agent's fees, including claim filing |
| Agent Registry CIS-8004 + Verified by Concordium badge | Agents and the shop are registered with **valid badges** (Agent Cards on GitHub Pages, hash pinned, confirmed by Concordium's hosted `check_badge`); guards check active + owner; owners publish `kuasa:cover` status in agent metadata; agents verify the shop before paying (two-way trust) |
| Smart contracts (Rust) | `kuasa-registry` (mandates, budgets, receipts, incidents) and `kuasa-cover` (policies, claims, payouts, `claimsAuthorized`; checks mandates cross-contract) |
| `registerData` | Anchored audit batches of every guard and claim decision (EU AI Act Art. 12 record keeping) |
| Privacy Guardians (process) | Lawful disclosure route for repeated fraudulent claims |
| A2A + Agent Card | The insurer is itself a badged agent (CIS-8004, Verified by Concordium). Other agents call its skills (solvency, risk, cover-status, quote) over A2A `message/send`. See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| MCP | Claude (or any MCP client) can shop, insure itself, list its own payments (`kuasa_my_payments`, signed request) and file claims. The demo runs Claude Code headless with only this server |

## Where it is on testnet

**Live explorer: [kuasa-explorer.vercel.app](https://kuasa-explorer.vercel.app).** It is a read-only page that reads policies, claims, the pool and proof of solvency straight from testnet in your browser over gRPC-web (no backend, no keys). Source: `packages/explorer`, built into `docs/explorer`.

See **[docs/TESTNET.md](docs/TESTNET.md)**: contracts, accounts and every step of the flow with CCDExplorer links. In short: `kuasa-registry <13065,0>`, `kuasa-cover <13066,0>`, CIS-8004 `<12802,0>`.

## Packages

| Path | What |
|---|---|
| `contracts/kuasa-registry` | Mandates keyed by (owner, id), budget drawn down by receipts, revocation, incidents |
| `contracts/kuasa-cover` | Policies (period or per-order), claims with human decision, payouts never above the limit, fraud marks; reads the mandate registry |
| `packages/core` | Mandate schema, ZK claims, authorization policy, contract codecs (wire format pinned by vectors shared with the Rust tests) |
| `packages/cover` | Risk engine (transparent premium factors) and claim assessor (rules over on-chain receipts) |
| `packages/merchant` | `KuasaGuard`: x402 hooks that refuse before money moves; swappable foundations (`IdentitySource`, `SpendControl`, `AgentRegistry`, `CoverCheck`) |
| `packages/chain` | gRPC client, sponsored submit, contract clients, CIS-8004 metadata, audit log |
| `packages/shop` | Demo regulated-goods shop (wine requires cover), Agent Card, receipts |
| `packages/insurer` | Insurer service: quotes, x402 premiums, policy issuance, sponsored claim filing, assessment, payouts, disclosure review |
| `packages/agent` | Buyer agent: client, CLI and MCP server |
| `packages/console` | Owner and claims-handler console |
| `scripts` | Headless testnet identities, allow-listing, deployment, demos |

## Run it

```sh
pnpm install
pnpm --filter @kuasa/scripts exec tsx provision.ts     # alice (adult, DK), teen (16, DK), merchant, insurer
pnpm --filter @kuasa/scripts exec tsx allowlist.ts     # EU-nationality proof -> EUDemo allow list + test EUDemo
pnpm --filter @kuasa/scripts exec tsx setup.ts         # deploy both contracts, register agents + shop, prove, issue mandates
pnpm --filter @kuasa/shop start                        # http://localhost:4021
pnpm --filter @kuasa/insurer start                     # http://localhost:4023
pnpm --filter @kuasa/console start                     # http://localhost:4022
```

The demo, as the agent (Git Bash on Windows: prefix with `MSYS_NO_PATHCONV=1`; amounts in EUDemo):

```sh
cd packages/agent
node --import tsx src/cli.ts alice buy /shop/wine/rioja           # refused: cover required
node --import tsx src/cli.ts alice cover-quote 100 30             # premium with per-factor reasons
node --import tsx src/cli.ts alice cover-buy 100 30               # pays the premium over x402 -> policy on-chain
node --import tsx src/cli.ts alice buy-twice /shop/wine/rioja     # the agent's mistake: same order twice
node --import tsx src/cli.ts alice claim AgentMistake 24 <paymentTx1> <paymentTx2>
#   -> approve the claim in the console: payout in EUDemo, recorded on the cover contract
node --import tsx src/cli.ts alice buy-covered /shop/wine/rioja   # per-order cover, then the purchase
node --import tsx src/cli.ts teen buy /shop/wine/rioja            # refused: age >= 18 not proven
pnpm --filter @kuasa/scripts exec tsx fraud-demo.ts teen          # run twice: no-evidence claims -> disclosure draft
```

Claude can do the same through MCP: `KUASA_AGENT=alice node --import tsx packages/agent/src/mcp.ts` (tools `kuasa_*`, `cover_quote`, `cover_buy`, `cover_status`, `file_claim`).

Demo runner (the submission video): the AI steps need the `claude` CLI logged in. Reset with `tsx scripts/demo-reset.ts` + `tsx scripts/setup.ts --reissue alice`, start shop, insurer and console, open http://localhost:4022/demo and press Run on each step; every step runs for real on testnet.

Badges: `pnpm --filter @kuasa/scripts exec tsx badges.ts build`, publish `docs/` (GitHub Pages), then `badges.ts pin`.

Tests: `pnpm test && pnpm typecheck`, and `cargo concordium test` in each contract folder (build the registry module first; the cover tests deploy both).

## Path to production

See **[docs/PRODUCTION.md](docs/PRODUCTION.md)**. Kuasa Cover is built so the pieces Concordium is shipping slot in:
- the pool moves into a **Protocol-Level Lock (Enhanced)**, released by `claimsAuthorized`;
- **Agent IDP** credentials replace our mandate proof as an underwriting input;
- KYCaaS, AML on demand and liveness become pricing factors;
- EURQ replaces EUDemo.

## Honesty notes

- **Testnet identities** were created headlessly on the self-service testnet identity provider with invented attributes. "Adult EU resident" proves the mechanism, not a real person.
- **The pool is an account, not a lock.** Contracts cannot hold PLTs yet, so the treasury account holds EUDemo and the cover contract keeps the books and the authorisation (`claimsAuthorized`). Protocol-Level Locks are not live.
- **Pricing is illustrative.** The risk engine is transparent rules, not actuarial data. Kuasa is not a licensed insurer; production needs a fronting carrier or MGA.
- **Disclosure is simulated.** The request document is real and anchored on the claim; the court / Privacy Guardians process is described, not executed.
- **Demo keys.** The console holds the owners' testnet keys so it can revoke and publish cover status; in production the owner signs with their wallet. The shop, insurer and console bind to 127.0.0.1 (`HOST` overrides).
- **Build window.** Kuasa's mandate core (registry contract, policy, guard) was started on 17 November 2026, before the build window opened on 19 November; Kuasa Cover was designed and built from 19 November. The git history shows both.
- **Use of AI.** Built with an AI coding agent (Claude) under a human lead who set direction and approved each milestone; commits carry a `Co-Authored-By` trailer.
