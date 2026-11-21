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
| Appeal panel | Kleros | Independent juror accounts (`KUASA_JURORS`, never a party to the claim) vote on appeals with a signed request; a majority decides like a human would. Jurors must hold capital in the pool (default 5 EUDemo, Nexus-style assessors); a juror who votes against the verdict pays 1 EUDemo of it to the jurors who voted with it (Kleros coherence), and its stake cannot leave while its appeal is open. The demo panel is two testnet accounts; production uses a juror pool or a Kleros court | Panel live (v3 claim #2: an appeal the two jurors rejected); stakes tested |
| Risk-specific staking | Nexus Mutual | Capital may back one class (`kuasa capital:AM|WI|ML`): first loss for that class, 1.5x premium weight | Live (the shop backs wrong items) |
| Portable reputation | ERC-8004 Reputation Registry | `erc8004-feedback` A2A skill: claim outcomes as ERC-8004-shaped feedback with a pointer to the claim on Concordium. Posting on an Ethereum ERC-8004 registry needs the agent's ERC-8004 id and gas | Live (read-only) |
| Per-order risk scoring | Stripe Radar | Order velocity from the insurer's on-chain watcher raises per-order premiums (x1.25 per order beyond two in the window, up to x2) | Live |
| Merchant-paid cover | "Free shipping" | The shop pays the per-order premium; only the sponsor may pay that quote, and refunds or givebacks go back to it | Live |
| Underwriting capacity | Fully collateralised cover (Nexus Mutual capacity) | A quote is refused when its limit plus every live limit (all cover contracts) exceeds the pool; re-checked when the premium is paid. Capital providers add capacity | Live: on 21 November the pool (172.98) no longer covered live limits (173.00), and new period cover was refused until capital is added |
| Premium giveback | Lemonade | 10% of the premium back when a policy ends with no claim | Tested (no v3 policy has ended yet) |

Still open: posting ERC-8004 feedback on Ethereum, a real (larger) juror pool, per-policy terms chosen by the holder rather than the insurer, and moving forfeited bonds into the Protocol-Level Lock once the pool lives there.
