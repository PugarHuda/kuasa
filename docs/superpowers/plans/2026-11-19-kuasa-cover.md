# Kuasa Cover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add insurance for AI agent commerce (policies, risk-priced premiums over x402, claims with human approval, EUDemo payouts, insured status in the CIS-8004 registry) on top of the existing Kuasa mandate stack.

**Architecture:**
- A new Rust contract `kuasa-cover` holds policies and claims, and checks mandates via a read-only cross-contract call to the deployed `kuasa` registry.
- A new x402 insurer service prices cover with a pure risk engine, sells it, and assesses claims against on-chain receipt events. Payouts come from an allow-listed treasury account.
- The existing guard, agent, MCP and console are extended.
- The existing identity/spend layer sits behind two swappable interfaces.

**Tech Stack:**
- Rust: concordium-std 11, concordium-smart-contract-testing 5.
- TypeScript (Node 22+, tsx).
- @concordium/web-sdk 12.0.2; @x402/* 2.31.0; express 5; @modelcontextprotocol/sdk.
- pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-19-kuasa-cover-design.md`

## Global Constraints

- Testnet only. Network CAIP-2 `ccd:4221332d34e1694168c2a0c0b3fd0f27`, SDK network `'Testnet'`.
- Asset `EUDemo` (6 decimals), env `KUASA_ASSET`. Amounts are atomic `bigint`/`u64`.
- Contracts cannot hold PLTs. The pool is the `insurer#0` treasury account. The contract holds the books only.
- The x402 facilitator accepts exactly one token operation. Premiums are a separate x402 purchase from the insurer service (port 4023).
- No payout without an explicit human approval in the console. No LLM decides money.
- Non-delivery is not covered. Claim kinds: `AgentMistake | WrongItem | MerchantLoss`.
- Premiums are spending under the mandate:
  - the treasury is in `scope.merchants`,
  - `insurance` is in `scope.categories`,
  - the insurer operator is in `recorders`,
  - `maxTotal` = 150 EUDemo.
- Buyer-claim payouts go to the agent payer account; `MerchantLoss` payouts go to the merchant payTo.
- Fraud is counted per holder (owner). After ≥ 2 rejected no-evidence claims, a disclosure request is anchored.
- Security patterns already in the repo are kept for every new endpoint:
  - signing endpoints are localhost-bound,
  - the Host check and the `x-kuasa-console: 1` header are required,
  - `safeFetchText` with `localOrigin` is used for documents,
  - rendered values are escaped.
- Git Bash on Windows: run CLIs with `MSYS_NO_PATHCONV=1`.
- Commit after every task with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer. Never commit `.kuasa/` or `docs/research/`.

## Review Focus

1. **Premium settled but `issuePolicy` fails** (chain error, mandate revoked meanwhile). The agent paid and must not be silently uninsured. Expect: an unissued record, a retry, and a console warning (Task 6 test `premium settled, issuance failed → unissued + retry`).
2. **Claim on an order paid after the mandate was revoked, or outside the policy period.** Expect: rejection with a reason (Task 5 test `rejects receipt after revoke or outside period`).
3. **Same order claimed twice, or a claim exceeding the remaining limit.** Expect: the contract rejects (Task 1 tests `duplicate order claim rejected`, `payout over limit rejected`).
4. **Buy price differs from a fresh server-side quote** (a tampered or stale quote). Expect: abort before payment (Task 6 test `buy aborts when amount != fresh quote`).
5. **Treasury balance below the approved payout.** Expect: the decision is stored as approved but not paid, the console shows "insufficient pool", and nothing is sent (Task 6 test `approve with empty pool does not pay`).

---

### Task 1: `kuasa-cover` contract

**Files:**
- Create: `contracts/kuasa-cover/{Cargo.toml,src/lib.rs,tests/tests.rs}` (same Cargo/profile layout as `contracts/kuasa-registry`)

**Interfaces:**
- Consumes: the deployed `kuasa` registry entrypoint `kuasa.view(MandateKey) -> Option<MandateEntry>`. Mirror `MandateKey`/`MandateEntry` with identical field order in this crate. Do **not** depend on the registry crate, because its exports would be linked in.
- Produces (contract name `kuasa_cover`):
  - `init(InitParams { operator: AccountAddress, registry: ContractAddress })`
  - `issuePolicy(IssuePolicy { holder, agent_payer, agent_token: String, mandate: MandateKey, kind: PolicyKind, limit: u64, deductible: u64, premium: u64, premium_tx: HashSha2256, valid_until: Timestamp }) -> u64`, operator only. `PolicyKind = Period | Order(HashSha2256)`. Rejects unless the mandate exists, `!revoked`, `owner == holder`, `payer == agent_payer`, `limit <= max_total`.
  - `fileClaim(FileClaim { policy_id, kind: ClaimKind, amount, evidence: HashSha2256, orders: Vec<HashSha2256> /*1..=2*/ })`. The sender must be the policy's `agent_payer` or `holder` (buyer kinds), or any account for `MerchantLoss`. Rejects if any `(policy_id, order)` was already claimed.
  - `assessClaim { claim_id, ok: bool, reason: HashSha2256 }`, `decideClaim { claim_id, approve: bool }`, `recordPayout { claim_id, payout_tx: HashSha2256, amount }` (requires Approved, `paid_out + amount <= limit`), `markFraud { claim_id, disclosure: HashSha2256 }`: all operator only. `cancelPolicy(policy_id)`: holder only.
  - Views: `policy(u64) -> Option<Policy>`, `claim(u64) -> Option<Claim>`, `coverOf(CoverQuery { payer, order: Option<HashSha2256> }) -> CoverView { period_remaining: u64, order_limit: u64, policy_id: Option<u64> }` (active, not expired at slot time), `claimsAuthorized(u64) -> bool` (status Approved and unpaid).
  - Events for every state change: `PolicyIssued`, `ClaimFiled`, `ClaimAssessed`, `ClaimDecided`, `ClaimPaid`, `ClaimFraud`, `PolicyCancelled`.

- [ ] **Step 1: Write the failing tests** in `tests/tests.rs`. Deploy both `kuasa-registry/concordium-out/module.wasm.v1` and this module. Tests:
  - `issue_requires_active_matching_mandate`: revoked / wrong holder / limit > max_total → Err.
  - `period_cover_view`: `coverOf` returns the limit, then 0 after `valid_until`.
  - `claim_lifecycle`: file → assess → decide(approve) → `claimsAuthorized == true` → recordPayout → paid; `claimsAuthorized == false`.
  - `duplicate order claim rejected`.
  - `payout over limit rejected`.
  - `only payer/holder may file buyer claims`.
  - `operator-only entrypoints reject others`.
- [ ] **Step 2:** `cd contracts/kuasa-cover && cargo concordium test`. Expected: FAIL (not implemented).
- [ ] **Step 3:** Implement `src/lib.rs`. The registry call is `host.invoke_contract_read_only(&registry, &key, EntrypointName::new_unchecked("view"), Amount::zero())`, deserializing `Option<MandateEntry>`.
- [ ] **Step 4:** `cargo concordium test` → all PASS; `cargo concordium build --out concordium-out/module.wasm.v1 --schema-embed`.
- [ ] **Step 5:** Commit `feat(cover): policy and claims contract with mandate cross-check`.

### Task 2: TypeScript codec + chain client for the cover contract

**Files:**
- Create: `packages/core/src/cover.ts` (export from `index.ts`); test `packages/core/test/cover.test.ts`
- Modify: `packages/chain/src/index.ts` (add `KuasaCover`)

**Interfaces:**
- Produces in core:
  - Types `Policy`, `Claim`, `ClaimKind`, `CoverView`.
  - Encoders `encodeIssuePolicy`, `encodeFileClaim`, `encodeAssess`, `encodeDecide`, `encodePayout`, `encodeFraud`, `encodeCoverQuery`.
  - Decoders `decodePolicy`, `decodeClaim`, `decodeCoverView`.
  - `decodeRegistryEvents(bytes: Uint8Array): RegistryEvent[]` for kuasa-registry events. Tags: 0 Issued, 1 Revoked, 2 Receipt `{owner,id,order,paymentTx,amount,spent}`, 3 Incident.
- Produces in chain: `class KuasaCover(grpc, index)`:
  - writes: `issuePolicy`, `fileClaim(p, claimant: Wallet, sponsor: Wallet)`, `assess`, `decide`, `recordPayout`, `markFraud`;
  - reads: `policy(id)`, `claim(id)`, `coverOf(payer, order?)`, `claimsAuthorized(id)`.
- Produces in chain: `receiptEventsOfTx(grpc, txHash): RegistryEvent[]`, which reads a finalized tx summary and decodes `kuasa-registry` `Updated` events.

- [ ] **Step 1:** Write the round-trip tests. Each encoder's bytes must equal the hex produced by the contract test vectors. Export the vectors from Task 1 tests the way `kuasa-registry/tests/tests.rs` `TS_ISSUE` does. Also `decodeRegistryEvents` on a Receipt event vector.
- [ ] **Step 2:** `pnpm --filter @kuasa/core test` → FAIL.
- [ ] **Step 3:** Implement with the existing `W`/`R` writer/reader in `registry.ts`. Export them from that module rather than duplicating.
- [ ] **Step 4:** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(cover): TS codec and chain client`.

