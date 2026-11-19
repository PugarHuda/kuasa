# Kuasa Cover: insurance for AI agent commerce (design)

Date: 2026-11-19. Status: approved direction (option A + B), pending design approval.

## Intent and why

AI agents can pay on their own, but when something goes wrong nobody carries the loss. Examples: the agent buys the wrong thing, a fake shop scams it, a shop never delivers, an agent harms a merchant. So owners hesitate to let agents spend, and merchants hesitate to sell to them. Conventional insurers are moving to explicit AI exclusions.

**Kuasa Cover** makes agent commerce insurable. An owner who verified once with Concordium ID buys cover for their agent. Premiums are priced from on-chain facts:
- how tight the agent's Kuasa mandate is,
- what the owner proved,
- the agent's receipt and incident history.

Merchants see "insured up to €X" on the agent before taking payment. Claims are decided against on-chain evidence and paid in EUDemo. Fraudulent claimants face the lawful identity-disclosure route.

**Why this direction:** it builds *on* Concordium's roadmap rails instead of duplicating them.
- Agent IDP gives agents identity.
- Protocol-Level Locks and Protocol-Enforced Escrow bound and secure funds.
- Insurance, credit and disputes appear nowhere on the roadmap, in the Concordium ecosystem, or in other hackathon entries (checked 2026-11-19).

The pitch: *Concordium builds the rails; Kuasa Cover makes the remaining risk insurable.*

## Goals

1. An owner buys **period cover** for their agent via x402 (option A), and **per-order top-up cover** for high-value orders (option B).
2. Premiums come from a **transparent, rule-based risk engine** over on-chain data, with a per-factor explanation.
3. A **cover contract** on testnet records policies, claims, decisions and payouts.
4. The **insured status is visible in the CIS-8004 Agent Registry** (agent metadata + Agent Card). The shop's guard checks it, plus the agent's registry entry, before payment.
5. **Claims flow end to end:** filed with evidence → rule-based assessment against on-chain receipts → human claims-handler approval in the console → EUDemo payout → payout recorded on-chain.
6. **Fraud path:** a claim with no matching on-chain evidence is rejected. Repeated fraud produces an anchored lawful-disclosure request document.
7. **Two-way trust:** the buyer agent checks the shop is a registered, active agent before paying.
8. **Audit trail:** batches of guard and claim decisions are anchored with `registerData` (EU AI Act Art. 12 record keeping).
9. The MCP server gains cover tools, so Claude can insure itself and file claims.
10. **Nothing that exists today is removed.** Mandates, V&A proofs, the mandate registry, the guard, EUDemo, x402, sponsorship, the console and MCP all stay and are used by Cover.

## Non-goals

- Real actuarial pricing or a licensed insurance product (rules are illustrative and stated as such).
- An LLM making payout decisions.
- Mainnet.
- Real Privacy Guardian disclosure (we produce and anchor the request; the court/PG process is described, not executed).
- Holding the pool inside a smart contract (not possible today, see Constraints).

## Anti-goals (would be a failure even if it works)

- Headline features that duplicate Concordium roadmap items (Agent IDP, Verify & Pay, Locks).
- Any payout without a human approval step visible in the demo.
- Presenting ourselves as a licensed insurer.
- Overclaiming: every limitation goes in README "Honesty notes".

## Constraints (verified 2026-11-19)

- **Contracts cannot hold or move PLTs.** `concordium-std` 11.0.0 (latest) has no PLT host functions. The pool is a dedicated insurer **treasury account**; the contract holds the rules and the books.
  - Production path: **Protocol-Level Locks: Enhanced (roadmap Mar 2027)**, where every lock function is authorised by a smart contract returning true/false. The pool then sits in a lock that only our `claimsAuthorized` view can release.
- **x402 Concordium facilitator accepts exactly one token operation** (`operations.length !== 1` rejected). So the premium cannot ride inside the shop payment. The insurer is its own x402 service.
- **EUDemo is allow-listed.** The insurer treasury must prove EU nationality and be allow-listed (use `scripts/allowlist.ts`; add an `insurer` profile, NL). Each account gets 100 EUDemo from the faucet; premiums add to the pool.
- Testnet only; deadline 2026-12-09 23:59 UTC; Windows dev environment; pnpm monorepo, Node 22+, TypeScript, Rust contracts with `concordium-smart-contract-testing`.

## Approaches considered (premium model)

| Option | What | Trade-off | Decision |
|---|---|---|---|
| A. Period cover | Owner buys e.g. 30 days, limit €100, via one x402 call | Simple, smooth demo, natural "agent is insured" status | **Chosen** |
| B. Per-order top-up | Agent buys extra cover for one order via x402 before paying | Machine-native, granular; adds a second x402 call per purchase | **Chosen, only for orders above the period limit or flagged high-value** |
| C. Merchant pays | Like a card chargeback fee | Realistic business model, but loses "agent insures itself" | Rejected for the demo; mentioned as a production revenue model |

## Actors and accounts

