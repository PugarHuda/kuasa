# Kuasa Cover: path to production

What it takes to go from this testnet build to insured agents buying real goods on mainnet.

## 1. Swap the stand-ins for what Concordium is shipping

Kuasa Cover was built against interfaces, so each testnet stand-in has a named replacement.

| Today (testnet) | Production | Roadmap item | Code seam |
|---|---|---|---|
| Pool in an insurer treasury account; the cover contract keeps the books | Pool in a **Protocol-Level Lock (Enhanced)**, released only when `kuasa_cover.claimsAuthorized(claimId)` returns true | PLL Enhanced, Mar 2027 | `claimsAuthorized` already exists and is tested |
| Owner's Verify & Access proof referenced by the mandate | **Agent IDP** credential presented by the agent | AI Agent IDP, Nov 2026 | `IdentitySource` (`packages/merchant/src/foundations.ts`) |
| Budget in the `kuasa-registry` contract | Agent funds in a **Simple Lock** with recipients, token, expiry and amount | PLL Simple, Jan 2027 | `SpendControl` |
| Premium factors: mandate, proofs, history | Add **KYCaaS**, **AML on demand** and **liveness** results as factors | Feb–Mar 2027 | `RiskInput` in `packages/cover/src/risk.ts` |
| The console can prepare owner actions unsigned (`/api/prepare/publish-cover`, `/api/prepare/revoke`); `scripts/owner-sign.ts` stands in for the owner's wallet (shows the call, checks contract and sender, signs, submits). The demo console still keeps a signing shortcut | A real wallet (Concordium Browser Wallet, ID App or Dfns) signs the prepared transaction; the console holds no owner keys | Live | `prepareTx`, `signAndSend`, `cis8004SetMetadataTx`, `KuasaRegistry.revokeTx` |
| Auto-pay limit 10 EUDemo, 2-minute objection window, set by the insurer | Limit and window per policy, written to the cover contract so the holder can see them | Live | `autoPayLimit` / `autoPayDelayMs` in `InsurerDeps` |
| AP2 IntentMandate mapped to a Kuasa scope (library) | Insurer quotes directly from an AP2 Intent Mandate + Kuasa budget | AP2 adoption | `scopeFromAp2Intent` (`packages/cover/src/ap2.ts`) |
| Objections need only a signature from a party to the claim (rate-limited) | UMA-style bonded objections, plus Kleros-style appeal courts for disputed decisions | Live (unbonded) | `InsurerService.object` |
| Capital ledger kept by the insurer, deposits verified on-chain | Pool and provider shares in a Protocol-Level Lock / vault contract with on-chain accounting | Live (off-chain ledger) | `packages/insurer/src/capital.ts` |
| EUDemo (test euro) | **EURQ** (MiCA, Quantoz) or another regulated euro PLT | Live | one env var (`KUASA_ASSET`) |
| Keys in local files | Owner: Concordium wallet / **WDK** inside the app. Agent and insurer: **Dfns** wallets-as-a-service (MPC) or **Concordium Signer** | WDK v2/v3, Concordium Signer Feb 2027 | `Wallet` signer abstraction in `packages/chain` |
| Agent Cards on GitHub Pages with valid badges | Cards on the operator's own domain (same pinning flow) | Live | `scripts/badges.ts` |

## 2. The insurance side