### Task 3: Risk engine (`packages/cover`)

**Files:**
- Create: `packages/cover/{package.json,tsconfig.json,src/risk.ts,src/index.ts,test/risk.test.ts}`

**Interfaces:**
- Produces: `quote(input: RiskInput): Quote | { refused: string }`.
  - `RiskInput = { limit: bigint; days: number; mandate: { maxPerOrder: bigint; categories: string[]; merchants?: string[] }; provenAgeAndResidency: boolean; ownerKind: 'person'|'business'; incidents: number; receipts: number; order?: { amount: bigint } }`
  - `Quote = { premium: bigint; factors: { name: string; multiplier: number; reason: string }[] }`

- [ ] **Step 1:** Test table, with values from the spec:
  - base 2% of limit per 30 days, pro-rata by `days`;
  - tightness `maxPerOrder/limit` ≤ 0.25 → ×0.8, ≤ 0.5 → ×0.9, else ×1.0;
  - merchants allowlist → ×0.9;
  - highest category multiplier among `{groceries 1.0, wine 1.2, vape 1.4, insurance 1.0}` (unknown → refused);
  - proven → ×0.9; business → ×0.85;
  - +25% per incident; −5% per 5 receipts, floor ×0.7;
  - order top-up = `max(1.5% of amount, 100_000)`.
  - Golden case: limit 100 EUDemo, 30 days, maxPerOrder 50, merchants set, categories wine, proven, person, 0/0 → premium `100_000_000n * 2/100 * 0.9 * 0.9 * 1.2 * 0.9` rounded to an integer atomic.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with integer math in atomic units (multiply by basis points, not floats). **Step 4:** PASS. **Step 5:** Commit `feat(cover): rule-based risk engine`.

