# Final submission: paste-ready answers (Checkpoint 2)

The form opens Mon 23 Nov, 06:59 GMT+7. The deadline is Thu 10 Dec, 06:59 GMT+7 (9 Dec, 23:59 UTC).

## Description
Kuasa Cover is insurance for AI agent commerce, on Concordium. Escrow protects you from bad sellers. Kuasa Cover protects you from your own agent.

**The problem**
- AI agents now pay on their own. When one orders twice, buys the wrong item or harms a merchant, nobody carries the loss.
- Shops cannot tell an accountable agent from an anonymous script.

**How it works**
1. **The owner verifies once.** Concordium ID plus a Verify & Access ZK proof (18+, EU resident) bound to one agent, with a signed mandate: budget, per-order limit, merchants, expiry.
2. **The agent insures itself.** It buys cover over x402 in EUDemo (a PLT), priced from on-chain facts and its own claims history.
3. **Shops check before taking payment:** mandate, proof, CIS-8004 badge, and that the order is insured.
4. **Claims are paid from on-chain evidence.** Small claims pay automatically after an objection window, under rules the cover contract enforces; larger ones go to a human.
5. **Prevention:** the insurer watches every block and pauses an agent that pays twice, or breaks a rule its owner signed, at every shop.

**What is live on testnet** (every step with its transactions: https://kuasa-explorer.vercel.app/evidence.html)
- A real Claude agent with only the Kuasa MCP tools was refused, insured itself, bought, then found a double charge and filed the claim.
- Two insurers in an open, bonded registry. An agent compares quotes on-chain and splits a large limit across them (Bob's 90 EUDemo: 80.36 + 9.64). Each loss is paid once.
- An insurer that approves a claim and does not pay loses part of its bond to the claimant. Anyone can trigger it, no arbiter needed. The penalty sits in escrow, and a 2-of-3 juror multisig account can veto self-dealing (done live: one key was rejected by the node, two went through).
- Paid claims are posted to the agent's ERC-8004 reputation on Ethereum Sepolia, and another insurer prices from it (x1.17 for an agent it never insured).
- Merchants harmed by an agent claim on its cover; cancelled policies are refunded pro rata.

**Concordium components**
Concordium ID and Verify & Access, Web3 ID, Agent Registry (CIS-8004) and the Verified by Concordium badge, CIS-8, hosted Agent Registry MCP, x402, sponsored transactions, the EUDemo PLT, three smart contracts (kuasa-registry, kuasa-cover, kuasa-market) with cross-contract reads, registerData audit anchors (EU AI Act Art. 12), Privacy Guardians, MCP and A2A.

**Path to production**
Pools move into Protocol-Level Locks released only by the cover contract; EURQ replaces EUDemo; a licensed fronting insurer carries the risk while Kuasa acts as MGA and claims infrastructure. Details: https://github.com/PugarHuda/kuasa/blob/main/docs/PRODUCTION.md

## Code
https://github.com/PugarHuda/kuasa

## Demo video
https://youtu.be/gLmIZl-64h0

## Testnet link
https://ccdexplorer.io/testnet/instance/13105/0 (kuasa-cover v3; v2: https://ccdexplorer.io/testnet/instance/13100/0, v1: https://ccdexplorer.io/testnet/instance/13066/0). Second insurer Kuasa Re: https://ccdexplorer.io/testnet/instance/13108/0. Open insurer registry kuasa-market: https://ccdexplorer.io/testnet/instance/13114/0.

Every live step with its transactions, newest first: https://kuasa-explorer.vercel.app/evidence.html (source: https://github.com/PugarHuda/kuasa/blob/main/docs/TESTNET.md).

## Which Concordium components does your project use?
- **Concordium ID and Verify & Access (V1):** ZK proof of 18+ and EU residency, bound to the agent.
- **Web3 ID proof:** joins the EUDemo allow list.
- **Agent Registry CIS-8004 and the Verified by Concordium badge:** four badged agents, including the insurer. Cover status, claim decisions and merchant attestations are published as registry metadata.
- **CIS-8 External Key Registry:** an Ethereum key bound to an agent.
- **Hosted Agent Registry MCP:** badges, `check_badge`, `agent_by_external_reference`.
- **x402:** purchases and premiums, with in-process facilitators.
- **Sponsored transactions:** purchases and claim filings.
- **Protocol-Level Token EUDemo:** allow-listed; prices, premiums and payouts.
- **Smart contracts:** `kuasa-registry`, `kuasa-cover` (two insurers run their own instance) and `kuasa-market` (open, bonded insurer registry), with cross-contract checks.
- **registerData:** EU AI Act Art. 12 audit anchors.
- **Privacy Guardians:** the disclosure process.
- **MCP and A2A**, and ERC-8004 on Ethereum Sepolia for portable reputation.

## Your path to mainnet
See https://github.com/PugarHuda/kuasa/blob/main/docs/PRODUCTION.md.

1. **Capital:** the pool moves into a Protocol-Level Lock (Enhanced), released only by the cover contract's `claimsAuthorized` (as of protocol 9 only accounts hold PLTs, so today each pool is an account with an audited ledger).
2. **Underwriting inputs:** Agent IDP credentials replace the owner's mandate proof. KYCaaS, AML and liveness results become pricing factors.
3. **Settlement asset:** EURQ replaces EUDemo.
4. **Regulated risk carrier:** a fronting insurer carries the regulated risk, and Kuasa acts as the MGA and claims infrastructure.
5. **Wallets:** owners sign in their own wallet (Dfns or a browser wallet); the console never holds keys.
6. **Rules on-chain:** auto-pay limits and decisions move into the cover contract.

## Slides
https://kuasa-explorer.vercel.app/slides

## Live demo
- Try it live: the "Run it on testnet" button on https://kuasa-explorer.vercel.app runs the parametric claim for real on the hosted shop and insurer (Render free tier: if it was asleep, the first run takes a minute to start)
- Explorer: https://kuasa-explorer.vercel.app (market table, claim timelines, premium calculator)
- Evidence tour: https://kuasa-explorer.vercel.app/evidence.html
- Public A2A: https://kuasa-explorer.vercel.app/a2a
- Agent Cards: https://pugarhuda.github.io/kuasa/agents/insurer.json
