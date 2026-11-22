# Judging Kuasa Cover in five minutes

**Payment guards stop a bad payment before it happens. Kuasa pays when one gets through.** Kuasa
Cover is insurance for what an AI agent gets wrong with real money, on Concordium.

## 1. Watch (3 minutes)
https://youtu.be/F_uwB-QmuhY

## 2. Run it yourself (no wallet, no keys)
- Open https://kuasa-explorer.vercel.app and press **Run it on testnet** under "Try it live". The
  hosted shop and both insurers make Alice's insured agent pay twice for a loaf; the insurer finds the
  pair on-chain, pauses the agent at every shop, files the claim itself, and the contract approves the
  payout after the objection window. 3 to 5 minutes; every line links to a testnet transaction.
- Or bring your own agent: `claude mcp add --transport http kuasa https://kuasa-live.onrender.com/mcp`,
  then ask Claude to buy a bottle of Rioja. It drives Bob's insured agent against the same services.

## 3. Check every claim we make, without trusting us
```bash
git clone https://github.com/PugarHuda/kuasa && cd kuasa && pnpm install
pnpm verify            # every transaction linked from docs/TESTNET.md: finalized, not rejected
pnpm verify --costs    # and the fee each kind of action actually cost (docs/COSTS.md)
```
No keys, no accounts and none of our services: it only reads the public testnet node. Contract tests:
`cargo test` in `contracts/kuasa-cover`, `contracts/kuasa-market`, `contracts/kuasa-registry`.

## 4. What to look at, by judging criterion
| Criterion | Where |
|---|---|
| Depth of integration | Concordium ID and Verify & Access V1 with all three anchors (request, presentation, audit anchor; ZK 18+ and EU residency bound to one agent), Agent Registry CIS-8004 with the badge and the agentWallet each payment must come from (cleared on transfer), Agent Cards from the registry's own builder (badge valid, card hash matches on-chain), CIS-8, hosted Agent Registry MCP, x402, sponsored transactions, the EUDemo PLT, three contracts with cross-contract reads, registerData audit anchors. Table: [README](../README.md#concordium-components) |
| It works | The Try it button above; live numbers at https://kuasa-live.onrender.com/stats; [evidence tour](https://kuasa-explorer.vercel.app/evidence.html) (every live step with its transactions); `pnpm verify` |
| Path to production | [PRODUCTION.md](PRODUCTION.md): pools under Protocol-Level Locks, EURQ, a licensed fronting insurer with Kuasa as MGA, independent operators, open security findings |
| Usefulness | Composes with the payment guards other teams built: the insurer prices vet402's delivery verdicts on the merchants an agent may pay (guards stop a bad payment; Kuasa pays when one gets through). Agents now spend money on their own; when one double-pays, buys outside its owner's intent or harms a merchant, Kuasa pays, priced from on-chain facts. From the mistake to the payout: about 5 minutes, no human (median of recorded runs, on-chain) |

## What the contracts enforce, and what waits for Protocol-Level Locks
Enforced on-chain today: the policy terms and limits, the claim lifecycle and its automatic-approval rules
(`autoApprove` refuses anything outside them), bonded objections, and the insurers' CCD bonds on kuasa-market:
an insurer that approves a claim and does not pay is slashed by anyone, into an escrow the juror panel can
veto. Not enforced yet: the EUDemo payout itself, because Protocol-Level Tokens cannot be held by smart
contracts. Concordium's Protocol-Level Locks (Simple, January 2027; contract-authenticated Enhanced, March
2027) are the protocol answer; the cover contract's `claimsAuthorized` view is already the release condition
they need ([PRODUCTION.md](PRODUCTION.md)).

## Honest limits
- Every role on testnet is played by one team: both insurers, the three jurors, the capital providers
  and the shop ([who runs what](TESTNET.md#who-runs-what)).
- The testnet claims are staged to show each flow, so the loss ratio says nothing about real risk;
  pricing is checked by simulation in [PRICING.md](PRICING.md).
- A payout is the insurer's own transfer recorded on the contract; until pools sit in Protocol-Level
  Locks the contract cannot check the money moved ([PRODUCTION.md §8](PRODUCTION.md)).
