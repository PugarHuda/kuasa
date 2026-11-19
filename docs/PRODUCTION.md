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
| EUDemo (test euro) | **EURQ** (MiCA, Quantoz) or another regulated euro PLT | Live | one env var (`KUASA_ASSET`) |
| Keys in local files | Owner: Concordium wallet / **WDK** inside the app. Agent and insurer: **Dfns** wallets-as-a-service (MPC) or **Concordium Signer** | WDK v2/v3, Concordium Signer Feb 2027 | `Wallet` signer abstraction in `packages/chain` |
| Badge not pinned (local Agent Card) | Agent Card on a public URL, hash pinned with `setAgentURI`, Verified-by-Concordium badge | Live | Agent Card already carries the Kuasa extension |

## 2. The insurance side

- **Carrier.** Kuasa acts as the technology layer and MGA. A licensed **fronting insurer** carries the risk and holds the regulatory licence (EU: Solvency II; distribution under the IDD). Kuasa provides underwriting data, policy administration, claims evidence and payouts.
- **Pricing.** Today's rules are transparent but illustrative. In production they are calibrated on loss data. The inputs stay the same and verifiable: mandate tightness, proven attributes, on-chain receipts and incidents, owner type (LEI businesses).
- **Claims.** The assessor only recommends; a human claims handler decides (EU AI Act and insurance conduct rules). Every decision is anchored (`registerData`), which gives Art. 12 record keeping without putting personal data on-chain.
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