### Task 4: Swappable foundations + guard hardening + orderRef

**Files:**
- Create: `packages/merchant/src/foundations.ts`
- Modify: `packages/merchant/src/guard.ts`, `packages/merchant/test/guard.test.ts`, `packages/shop/src/server.ts`

**Interfaces:**
- Produces:
  - `interface IdentitySource { claims(m: Mandate): Promise<{ok:true;claims:Claims}|{ok:false;reason:string}> }`, implemented as `MandateProofIdentity` (wraps `verifyMandateProof`).
  - `interface SpendControl { state(m: Mandate, id: string): Promise<MandateState|null> }`, implemented as `MandateRegistrySpend` (wraps `KuasaRegistry.view` + `toMandateState`).
  - `interface AgentRegistry { agentOf(token: string): Promise<{ owner: string; active: boolean } | null> }`, implemented as `Cis8004Registry(grpc)`. It parses `CIS-8004.agentOf` with the embedded schema loaded once at start from `getInstanceInfo(<12802,0>).sourceModule` and `getEmbeddedSchema`, using `deserializeReceiveReturnValue`.
  - `interface CoverCheck { coverOf(payer: string, order?: string): Promise<CoverView> }`, implemented by `KuasaCover`.
- `KuasaGuard` options gain `identity?`, `spend?`, `agents?: AgentRegistry`, `cover?: CoverCheck`. `Offer.requirements` gains `minCover?: bigint`.
- `ORDER_HEADER = 'x-kuasa-order'`.
- `decide()` returns `orderRef`. The `/quote` response includes `orderRef = sha256(canonicalJson({payer,payTo,route,amount,nonce}))`, cached for 10 min. The receipt `order` becomes `sha256(orderRef + paymentTx)`.

- [ ] **Step 1:** Add tests:
  - `rejects agent token not active / owner != principal`;
  - `minCover: refused without cover, allowed with period cover >= amount, allowed with order cover for header orderRef`;
  - `receipt order binds orderRef`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Default `identity`/`spend` to the existing behaviour so the current tests stay green. The shop's wine offers get `minCover: 20n * UNIT`; the shop constructs `Cis8004Registry` and `KuasaCover`.
- [ ] **Step 4:** `pnpm test && pnpm typecheck` PASS. **Step 5:** Commit `feat(guard): agent-registry and cover checks, swappable foundations, orderRef`.

### Task 5: Claim assessor (pure)

**Files:**
- Create: `packages/cover/src/assess.ts`, `packages/cover/test/assess.test.ts`

