# Pricing: how the Kuasa Cover premium is set and checked

The premium comes from `packages/cover/src/risk.ts`. It is a transparent, rule-based model in which every factor is explained in the quote.

## The rules

**Base rate:** 2% of the cover limit per 30 days.

Multipliers on the base rate:

| Factor | Multiplier | Applies when |
|---|---|---|
| Mandate tightness | ×0.8 | per-order cap ≤ 25% of the limit |
| | ×0.9 | per-order cap ≤ 50% of the limit |
| Merchant allowlist | ×0.9 | the mandate lists the merchants the agent may pay |
| Riskiest category | ×1.0 | groceries |
| | ×1.2 | wine |
| | ×1.4 | vape |
| ZK-proven age and residency | ×0.9 | the owner's proof is bound to the agent |
| Business owner | ×0.85 | the principal is a business |
| Incidents | +25% per incident | incidents are filed against the mandate |
| Claim-free history | −5% per 5 receipts (floor ×0.7) | the agent has no paid claims |
| **Experience rating** (Bühlmann credibility) | 50·(1 + paid claims) / (orders + 50), ×0.7 to ×2 | always: a 2% claim-per-order prior weighted as 50 orders; orders without claims earn a discount, and a claim weighs more the fewer orders back it |

Every input is read from chain data or from a verified proof at quote time, and read again when the premium is paid. Paid claims are counted on the `kuasa-cover` contract.

## Monte Carlo check

`tsx scripts/simulate-pricing.ts` runs the demo profile: wine and groceries, 100 EUDemo cover, 30 days, ZK-proven owner, merchant allowlist.

- **Premium:** 1.7496 EUDemo.
- **Simulation:** 20,000 agent-months, about 8 orders a month.
- **Mistakes:** each mistake is a duplicate order, judged by the real assessor (`assess.ts`, 1 EUDemo deductible).
- **Seed:** fixed, so the run is reproducible.

| Mistake rate per order | Expected claims per agent-month | Loss ratio | Worst 1% month |
|---|---|---|---|
| 0.25% | 0.32 | 18% | 2 |
| 0.50% | 0.62 | 35% | 23 |
| 1.00% | 1.34 | 77% | 59 |
| 2.00% | 3.33 | 190% | 59 |
| 5.00% | 8.30 | 474% | 82 |

**Reading:** the base premium breaks even at about **1.2% duplicate orders per order**.

An agent that makes mistakes more often than that pays more in two ways:
- Experience rating weighs its paid claims against its orders with Bühlmann credibility: one claim in 10 orders is about ×1.67, one in 50 orders is the neutral prior.
- Orders without claims earn credibility the other way, down to ×0.7.

The tail is capped by the policy limit (100). Holding enough capital for that tail is what the public `/solvency` endpoint shows.

## Honest limits

- The mistake rates are **assumptions, not data**. Nobody has loss data for AI shopping agents yet. A real insurer would start conservative, then let experience rating and the published claims history set the price.
- The model covers duplicate orders only. Wrong-item and merchant-loss claims need their own frequency data.