| Actor | Account (testnet profile) | Role |
|---|---|---|
| Owner | `alice#0`, `teen#0` (existing) | Holds mandate and policy; sets agent metadata |
| Buyer agent | `alice#1`, `teen#1` (existing) | Pays premiums and purchases from its own EUDemo |
| Shop | `merchant#0` payTo, `merchant#1` facilitator/recorder (existing) | Requires cover above a threshold; can be a claimant |
| Insurer treasury | `insurer#0` (new, NL, allow-listed) | Holds the EUDemo pool; payTo for premiums; source of payouts |
| Insurer operator | `insurer#1` (new) | Writes policies/claims to the cover contract; sponsors fees; x402 facilitator for the insurer service |
| Claims handler | Human, via console | Approves or rejects assessed claims |

## The design

### 1. Cover contract (`contracts/kuasa-cover`, new Rust crate)
State, keyed by sequential `u64` ids:
- `Policy { holder, agent_payer, agent_registry, agent_token, mandate: MandateKey, kind: Period | Order(order_hash), limit, deductible, premium, premium_tx, valid_from, valid_until, paid_out, status: Active | Cancelled }`
- `Claim { policy_id, claimant, kind: NonDelivery | WrongItem | MerchantLoss, amount, evidence (hash), receipt_order (Option<hash>), status: Filed | Assessed{ok, reason_hash} | Approved | Rejected | Paid{payout_tx} | Fraud{disclosure_hash}, decided_by }`