- **Carrier.** Kuasa acts as the technology layer and MGA. A licensed **fronting insurer** carries the risk and holds the regulatory licence (EU: Solvency II; distribution under the IDD). Kuasa provides underwriting data, policy administration, claims evidence and payouts.
- **Pricing.** Today's rules are transparent but illustrative. In production they are calibrated on loss data. The inputs stay the same and verifiable: mandate tightness, proven attributes, on-chain receipts and incidents, owner type (LEI businesses).
- **Claims.** The assessor only recommends; a human claims handler decides (EU AI Act and insurance conduct rules). Every decision is anchored (`registerData`), which gives Art. 12 record keeping without putting personal data on-chain.
- **Evidence.** Each claim carries a reason code modelled on card chargebacks (AM10 duplicate, AM20 outside the user's intent, WI10 wrong item, ML10 merchant loss) and an evidence document whose hash is the claim's on-chain `evidence`. Wrong items are proven by the merchant's delivery note, signed by the account that recorded the receipt; outside-intent purchases by an AP2 intent the owner signed. In production the delivery note comes from the merchant's fulfilment system (pick/pack scan), signed by the same recorder key.
- **Prevention.** The insurer follows every finalized block, detects duplicate orders on insured agents and publishes a purchase hold that every `KuasaGuard` honours until the owner resumes the agent. In production the hold rules widen to spend velocity and anomaly scores.
- **Fraud.** Claims need on-chain receipts, so the most common fraud (claiming orders that never happened) is rejected automatically. Repeat offenders go to the lawful identity-disclosure process via the identity provider and **Privacy Guardians**. The insurer never stores identity documents.
- **Scope.** Kuasa covers the agent's own mistakes inside its mandate, wrong or counterfeit goods, and third-party loss to merchants. **Non-delivery is left to Concordium's Protocol-Enforced Escrow.**

## 3. Distribution

- **Agents:** an MCP server (any MCP client) is already in this repo. Next come plugins for AgentKit, LangChain and ElizaOS, so an agent can buy cover with one tool call.
- **Merchants:** `KuasaGuard` plugs into any x402 resource server. A merchant sets `minCover` per product; that one line makes insured-only selling possible for regulated goods.
- **Owners:** a white-label cover screen inside the owner's wallet app (WDK), with the console's revoke, publish and claims views.

## 4. Business model

- **Premium share:** the MGA commission on every premium (a typical market range is 10–25%).
- **Merchant fee:** an optional fee for the guard plus merchant-loss cover (Approach C in the design), comparable to a card chargeback-protection fee.
- **Fees are sponsored and predictable.** Concordium fees are pegged to EUR, about a cent per transaction. A policy costs 1 x402 payment, 1 receipt, 1 `issuePolicy` and 1 metadata update. A claim costs 1 sponsored filing, 1 assessment, 1 decision, 1 payout and 1 `recordPayout`. Audit anchoring is one `registerData` per minute of activity, not per decision.

## 5. Mainnet checklist

1. Deploy `kuasa-registry` and `kuasa-cover` on mainnet. CIS-8004 on mainnet is `<10082,0>` (CIS-8 is `<10081,0>`).
2. Replace EUDemo with the production euro PLT; run the issuer's allow-listing for the treasury and for merchants.
3. Move the pool into a PLL (Enhanced) once live. Until then: a treasury with multi-signature controls and daily reconciliation against `paidOut` on the contract.
4. Persist service state in a database instead of local JSON files, and run the insurer as a stateless replicated service with a single claims-decision queue.
5. Fronting-carrier agreement, policy wording, claims-handling procedure and a DPIA (no personal data on-chain; ZK proofs only).
6. Security review of both contracts and the guard. Bug bounty.
7. Contract hardening deferred on testnet to keep the recorded evidence valid (enforced off-chain today by the assessor and service): distinct orders per duplicate claim, one policy per premium transaction, one claim per order across all policies of a mandate, `agent_token` checked against the mandate, and a bounded per-payer policy index.

## 6. Adopted from elsewhere

Ideas from other insurance, dispute and agent-trust systems, built into Kuasa Cover. "Live" means it ran on testnet (see docs/TESTNET.md); "tested" means unit or contract tests only, because testnet time cannot reach it yet.

| Idea | From | In Kuasa | Status |
|---|---|---|---|
| Bonded objections | UMA Optimistic Oracle | `objectClaim` is payable: the objector locks 1 CCD; returned if the claim is rejected, forfeited to the pool if not | Live (contract v3) |
| Operator bonds and slashing | EigenLayer-style restaking | `postBond` by the agent payer or a policy holder; slashed into the pool when a claim the agent side filed is marked fraud; locked until every policy of the agent is past its claims window; bonded agents get a 0.9 premium factor | Bond and discount live; slashing tested |
| Fully parametric claims | Etherisc | `fileClaimFor`: the insurer files the duplicate it detected for the agent and assesses it at once | Live |
| Per-policy terms | – | `setTerms` stores a policy's auto-pay limit, window and the owner-signed AP2 intent hash; only stricter values apply; agents with incidents get half the automatic limit | Live |
| Appeal panel | Kleros | Independent juror accounts (`KUASA_JURORS`, never a party to the claim) vote on appeals with a signed request; a majority decides like a human would. Jurors must hold capital in the pool (default 5 EUDemo, Nexus-style assessors); a juror who votes against the verdict pays 1 EUDemo of it to the jurors who voted with it (Kleros coherence), and its stake cannot leave while its appeal is open. The demo panel is two testnet accounts; production uses a juror pool or a Kleros court | Panel live (v3 claim #2: an appeal the two jurors rejected); stakes tested. On testnet three jurors stake pool capital (teen #0: 6 EUDemo, teen #1 from its earlier deposit, the investor: 90 EUDemo) |
| Risk-specific staking | Nexus Mutual | Capital may back one class (`kuasa capital:AM|WI|ML`): first loss for that class, 1.5x premium weight | Live (the shop backs wrong items) |
| Portable reputation | ERC-8004 Reputation Registry | `erc8004-feedback` A2A skill: claim outcomes as ERC-8004 feedback with a pointer to the claim on Concordium; `scripts/erc8004-post.ts` registers the agent in the official ERC-8004 Identity Registry on Ethereum Sepolia and the insurer (its own EVM key) posts each outcome to the Reputation Registry, with the feedback file published and its keccak256 as `feedbackHash` | Live on Ethereum Sepolia: Alice's agent is agentId 11449, 13 feedback entries |
| Per-order risk scoring | Stripe Radar | Order velocity from the insurer's on-chain watcher raises per-order premiums (x1.25 per order beyond two in the window, up to x2) | Live |
| Merchant-paid cover | "Free shipping" | The shop pays the per-order premium; only the sponsor may pay that quote, and refunds or givebacks go back to it | Live |
| Underwriting capacity | Fully collateralised cover (Nexus Mutual capacity) | A quote is refused when its limit plus every live limit (all cover contracts) exceeds the pool; re-checked when the premium is paid. Capital providers add capacity | Live: on 21 November the pool (172.98) no longer covered live limits (173.00) and new period cover was refused; after the shop added 30 EUDemo of capital the same quote was sold |
| Credibility-weighted experience rating | Bühlmann credibility (actuarial) | One factor replaces the old "+20% per claim" and "claim-free" rules: 50·(1 + paid claims)/(orders + 50), x0.7 to x2, so a claim weighs more the fewer orders back it | Tested (prices every quote) |
| Spend surge | Stripe Radar (amount velocity) | Per-order cover costs x1.25 when the window's spend plus this order exceeds twice the mandate's per-order cap; with order velocity at most x2 | Tested |
| Compelling evidence | Stripe Compelling Evidence 3.0 | Each claim records how many earlier orders on the mandate nobody disputed; for AM20 ("the agent did not mean to buy this"), two or more qualify and the human deciding sees it | Tested |
| Escalation | UMA's DVM behind the optimistic oracle | The panel decides an appeal once; appealing the panel's decision goes to a human at the insurer | Tested |
| Buyer-chosen terms | – | `maxAutoPay` on the quote: the buyer can lower the automatic payout limit (0 = a human on every claim); it is written on-chain with `setTerms` and honoured off-chain too; it can never loosen the rule | Tested |
| Content-addressed evidence | IPFS-style content addressing | Evidence documents are published at `evidence/<sha256>.json` next to the explorer, only when the hash equals the claim's on-chain `evidence`; the claim timeline links them | Live (v3 claims #0 and #1) |
| Capital tranches | Sherlock / Risk Harbor | Memo `kuasa capital:junior`: junior capital takes claim losses of every class after the class capital and before everyone else (senior), and earns premiums at 1.5x weight; refunds and givebacks are not loss layers | Tested |
| Insured badge | "Verified by" trust seals | `kuasa-explorer.vercel.app/?badge=<agent payer>` renders "Insured by Kuasa Cover · X of cover left", "agent paused" or "not insured", read from the cover contract and the circuit breaker in the visitor's browser, so a shop cannot fake it | Live |
| An insurance market | Etherisc GIF (many operators, one framework), Nexus Mutual v2 (pool managers price their own capacity) | A second insurer, Kuasa Re, runs its own instance of the same kuasa-cover v3 module (`<13108,0>`) with its own operator, its own pool and its own price (`KUASA_PRICE_BPS`). The agent asks every insurer its mandate names and buys the cheapest offer; an insurer out of capacity simply drops out. The shop adds period cover from all insurers up (co-insurance). An "other insurance" rule makes each insurer read the others' books so one loss is paid once. The owner decides which insurers the agent may pay: their pools and operators are in the mandate | Live (teen agent: Kuasa Cover out of capacity, Kuasa Re sold policy Re #0) |
| Syndicated cover | Nexus Mutual v2 capacity allocation, Lloyd's following market | When no insurer can carry a limit alone, the agent fills each insurer's free capacity (pool minus live limits, from its public /solvency) cheapest first; each share is that insurer's own policy | Live (Bob: 90 EUDemo split 80.36 Kuasa Re + 9.64 Kuasa Cover) |
| Contribution between insurers | Co-insurance "other insurance" clause | Each insurer pays only the part of the verified loss (the receipt) that other insurers have not paid or approved for the same agent, checked at assessment and again right before money moves; one loss is paid once, and every syndicated share still pays | Tested |
| On-chain market directory | Agent registries (ERC-8004 / CIS-8004) | Each insurer describes itself on its own CIS-8004 entry (`kuasa:insurer`: contract, pool, operator, price, URL, EVM address), written by the pool that owns the entry; `kuasa:market` lists them. Agents discover insurers from the chain and keep only self-attested ones their mandate allows | Live |
| Reputation priced across chains | ERC-8004 Reputation Registry | An agent links its ERC-8004 identity both ways (`kuasa:erc8004` on its CIS-8004 entry, `kuasa:cis8004` on Ethereum). Insurers read feedback only from insurers on the market directory, never their own, and price it (70 neutral, x0.85 to x1.3). Paid claims are posted to ERC-8004 automatically | Live (Kuasa Re prices Alice x1.17 from Kuasa Cover's outcomes; v3 claim #3 posted unaided) |
| Owner rules | Stripe Radar rules | A policy holder signs a spending limit per hour; above it the insurer's block watcher pauses the agent through the circuit breaker every shop honours | Live (Bob: 5 EUDemo/h, paused after a 24 EUDemo bottle) |
| An open, bonded insurer registry | EigenLayer operator registry | `kuasa-market <13114,0>`: any insurer joins from its pool with a CCD bond, leaving takes 7 days, anyone can slash a bond when the insurer's own cover contract shows an approved claim still unpaid after the grace period (the market contract reads it directly; no arbiter), and an arbiter (a Concordium account re-keyed to 2-of-3 juror keys; in production a larger panel or a Kleros court) can slash by judgement. Agents discover insurers from it; ERC-8004 ratings count only from peers an insurer trusts (joining is open, so the registry alone is no trust anchor) | Live (both insurers bonded 10 CCD on v2; an unpaid approved claim slashed by a third party, no arbiter) |
| Premium giveback | Lemonade | 10% of the premium back when a policy ends with no claim | Tested; live run started (Carol's 7-day policy #7 ends 28 November) |

Done since: slashing tied to an on-chain proof that an approved claim went unpaid (kuasa-market reads the insurer's own cover contract; the penalty waits in escrow that the 2-of-3 juror panel can veto). Still open: independent operators (see below), a real (larger) juror pool, the pool itself under protocol control (EUDemo is a protocol-level token, and as of protocol 9 only accounts hold and transfer PLTs, so a smart contract cannot hold the pool; the Protocol-Level Lock that would escrow it is on Concordium's roadmap. Today the pool is the treasury account plus an off-chain ledger, with every flow on-chain and the ledger audited), insurers beyond the two on testnet (each needs its own allow-listed pool account), and the card-network agent protocols ([docs/INTEGRATIONS.md](INTEGRATIONS.md#card-network-agent-protocols-visa-trusted-agent-protocol-mastercard-agent-pay)).

## 7. From one operator to many

On testnet one team runs every role, so the mechanisms can be shown end to end. What each role needs before mainnet:

| Role | Testnet | Mainnet |
|---|---|---|
| Insurers | Kuasa Cover and Kuasa Re, both run by us | Any licensed carrier or MGA registers on kuasa-market with a bond; the registry already accepts anyone whose cover contract runs the audited module and names its own pool |
| Jurors | Three keys held by us (teen #0, teen #1, investor #0) | Staked jurors from outside the team: insurers, merchants, owners' associations; the panel account re-keys to them with `UpdateCredentialKeys`, no contract change |
| Capital providers | The investor persona | External depositors in the junior and senior tranches |
| Keeper | GitHub Actions cron with a testnet key | Any account: every keeper call (settle, flag, slash, release) is permissionless |
| Merchants | The demo shop | Shops that install the guard middleware |

## 8. Security review of kuasa-cover (22 Nov)

An independent review of `contracts/kuasa-cover` found no critical issue: status moves are final, a claim cannot be paid twice, payouts never exceed the policy limit, and state is updated before every transfer. Its findings, and what was done:

| Finding | Status |
|---|---|
| A payout could exceed the claimed amount, using up cover other claims need | Fixed in code: `recordPayout` caps at the claim |
| With the policy limit used up, an approved claim could never close, so kuasa-market could slash an honest insurer for it | Fixed in code: a zero payout closes it once the limit is exhausted |
| A merchant's bogus MerchantLoss claim marked fraud would slash the agent's bond | Fixed in code: only fraud by the payer or holder costs the bond |
| `recordPayout` is the operator's statement: a token payout cannot be checked by the contract, so an insurer could record a token payment to avoid the unpaid-claim slash | Open until the pool sits in a Protocol-Level Lock released by the contract (section 1). A floor at the claimed amount is not used because contribution between insurers legitimately pays less |
| Objection bonds are released only when the claim is decided; objections are not limited per account | Open: one objection per account and a withdraw-after-timeout for objectors |
| Order hashes are not checked against receipts at filing | Open: check them against kuasa-registry receipts |
| The first poster of an agent bond owns it | Open: let only the payer post |

The fixes ship with the next kuasa-cover deployment (25 contract tests pass). The live instances still run the reviewed code.
