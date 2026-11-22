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
| Depth of integration | Concordium ID and Verify & Access (ZK 18+ and EU residency bound to one agent), Agent Registry CIS-8004 and the badge, CIS-8, hosted Agent Registry MCP, x402, sponsored transactions, the EUDemo PLT, three contracts with cross-contract reads, registerData audit anchors. Table: [README](../README.md#concordium-components) |
| It works | The Try it button above; [evidence tour](https://kuasa-explorer.vercel.app/evidence.html) (every live step with its transactions); `pnpm verify` |
| Path to production | [PRODUCTION.md](PRODUCTION.md): pools under Protocol-Level Locks, EURQ, a licensed fronting insurer with Kuasa as MGA, independent operators, open security findings |
| Usefulness | Agents now spend money on their own; when one double-pays, buys outside its owner's intent or harms a merchant, Kuasa pays, priced from on-chain facts. From the mistake to the payout: about 5 minutes, no human (median of recorded runs, on-chain) |

## Honest limits
- Every role on testnet is played by one team: both insurers, the three jurors, the capital providers
  and the shop ([who runs what](TESTNET.md#who-runs-what)).
- The testnet claims are staged to show each flow, so the loss ratio says nothing about real risk;
  pricing is checked by simulation in [PRICING.md](PRICING.md).
- A payout is the insurer's own transfer recorded on the contract; until pools sit in Protocol-Level
  Locks the contract cannot check the money moved ([PRODUCTION.md §8](PRODUCTION.md)).