Entry points:
- `init(operator)`.
- `issuePolicy` (operator only). Before writing, it **invokes `kuasa.view` on the mandate registry** (contract-to-contract) and checks: the mandate exists, is not revoked, its owner is the holder, its payer is the agent payer. The limit must be ≤ the mandate's `max_total`.
- `fileClaim` (anyone; the policy holder for buyer claims, a merchant for `MerchantLoss`).
- `assessClaim` (operator: records the rule-based outcome).
- `decideClaim` (operator, on the claims handler's explicit approval in the console; approve/reject).
- `recordPayout` (operator, payout tx hash; enforces `paid_out + amount ≤ limit`).
- `markFraud` (operator, disclosure-request hash).
- `cancelPolicy` (holder).
- Views: `policy`, `claim`, `policiesOf(holder)`, and **`claimsAuthorized(claim_id) -> bool`**. That last one is the function a future Enhanced Lock would call to release pool funds.

Events for every state change (for the console and explorer). Tests are in-crate with `concordium-smart-contract-testing`, including the cross-contract mandate check (deploy both modules in the test chain).

### 2. Risk engine (`packages/cover`, TypeScript, pure)
`quote(input) → { premium, factors: [{ name, effect, reason }] }`. All rules live in one table, unit-tested.

| Factor | Rule (initial) |
|---|---|
| Base rate | 2% of limit per 30 days |
| Mandate tightness | `maxPerOrder / limit`: ≤ 0.25 → ×0.8, ≤ 0.5 → ×0.9, else ×1.0; merchant allowlist present → ×0.9 |
| Category risk | groceries ×1.0, wine ×1.2, vape ×1.4; unknown → refuse quote |
| Proven attributes | Age + residency proven in a verified V&A record → ×0.9 |
| Owner kind | business (LEI) → ×0.85 |
| History (mandate registry) | each incident +25%, each 5 claim-free receipts −5% (floor ×0.7) |
| Order top-up (B) | `max(1.5% of order, minimum €0.10)`; only above period limit headroom |

Inputs are read from chain/proofs by the insurer service, never trusted from the client.

### 3. Insurer service (`packages/insurer`, Express, port 4023)
- `GET /cover/quote?agent=<payer>&limit=&days=` (free): risk engine with factor breakdown. Reads the mandate (via `x-kuasa-mandate`), verifies the V&A proof (reusing `verifyMandateProof`), reads the history.
- `GET /cover/buy?...` (**x402, price = quoted premium, EUDemo, payTo = treasury**). A `KuasaGuard`-style before-verify hook re-checks the quote and the payer = mandate payer. After settlement it calls `issuePolicy` and returns the policy id.
- `GET /cover/order?order=<hash>&amount=` (x402): per-order top-up policy (option B).
- `POST /claims`: files the claim on-chain, runs the **assessor** (rules below) and records `assessClaim`.
- `POST /claims/:id/decision` (console only, same localhost + custom-header protection as the current console): `decideClaim`. If approved, it pays from the treasury (sponsored EUDemo transfer, memo = `kuasa-claim:<id>`), then calls `recordPayout`.
- Fraud: on a rejected claim with no on-chain evidence, if the same holder has ≥ 2 such rejections, it generates a disclosure-request JSON (claim, account, evidence, legal-basis text), anchors its hash with `markFraud`, and links it in the console.

**Assessor rules:**
- `NonDelivery` / `WrongItem` is approved-eligible iff a receipt exists in the mandate registry events with `order == receipt_order` and `payment_tx` finalized, inside the policy period, amount ≤ receipt amount − deductible, and no prior paid claim on that order.
- `MerchantLoss` requires a receipt plus a filed incident on the mandate.
- Everything else → reject, with the reason.

### 4. Agent registry status and two-way checks
- After a policy is issued, the owner's account sets agent metadata `kuasa:cover` = `{policyId, limit, until, contract}` via `CIS-8004.setMetadata` (sponsored by the insurer operator). The Agent Card (published JSON, hash pinned via `setAgentURI`) gains a Kuasa extension: mandate URL and cover contract.
- The shop's guard gains:
  - **(a)** an agent-registry check: `agentOf(token)` active, owner = mandate principal, token = mandate token (closes the current gap);
  - **(b)** a cover check for offers with `requirements.minCover`: an active policy covering the order amount, from the contract (metadata is the discovery hint, the contract is the source of truth).
- The shop registers its own agent entry + card. The buyer agent client checks the shop's payTo belongs to an active registered agent before paying.

### 5. Audit trail
The shop guard and the insurer service append decisions to a local log. Every 60 s, if non-empty, they anchor `sha256(batch)` via `registerData` and keep the batch file plus tx hash (shown in the console).

### 6. MCP and console
- MCP tools: `cover_quote`, `cover_buy`, `cover_status`, `file_claim` (plus the existing four).
- Console pages: policies (per agent), pool (treasury EUDemo balance, premiums in, payouts out), claims queue (assessment shown, Approve/Reject buttons), audit anchors.

### 7. Demo storyline (3 min target)
1. Problem: the shop requires cover ≥ €20 for wine; alice's uninsured agent is refused.
2. Alice's agent quotes cover (factor breakdown), buys 30-day cover for €100 via x402. The policy appears on-chain and in the agent's registry metadata.
3. It buys wine (€24). The guard checks mandate + proof + registry + cover. Receipt anchored.
4. The shop never delivers. The agent files a claim; the assessor matches the on-chain receipt; the claims handler approves in the console; €24 minus deductible is paid in EUDemo.
5. The teen's agent files a claim for an order that never happened → rejected; the repeat → fraud flag + anchored disclosure request.
6. Close: the production path (Enhanced Locks pool, fronting insurer, Agent IDP + KYCaaS/AML/liveness as underwriting inputs, EURQ).

## Decisions after the builder check (designer's calls, open to change)

1. **Order identity before payment (option B).**
   - The shop's free `/quote` returns an `orderRef = sha256(payer, payTo, route, amount, nonce)` valid for 10 min.
   - The agent buys top-up cover for that `orderRef`, then pays, sending `x-kuasa-order: <orderRef>`.
   - The guard's receipt `order` hash becomes `sha256(orderRef ‖ settlement tx)`, and the `orderRef` is kept in the receipt log. Off-chain change only: the registry stores a hash either way.
   - `Policy.kind = Order(orderRef)`. Claims match via `orderRef`.
2. **Premiums are spending under the mandate.** Mandates are reissued with:
   - the insurer treasury in `merchants`,
   - category `insurance`,
   - the insurer operator in `recorders`,
   - `max_total` raised to 150 EUDemo.

   Premiums record a receipt and draw down the budget like any purchase. An agent never spends outside its mandate. The cover limit stays ≤ the mandate's `max_total`.
3. **Claimant and signing.**
   - The agent's payer account (or a merchant, for `MerchantLoss`) signs `fileClaim` itself, sponsored by the insurer operator. No unauthenticated HTTP filing.
   - The contract checks that the claimant is the policy's agent payer or holder (buyer claims), or the merchant on the receipt (`MerchantLoss`).
   - The insurer service only assesses. Fraud is counted **per holder (owner)**, since the owner is the accountable party.
4. **Payout recipient.**
   - Buyer claims are paid to the **agent's payer account**: the refund returns where the money left, and that account is already allow-listed.
   - `MerchantLoss` is paid to the merchant payTo.
   - Production: the holder chooses a payout account.

## Build order and cut line (proposal, pending user confirmation)

**Must have, in order:**
1. Cover contract + tests.
2. Risk engine.
3. Insurer service with period cover (A) + reissued mandates.
4. Guard: agent-registry check + cover check.
5. Claims flow (file → assess → console approve → payout → record).
6. MCP cover tools.
7. Console: policies, pool, claims.
8. Registry metadata `kuasa:cover`.

**Cut first if time runs short, in this order:**
1. Audit anchoring.
2. Shop's own registry entry + two-way check.
3. Agent Card extension.
4. Fraud disclosure document (keep the plain rejection).
5. Per-order top-up (B).

## Decided by the user
- Direction: Kuasa Cover (insurance on top of Kuasa), keeping all existing tech and adding more.
- Premium model: A (period) + B (per-order top-up for high value).

## Left to the builder
- Exact Rust layout of keys/maps; event schemas; energy limits.
- The risk-table numbers (the starting values above may be tuned for a clean demo).
- Exact `CIS-8004.setMetadata` parameter encoding and **who may call it**. Verify by dry-run; if only the token owner may, the owner signs (sponsored).
- Whether `kuasa.view` cross-contract invocation needs the registry address in init or per call.
- The audit batch interval and file layout.
- How the shop "never delivers" is simulated (e.g. a `/shop/scam/*` product).
