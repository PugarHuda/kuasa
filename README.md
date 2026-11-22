# Kuasa Cover

**Insurance for AI agent commerce, on Concordium.**

**[Demo video (3 min)](https://youtu.be/gLmIZl-64h0)** · **[Live explorer](https://kuasa-explorer.vercel.app)** · [Public A2A endpoint](docs/INTEGRATIONS.md#a2a-talking-to-the-insurer) · [Slides](https://kuasa-explorer.vercel.app/slides/) · [Every testnet transaction](docs/TESTNET.md) · [Integrations (MCP, A2A, OpenAI Agents SDK)](docs/INTEGRATIONS.md)

### Five-minute tour for judges

1. **Watch** the [3-minute demo](https://youtu.be/gLmIZl-64h0): a real Claude agent is refused for lacking cover, insures itself over x402, and later claims its own double charge.
2. **Open the [live explorer](https://kuasa-explorer.vercel.app)**: every policy and claim is read from the contract in your browser, with proof of solvency, the loss ratio, who decided each claim (automatic, human or the appeals panel, with its reason code) and the merchant's attestation. Pick a claim to see its timeline (filed, shop attests, decided, paid) and its evidence document, which re-hashes to the on-chain value; try the premium calculator: the insurer's own pricing function, running in your browser.
3. **Follow one claim end to end on-chain**: the agent paid twice ([tx](https://ccdexplorer.io/testnet/transaction/3acdc3806a573d1003b2285bc6171754b2a1b03368be467d458d7d72ce860254), [tx](https://ccdexplorer.io/testnet/transaction/9a6f9c0d1caf726a5a832eefcd309d46e810eb74ff1417dccdd1b9748833bd94)). The insurer spotted it on-chain and paused the agent at the shop, the agent filed it with one call ([claim](https://ccdexplorer.io/testnet/transaction/907299f6570a6414da2dc674a5396028960a9ab3dd6f5e2982bf5b780305bc4c)), and the *contract* approved the automatic payout under its published rules ([autoApprove](https://ccdexplorer.io/testnet/transaction/480e3dc01919ef3aed594ba116e183b9fd843a0298f913e56b377d4ebe2ec2ed), [payout](https://ccdexplorer.io/testnet/transaction/d1133c1887e26d2bd4fe149dbf627df566566ba4a3ab445e2c77a1567b063ae0)).
4. **See claims backed by evidence, not trust**: a wrong item proven by the merchant's signed delivery note ([claim](https://ccdexplorer.io/testnet/transaction/8bd13be3435894fc1b276524eda76d710ab6cd8820349553497bfcbda3d1d370)), and a prompt-injected purchase outside the owner's signed AP2 intent ([claim](https://ccdexplorer.io/testnet/transaction/ff7ed1fd5edc512e30d1b8c05d27d901def4133d0c1fc2f38550e51e99eb9d2f)). All of it is in [docs/TESTNET.md](docs/TESTNET.md).
5. **Read the code where it matters**: the cover contract's on-chain automation rules (`contracts/kuasa-cover/src/lib.rs`, `autoApprove` / `objectClaim`), the claim rules (`packages/cover/src/assess.ts`, one rule per reason code) and the merchant guard that refuses before money moves (`packages/merchant/src/guard.ts`).

AI agents can pay on their own now. When one makes a mistake, nobody carries the loss: an agent buys the same thing twice, gets something wrong or counterfeit, or harms a merchant. So owners hesitate to let agents spend, and merchants hesitate to sell to them. Conventional insurers are moving to explicit AI exclusions.

Kuasa Cover makes agent commerce insurable:

- **The owner verifies once** with Concordium ID and gives the agent a *kuasa* (mandate): budget, per-order limit, categories, merchants, expiry, plus a zero-knowledge proof (18+, EU resident) bound to that one agent.
- **The agent insures itself over x402.** The premium is priced from on-chain facts (how tight the mandate is, what the owner proved, the agent's receipt and incident history). It is paid in EUDemo, an allow-listed euro stablecoin, and recorded as spending under the mandate.
- **Merchants check before taking payment:** the mandate, the owner's proof, the agent's CIS-8004 registry entry, and that the order is insured. The agent's "insured" status is published in the Agent Registry.
- **A real AI agent does it.** In the demo, Claude acts as the agent through the Kuasa MCP tools only. It is refused for lacking cover, buys cover itself and retries. Later it reviews its own payments, finds a double charge and files the claim.
- **Claims are paid from on-chain evidence, with tiered autonomy.** The agent files a claim (fee sponsored by the insurer) and the assessor matches the receipts on-chain. **Small claims (≤ 10 EUDemo) are paid automatically** after an objection window, unless a human holds them. Larger claims wait for **a human claims handler**. Payouts go out in EUDemo and are recorded on the cover contract.
- **Solvency anyone can check.** `GET /solvency` recomputes the pool against the cover still owed by live policies, from the contract; the explorer also shows the loss ratio (claims paid / premiums). Premiums use **experience rating** with Bühlmann credibility: paid claims raise the agent's next premium, weighed against how many orders it placed. The pricing is checked by a Monte Carlo simulation ([docs/PRICING.md](docs/PRICING.md)).
- **Plugs into existing agent stacks.** Claude Code (used in the demo) and the OpenAI Agents SDK ([`examples/openai-agents`](examples/openai-agents/index.ts)) use the Kuasa MCP server as is. The insurer speaks A2A. Owners publish `claims` and `risk` next to `kuasa:cover` in CIS-8004, as reputation any merchant can check against the contract.
- **Readable from other chains.** Alice's agent has an Ethereum key, bound to its CIS-8004 entry through the CIS-8 External Key Registry. An EVM merchant or agent verifies a fresh ETH signature at the public A2A endpoint and gets back the Concordium badge and the Kuasa Cover status.
- **Three independent records per claim.** Each claim has the on-chain receipts, the insurer's published decision (automatic or human), and the merchant's attestation that the orders are real. The fraud attempts show `orders-unknown`. An AgentKit action provider ([`examples/agentkit`](examples/agentkit/kuasa.ts)) lets EVM agents prove or check Kuasa Cover with their own wallet.
- **Both sides of the market.** A merchant harmed by an insured agent claims on the agent's cover (`MerchantLoss`, only mandate recorders may file). Cancelled policies get the unused premium back pro rata, unless a claim was paid. Shop attestations are published automatically for every new claim.
- **Optimistic payouts that anyone involved can challenge.** During the objection window any party to a claim can hold an automatic payout with a signed objection. Claude drafts a review (advisory, no tools) for the human who decides.
- **Outside capital.** Capital providers deposit EUDemo into the pool, share premiums and losses pro rata, and cannot withdraw below the cover owed. Paid resources are discoverable via x402 Bazaar (`/discovery/resources`).
- **AP2 interop.** An agent working under a user's Google AP2 Intent Mandate sends it with its quote. The insurer prices only if the Kuasa mandate sits inside it (merchants and expiry), and refuses otherwise.
- **Claims backed by evidence, with chargeback-style reason codes.** `AM10` duplicate order, `AM20` outside the user's intent, `WI10` wrong item shipped, `ML10` merchant loss. The agent's evidence document travels with the filing, and only its sha256 goes on-chain as the claim's `evidence`, so it cannot be swapped later. For a wrong item, the shop signs a delivery note (ordered vs. shipped) with the same account that recorded the order's receipt on-chain, which ties the note to the chain.
- **Cover against prompt injection (`AM20`).** The owner signs an AP2 Intent Mandate ("bread for the week"). Its SKUs become the policy's baseline only when the mandate's principal signed it. A purchase that is inside the Kuasa mandate but outside that intent (the agent was talked into buying wine) is covered. The goods were delivered, so a human decides.
- **Contract v3: the chain does more of the work.** The insurer files the duplicates it detects for the agent (`fileClaimFor`), so a mistake is paid with nobody filing anything. Each policy can carry its own stricter terms and the hash of the owner-signed AP2 intent. Objections lock a CCD bond, and an agent's operator can bond the agent (slashed into the pool on proven fraud) for a cheaper premium.
- **Pricing that learns, like an insurer's.** Experience rating uses Bühlmann credibility (a claim weighs more the fewer orders back it), per-order cover reacts to order velocity and spend surges, and claims carry Stripe-style compelling evidence for the human deciding. The buyer can ask for a human on every claim (`maxAutoPay`).
- **A market the agents find on-chain.** Insurers describe themselves on their own CIS-8004 entries; agents discover them there, split a large limit across insurers' free capacity (syndication), and each insurer pays only what others have not (contribution).
- **Reputation that travels.** Claim outcomes go to the ERC-8004 registry on Ethereum automatically, and other insurers price that reputation, with a two-way identity binding and only market insurers as raters.
- **Slashing without an arbiter.** If an insurer leaves an approved claim unpaid, anyone can slash its market bond to pay the claimant: the registry reads the insurer's own cover contract. Judgement calls go to a Concordium account re-keyed to 2-of-3 juror keys.
- **Owner rules.** An owner can say "pause my agent above X an hour"; the insurer enforces it through the circuit breaker.
- **A market, not a single insurer.** A second insurer, Kuasa Re, runs the same contract module with its own operator, pool and price. The agent compares quotes from every insurer its owner allowed and buys the cheapest; the shop counts cover from all of them, and no loss is paid twice.
- **Never sells cover it cannot pay.** A quote is refused when its limit plus every live limit would exceed the pool (fully collateralised underwriting capacity); capital providers add capacity.
- **Ideas adopted from elsewhere, working:** a Kleros-style appeals panel of independent jurors who stake pool capital and lose part of it when they vote against the verdict, Nexus-style risk-class staking (a shop can stake first loss on its own wrong items), merchant-paid cover, an order-velocity factor in the style of Stripe Radar, Lemonade-style premium giveback, and claim outcomes as ERC-8004 reputation feedback, posted to the official ERC-8004 registries on Ethereum Sepolia (Alice's agent is agentId 11449). See [docs/PRODUCTION.md](docs/PRODUCTION.md#6-adopted-from-elsewhere).
- **Parametric detection and a circuit breaker.** The insurer follows every finalized block. When an insured agent pays twice for the same thing, it records a detection the agent files with one call, and it publishes a purchase hold on its own CIS-8004 entry. Every merchant guard that honours it refuses the agent before money moves, until the owner resumes it. Insurance becomes prevention, not only compensation.
- **Appeals and safer autonomy.** Re-filing the orders of a rejected claim is recognised as an appeal (`appeal_claim` MCP tool), and appeals are always decided by a human. Wrong-item and outside-intent claims are never paid automatically. Owners can sign their actions in their own wallet; the console only prepares them.
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

See **[docs/TESTNET.md](docs/TESTNET.md)**: contracts, accounts and every step of the flow with CCDExplorer links. In short: `kuasa-registry <13065,0>`, `kuasa-cover` v3 `<13105,0>` (v2 `<13100,0>` and v1 `<13066,0>` kept for history), CIS-8004 `<12802,0>`.

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
pnpm --filter @kuasa/scripts exec tsx evidence-demo.ts            # WI10 delivery note, AM20 signed AP2 intent, AM10 detection + circuit breaker
pnpm --filter @kuasa/scripts exec tsx v3-demo.ts                  # v3: terms, operator bond, insurer-filed claim, bonded objection, merchant-paid cover
pnpm --filter @kuasa/scripts exec tsx bond-discount-demo.ts     # operator bond: the same quote with and without a 10 CCD bond (x0.9)
pnpm --filter @kuasa/scripts exec tsx demo-video.ts               # demo mode: market, portable reputation, a parametric claim end to end
pnpm --filter @kuasa/scripts exec tsx syndicate-demo.ts           # a limit no insurer can carry alone, split across the market
pnpm --filter @kuasa/scripts exec tsx rules-demo.ts               # owner rule: pause the agent above 5 EUDemo an hour
pnpm --filter @kuasa/scripts exec tsx unpaid-slash-demo.ts        # staged negligence: an approved claim left unpaid, anyone slashes the bond
pnpm --filter @kuasa/scripts exec tsx panel-multisig.ts           # the market arbiter as a 2-of-3 juror multisig account
pnpm --filter @kuasa/scripts exec tsx giveback-demo.ts            # 7 days of cover, no claim: 10% of the premium back
pnpm --filter @kuasa/scripts exec tsx market-demo.ts              # two insurers quote the same cover; the agent buys the cheapest
pnpm --filter @kuasa/scripts exec tsx velocity-demo.ts            # three quick orders, then the per-order quote carries the velocity factor
node --import tsx src/cli.ts alice claim-reason WI10 3 <paymentTx> # file with a reason code (AM20/WI10 attach the shop's signed delivery note)
node --import tsx src/cli.ts alice detections                     # what the insurer spotted on-chain, and whether purchases are paused
```

Claude can do the same through MCP: `KUASA_AGENT=alice node --import tsx packages/agent/src/mcp.ts` (tools `kuasa_*`, `cover_quote`, `cover_buy`, `cover_status`, `file_claim` with a reason code, `cover_detected`, `appeal_claim`).

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
- **Parametric filing needs v3.** On v2 the agent files a detected duplicate with one call; on v3 the insurer files it itself (`fileClaimFor`). Claims filed that way can never be used to slash the agent's bond.
- **A capital bookkeeping bug, found and fixed.** The capital ledger used running totals tied to the insurer's state file, so after a demo reset some payouts were never charged to the providers, and the ledger drifted 8.67 EUDemo above the pool. Each pool event is now booked once by its transaction hash. The drift was trued up once against the pool, on the record, and charged to the insurer's own capital, not to outside providers. The ledger now equals the pool.
- **AP2 signature format.** AP2 leaves the user's authorisation format open; Kuasa's form is a Concordium account signature by the mandate's principal over the intent. The mis-pick is staged through a loopback-only demo endpoint on the shop.
- **Disclosure is simulated.** The request document is real and anchored on the claim; the court / Privacy Guardians process is described, not executed.
- **Demo keys.** The console holds the owners' testnet keys so it can revoke and publish cover status; in production the owner signs with their wallet. The shop, insurer and console bind to 127.0.0.1 (`HOST` overrides).
- **Build window.** Kuasa's mandate core (registry contract, policy, guard) was started on 17 November 2026, before the build window opened on 19 November; Kuasa Cover was designed and built from 19 November. The git history shows both.
- **Use of AI.** Built with an AI coding agent (Claude) under a human lead who set direction and approved each milestone; commits carry a `Co-Authored-By` trailer.