**Interfaces:**
- Produces: `assess(input): { ok: boolean; reason: string; payout: bigint }`.
  - `input = { claim: { kind, amount, orders: string[] }, policy: { validFrom, validUntil, limit, paidOut, deductible, mandateId, owner }, receipts: { order: string; amount: bigint; at: number; mandateId: string; owner: string }[], revokedAt?: number, priorPaidOrders: string[], incidentFiled: boolean }`.
- Rules:
  - receipts must belong to the policy's mandate and be inside `[validFrom, min(validUntil, revokedAt)]`;
  - `AgentMistake` needs 2 receipts, equal amount, ≤ 10 min apart;
  - `WrongItem` needs 1 receipt;
  - `MerchantLoss` needs 1 receipt and `incidentFiled`;
  - payout = `min(claim.amount, receipt amount) − deductible`, capped at `limit − paidOut`;
  - reject if an order is in `priorPaidOrders`.

- [ ] **Step 1:** Tests:
  - one approve case per kind;
  - `rejects receipt after revoke or outside period`;
  - `rejects foreign mandate receipt`;
  - `AgentMistake needs two matching receipts`;
  - `caps payout at remaining limit`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(cover): claim assessor rules`.

### Task 6: Testnet provisioning + insurer service

**Files:**
- Modify: `scripts/provision.ts` (add `insurer: NL, 2 accounts`), `scripts/allowlist.ts` (add `['insurer', 0]`), `scripts/setup.ts`. Setup changes: deploy + init `kuasa-cover` with `{operator: insurer#1, registry}`; mandates reissued per the Global Constraints; state gains `cover`.
- Create: `packages/insurer/{package.json,tsconfig.json,src/server.ts,src/service.ts,test/service.test.ts}`

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 5.
- Produces: HTTP on 4023.
  - `GET /cover/quote?limit=&days=&order=&amount=` (needs `x-kuasa-mandate`; returns `Quote` + `quoteId`).
  - `GET /cover/buy?quoteId=` (x402, price = the quote's premium, payTo = treasury). `onBeforeVerify`: fresh re-quote must equal, payer must = mandate payer, plus the KuasaGuard checks. `onAfterSettle`: `recordReceipt` (category insurance) then `issuePolicy`; on failure push to `unissued` and retry ×3.
  - `POST /claims/assess { claimId }`: reads the claim, the policy and the receipt events of the evidence txs (`receiptEventsOfTx`), runs `assess`, writes `assessClaim`, updates the fraud counter, and on the 2nd no-evidence rejection writes a disclosure JSON to `.kuasa/disclosures/` plus `markFraud`.
  - `POST /claims/:id/decision { approve }`: localhost + `x-kuasa-console`. Approve checks the treasury EUDemo balance first, then pays with a sponsored transfer (memo `kuasa-claim:<id>`) to the agent payer or the merchant, then `recordPayout`.
  - `GET /state`: policies, claims, pool balance, premiums in, payouts out, unissued.
- Service logic lives in `service.ts` as `class InsurerService` with injected chain clients, so it is testable with fakes.

- [ ] **Step 1:** Tests with fakes:
  - `buy aborts when amount != fresh quote`;
  - `premium settled, issuance failed → unissued + retry`;
  - `approve with empty pool does not pay`;
  - `second no-evidence rejection anchors disclosure`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Testnet run:
  - `provision.ts insurer`, `allowlist.ts`, `setup.ts --reissue alice teen`;
  - start shop + insurer;
  - `curl` the quote. Expected: a quote with factors.
- [ ] **Step 6:** Commit `feat(insurer): x402 cover sales, claim assessment, payouts`.

### Task 7: Registry status, Agent Cards, two-way trust

**Files:**
- Modify: `scripts/setup.ts` (register the shop's agent; state `shopAgent`), `packages/insurer/src/service.ts` (after `issuePolicy`, the owner sets `CIS-8004.setMetadata(kuasa:cover = {policyId,limit,until,contract})`, sponsored by the operator; owner keys come from the demo profile, as in `console`)
- Create: `packages/shop` route `/.well-known/agent-card.json`; agent cards gain `extensions.kuasa = { mandate, cover: "<index,0>" }`, re-pinned with `setAgentURI` + hash
- Modify: `packages/agent/src/client.ts` (before paying, the shop's payTo must own an active agent token named in its card)

- [ ] **Step 1:** Dry-run `setMetadata` and `setAgentURI` with the embedded schema to learn the exact params and who may call them (the spec leaves this to the builder). Record the finding in a code comment.
- [ ] **Step 2:** Implement. Test in `packages/agent`: `refuses shop whose payTo has no active agent`, with a fake registry.
- [ ] **Step 3:** Testnet: after a cover purchase, read `CIS-8004.getMetadata(token, "kuasa:cover")`. Expected: the policy JSON.
- [ ] **Step 4:** Commit `feat: insured status in agent registry, agent cards, two-way trust`.

### Task 8: Agent + MCP cover tools

**Files:**
- Modify: `packages/agent/src/{client.ts,cli.ts,mcp.ts}`

**Interfaces:**
- Produces on `KuasaAgent`:
  - `coverQuote(limit, days, order?)`, `coverBuy(limit, days)`, `coverForOrder(path)`, `coverStatus()`, `fileClaim(kind, receiptTxs[], amount, note)`. The claim is signed by the payer and sponsored by the insurer operator via the insurer's `/claims/sponsor` endpoint, which co-signs only `fileClaim` transactions to the cover contract.
  - `buy(path, { twice?: boolean })`.
- The insurer's `scope` must be in the agent's local mandate copy (the agent's own policy filter in `withinMandate` already applies).
- CLI: `cover-quote | cover-buy | cover-status | claim <kind> <tx...>`, plus `buy --twice`.
- MCP tools: `cover_quote`, `cover_buy`, `cover_status`, `file_claim`.

- [ ] **Step 1:** Test: `fileClaim is refused by sponsor endpoint for non-fileClaim tx` (insurer test).
- [ ] **Step 2:** Implement. **Step 3:** Testnet:
  - uninsured wine buy → refused `cover required`;
  - `cover-buy 100 30` → policy id;
  - `buy --twice /shop/wine/rioja` → 2 receipts;
  - `claim AgentMistake <receiptTx1> <receiptTx2>` → claim id, assessed ok.
- [ ] **Step 4:** Commit `feat(agent): cover tools in client, CLI and MCP`.

### Task 9: Console pages

**Files:**
- Modify: `packages/console/src/{server.ts,console.html}`

- [ ] **Step 1:** Add `/api/cover` (proxies the insurer `GET /state`) and `POST /api/claims/:id/decision` (forwards to the insurer with the header). Keep the Host + header guard.
- [ ] **Step 2:** UI sections:
  - **Policies**: agent, limit, used, until, premium tx;
  - **Pool**: treasury balance, premiums in, payouts out;
  - **Claims queue**: kind, amount, evidence links, assessment reason, Approve/Reject; "insufficient pool" state;
  - **Unissued premiums** warning;
  - **Audit anchors** (Task 10).
  
  Escape every value; explorer links via `safeUrl`, `/transaction/`.
- [ ] **Step 3:** Verify with a Playwright screenshot (`.playwright-mcp/`). Approve the claim from Task 8 in the UI. Expected: payout tx link + `paid` state.
- [ ] **Step 4:** Commit `feat(console): policies, pool, claims queue`.

### Task 10: Audit anchoring

**Files:**
- Create: `packages/chain/src/audit.ts` (export from `index.ts`)
- Modify: the shop and insurer to append decisions

**Interfaces:**
- Produces: `class AuditLog(grpc, wallet: Wallet, dir: URL, intervalMs = 60_000)` with `append(record: unknown)`, `flush(): Promise<{tx: string; file: string} | null>`, and `anchors()`. It writes `.kuasa/audit/<iso>.json` and anchors `sha256(canonicalJson(batch))` via `registerData`.
- [ ] **Step 1:** Test: `flush with empty batch is a no-op; batch hash matches file content` (fake register).
- [ ] **Step 2–4:** Implement, wire into the shop + insurer, show in the console. **Step 5:** Commit `feat: anchored audit batches (EU AI Act Art. 12)`.

### Task 11: Docs, testnet evidence, Encode description

**Files:**
- Modify: `README.md` (Kuasa Cover framing, run guide, honesty notes: treasury not PLL, simulated disclosure, illustrative pricing, commits before 19 Nov), `docs/TESTNET.md` (cover contract, premium, policy, duplicate order, claim, approval, payout, fraud)
- Create: `docs/PRODUCTION.md`:
  - PLL Enhanced pool;
  - fronting insurer / MGA;
  - Agent IDP, KYCaaS, AML, liveness as underwriting inputs;
  - EURQ;
  - Dfns/WDK custody;
  - costs per policy and claim.

- [ ] **Step 1:** Full testnet run of the demo storyline (spec §7). Collect tx hashes; verify every explorer link returns 200 (same curl loop as before).
- [ ] **Step 2:** Write the docs. Update the Encode project description (same Supabase-backed form, verify by reading the saved value).
- [ ] **Step 3:** `pnpm test && pnpm typecheck` and `cargo concordium test` for both contracts → all PASS. Push to `origin/main`.
- [ ] **Step 4:** Commit `docs: Kuasa Cover README, TESTNET, PRODUCTION`.
