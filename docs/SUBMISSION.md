# Final submission: paste-ready answers (Checkpoint 2)

The form opens Mon 23 Nov, 06:59 GMT+7. The deadline is Thu 10 Dec, 06:59 GMT+7 (9 Dec, 23:59 UTC).

## Description
Kuasa Cover is insurance for AI agent commerce, on Concordium.

AI agents can pay on their own now. When one makes a mistake, nobody carries the loss: it orders twice, gets the wrong item, or harms a merchant. Kuasa Cover makes agent commerce insurable.

**How it works**
1. **The owner verifies once.** The owner uses Concordium ID and gives the agent a mandate: budget, per-order limit, categories, merchants and expiry. The mandate carries a Verify & Access zero-knowledge proof (18+, EU resident) bound to that one agent.
2. **The agent insures itself.** It buys cover over x402 in EUDemo, an allow-listed euro PLT. The premium is priced from on-chain facts and experience-rated.
3. **Merchants check before taking payment.** They check the mandate, the proof, the agent's CIS-8004 entry, and that the order is insured.
4. **Claims are paid from on-chain evidence.** The agent files them itself, with the fee sponsored. Claims of 10 EUDemo or less are paid automatically after an objection window, under rules the cover contract enforces. Larger ones need a human.

**The demo agent is real.** Claude, given only the Kuasa MCP tools and no step hints, read the shop's refusal, bought the smallest cover that fit, and completed the purchase. Later it found a double charge and filed the claim itself.

**Each claim rests on three independent records**, all public on a live explorer:
- the on-chain receipts;
- the insurer's published decision (automatic or human);
- the merchant's attestation that the orders are real. The fraud attempts show none.

**Evidence, not trust.** Claims carry chargeback-style reason codes. A wrong item is proven by the merchant's delivery note, signed by the same account that recorded the receipt on-chain. A purchase a prompt-injected agent made outside the owner's signed AP2 intent is covered as well.

**The contract does more of the work (v3).** The insurer files a mistake it detected for the agent, and the contract pays it within its published rules, with nobody filing anything. Objections lock a CCD bond. Operators can bond their agents for a cheaper premium, and the bond is slashed into the pool if fraud is proven.

**Prevention, not only payouts.** The insurer watches every finalized block. When an insured agent pays twice, it pauses that agent at every merchant guard until the owner resumes it, and the agent files the detected claim with one call. On testnet the shop refused the paused agent before any money moved, and the contract approved the automatic payout.

**More integrations:**
- The insurer is itself a badged agent with A2A skills, and the read-only skills are public.
- Agents on EVM chains are covered too. An Ethereum key bound through CIS-8 lets an EVM merchant verify an agent's badge and cover from a signature. AgentKit agents can do it with their own wallet.
- Fraud has consequences: a lawful-disclosure request for the identity provider and Privacy Guardians, anchored only after human review.

**Both sides of the market.** A merchant harmed by an insured agent claims on that agent's cover; this was paid automatically on testnet. Cancelled policies get the unused premium back pro rata.

Escrow protects you from bad sellers. Kuasa Cover protects you from your agent.

## Code
https://github.com/PugarHuda/kuasa

## Demo video
https://youtu.be/Tqe_CLniIl0

## Testnet link
https://ccdexplorer.io/testnet/instance/13105/0 (kuasa-cover v3; v2: https://ccdexplorer.io/testnet/instance/13100/0, v1: https://ccdexplorer.io/testnet/instance/13066/0).

Every transaction is listed in https://github.com/PugarHuda/kuasa/blob/main/docs/TESTNET.md.

## Which Concordium components does your project use?
- **Concordium ID and Verify & Access (V1):** ZK proof of 18+ and EU residency, bound to the agent.
- **Web3 ID proof:** joins the EUDemo allow list.
- **Agent Registry CIS-8004 and the Verified by Concordium badge:** four badged agents, including the insurer. Cover status, claim decisions and merchant attestations are published as registry metadata.
- **CIS-8 External Key Registry:** an Ethereum key bound to an agent.
- **Hosted Agent Registry MCP:** badges, `check_badge`, `agent_by_external_reference`.
- **x402:** purchases and premiums, with in-process facilitators.
- **Sponsored transactions:** purchases and claim filings.
- **Protocol-Level Token EUDemo:** allow-listed; prices, premiums and payouts.
- **Smart contracts:** `kuasa-registry` and `kuasa-cover`, with cross-contract checks.
- **registerData:** EU AI Act Art. 12 audit anchors.
- **Privacy Guardians:** the disclosure process.
- **MCP and A2A.**

## Your path to mainnet
See https://github.com/PugarHuda/kuasa/blob/main/docs/PRODUCTION.md.

1. **Capital:** the pool moves into a Protocol-Level Lock (Enhanced), released only by the cover contract's `claimsAuthorized`.
2. **Underwriting inputs:** Agent IDP credentials replace the owner's mandate proof. KYCaaS, AML and liveness results become pricing factors.
3. **Settlement asset:** EURQ replaces EUDemo.
4. **Regulated risk carrier:** a fronting insurer carries the regulated risk, and Kuasa acts as the MGA and claims infrastructure.
5. **Wallets:** owners sign in their own wallet (Dfns or a browser wallet); the console never holds keys.
6. **Rules on-chain:** auto-pay limits and decisions move into the cover contract.

## Slides
https://kuasa-explorer.vercel.app/slides

## Live demo
- Explorer: https://kuasa-explorer.vercel.app
- Public A2A: https://kuasa-explorer.vercel.app/a2a
- Agent Cards: https://pugarhuda.github.io/kuasa/agents/insurer.json
