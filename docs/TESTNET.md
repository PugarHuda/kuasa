# Kuasa on Concordium testnet

Everything below is on testnet and can be opened in CCDExplorer. Base URL: `https://ccdexplorer.io/testnet`.

## Contracts

| What | Address | Link |
|---|---|---|
| Kuasa registry (our contract) | `<13065,0>` | [instance](https://ccdexplorer.io/testnet/instance/13065/0) |
| Module deploy | `7a7c03f0…1031a` | [tx](https://ccdexplorer.io/testnet/transaction/221a2e727643c5b94e11c327b89ffca9a5ad263ed5cc645ecb1180cf590fe694) |
| Registry init | | [tx](https://ccdexplorer.io/testnet/transaction/24550535f602ee998d0f0ebd8886485adfbb4432d7bcc9df8be15c205f9ca53e) |
| CIS-8004 Agent Registry (Concordium) | `<12802,0>` | [instance](https://ccdexplorer.io/testnet/instance/12802/0) |
| **Kuasa Cover** (our contract) | `<13066,0>` | [instance](https://ccdexplorer.io/testnet/instance/13066/0) |
| Cover module deploy | `b634ea58…009d` | [tx](https://ccdexplorer.io/testnet/transaction/e8e1f98817cd2e55792d672b7964af721f4e9a384da4cde5381831cd8de447df) |
| Cover init (operator = insurer #1, registry = `<13065,0>`) | | [tx](https://ccdexplorer.io/testnet/transaction/b75fecb7c4e64b01fbc91c4f6b12a2ee90e4e49d756805b493a3817cf720eae6) |

## Accounts

All identities come from the testnet identity provider with invented attributes. Every owner and their agent's payer account are created from the **same** identity, so the agent's spending stays accountable to that person.

| Role | Attributes | Account |
|---|---|---|
| Alice, owner | adult, DK resident and national | [4Wmdhh…o1aq3s](https://ccdexplorer.io/testnet/account/4WmdhhLRPTk92STxiaXQFFNyJFLaM6k5kRq1ryFN8xjho1aq3s) |
| Alice's agent (payer) | same identity | [4DRGyL…uhXKLc](https://ccdexplorer.io/testnet/account/4DRGyL6GkXQXs8CT7KovczM9SbwVgn8KsKAvQtFt4G4puhXKLc) |
| Teen, owner | 16 years old, DK | [4j733X…u8huDH](https://ccdexplorer.io/testnet/account/4j733XjURhA9UFkxfNbZHsKpRSMvnbQjJyjbbMHUKuzMu8huDH) |
| Teen's agent (payer) | same identity | [4Gw69U…ys4oqg](https://ccdexplorer.io/testnet/account/4Gw69UEYtxxE1EroXsp3AwAZWa38cKCuQZCgs9HYLc1Xys4oqg) |
| Shop (payTo) | NL | [34BwTu…KrPKv](https://ccdexplorer.io/testnet/account/34BwTuaAu2EsgHNj3Us9TrYUNbKGo6Wnh3ixxUSanrca7KrPKv) |
| Shop facilitator (fee sponsor, receipt recorder) | NL; allow-listed later for merchant-loss payouts | [4HeXqT…q32UNp](https://ccdexplorer.io/testnet/account/4HeXqTdciL1dVAaNZ6kiVRAH3syJcDnFtqLM3z3phWbAq32UNp) |

| Insurer treasury (EUDemo pool) | NL, allow-listed ([tx](https://ccdexplorer.io/testnet/transaction/328f937f9fbaff7787715b798369331f8c442be90f5c5823b8adc5524cc1f3cf)) | [3z1Xbe…LmBut](https://ccdexplorer.io/testnet/account/3z1Xbe1xvT256jjptnBBPNQzESMM3xv8CYV45gEDu4PnkLmBut) |
| Insurer operator (policies, claims, fee sponsor) | NL, never allow-listed | [4Tw9uz…TZzJ](https://ccdexplorer.io/testnet/account/4Tw9uzZZSQmbLytV8XqRYU5dCDyrhu8yWU2xwvXovaS54sTZzJ) |

## Kuasa Cover, transaction by transaction

| Step | What happened | Link |
|---|---|---|
| Mandates reissued for Cover | Treasury added as allowed merchant, category `insurance`, insurer operator as recorder, budget 150 EUDemo | alice [tx](https://ccdexplorer.io/testnet/transaction/bbef79112d1263d1aa44f5eb6a366eefd948a1b3f888d8ad949354d0b24a57d0), teen [tx](https://ccdexplorer.io/testnet/transaction/1ca36e9bb90867b8497f9bf8df1167c5494917153604017234baf4a2115d9705) |
| Shop registers its own agent | CIS-8004 token `f304…`; buying agents check it is active and owned by the payTo before paying | [tx](https://ccdexplorer.io/testnet/transaction/425a212049ed240fd06c7b27e19034388a260fe379745f93fa7b4e0728160e73) |
| Uninsured agent refused | Wine needs cover: `cover required: 24000000 needed, 0 available`, before any payment | – |
| Alice's agent buys period cover | Premium 1.7496 EUDemo over x402 (base 2%, tightness 0.9, allowlist 0.9, wine 1.2, proven attributes 0.9); policy #0, 100 EUDemo, 30 days | premium [tx](https://ccdexplorer.io/testnet/transaction/43bb75467de60dc7415faa3802baecef91c0369a61be81ac19eb8ff687d4c2f3) |
| Owner publishes the insured status | `kuasa:cover = policy=0;limit=100000000;cover=13066.0` in the agent's CIS-8004 metadata | [tx](https://ccdexplorer.io/testnet/transaction/f911263f55a339ad7b8b3baa99506fe17f7ce2b9388390293e525f448512627a) |
| The agent's mistake | Same wine ordered twice, both insured purchases | payments [tx](https://ccdexplorer.io/testnet/transaction/fd67b7ac77577ab91e9dc0c6d3d2992f8c680b99288b8ffb7cfc6f62977bcedd) [tx](https://ccdexplorer.io/testnet/transaction/fe8627036fb93a109a3f447067b5b6edb61179461363fabed5611959caaa18cd), receipts [tx](https://ccdexplorer.io/testnet/transaction/392346a95b0893678553d19c9976e13fda95d551feca491026a5f7bc34113fbb) [tx](https://ccdexplorer.io/testnet/transaction/c1795c4f82c55ac920799b738138320a5badf041def433d2cd175c756bcdafff) |
| Claim #0 filed by the agent | Signed by the agent's payer, fee sponsored by the insurer; assessor matched both receipts (payout 24 - 1 deductible) | [tx](https://ccdexplorer.io/testnet/transaction/6ad7875c4a8974f319cdf662716b6293ef7b9da92bd603c24237927fe5d0c63a) |
| Human approves, payout | Claims handler approved in the console; 23 EUDemo to the agent's payer; claim `Paid`, policy `paidOut = 23`, `claimsAuthorized = false` | [tx](https://ccdexplorer.io/testnet/transaction/900ce5b14f7c85e78f9abda90324c825d5402989c84f8688f8c5c71f735d450d) |
| Per-order cover (option B) | Shop issues an order reference; the agent insures exactly that order (0.36 EUDemo, policy #1), then buys with it | premium [tx](https://ccdexplorer.io/testnet/transaction/a1dfff8f32d10659ccad7f06e7e12391cdc1dfa3c9d2f45f55259b62ffc29a1d), purchase [tx](https://ccdexplorer.io/testnet/transaction/6b3cb66d5fb3b38d9aa94d1ead84fbf5b8566e608a2af6a8e1aa12544cdadd84) |
| Two-way trust | Teen's agent verified the shop's CIS-8004 entry, then bought bread | [tx](https://ccdexplorer.io/testnet/transaction/3beed6f09a072a9da1b32219d9544c05ff3848e1a669d37a7d38378c3029e0a9) |
| Fraud attempt | Teen's agent (policy #2, [tx](https://ccdexplorer.io/testnet/transaction/fef6939db59418665f991a9e442f208512e7edc4840f00493b3a23aff1eb55dd)) claims orders that never happened: claim #1 rejected, claim #2 marked `Fraud` after a human approved the anchored disclosure request `1788df74…` | [tx](https://ccdexplorer.io/testnet/transaction/965a81a9430cddb93c06e61df5c52ef049b1bdae28f3174ae10e001c0b533b6a) [tx](https://ccdexplorer.io/testnet/transaction/7a361ba58d200d98a8013424b24e182776ff148be6f5c719ad5f1cb111be3c33) |
| Audit trail (EU AI Act Art. 12) | Batch of guard decisions, sha256 anchored with `registerData` | [tx](https://ccdexplorer.io/testnet/transaction/dcd97d2fb15293dacf86d8b2354154bd6a98e2ab5a8e8b2d87ad53d1ba47480f) |
| Verified by Concordium badges | Agent Cards on GitHub Pages (Concordium badge + Kuasa A2A extension), sha256 pinned with `setAgentURI`; Concordium's hosted `check_badge` returns `badge_valid: true` with no issues for all three | alice [JyP9YNuoGBRd7KGU5Zbf6](https://pugarhuda.github.io/kuasa/agents/alice.json) [tx](https://ccdexplorer.io/testnet/transaction/1f35d3cbe795ad194d62f272860fda9d2c4b5138dd10e02e0981d13bc45eea29), teen [JyP9YQ1HCCvYwSWJcmE8r](https://pugarhuda.github.io/kuasa/agents/teen.json) [tx](https://ccdexplorer.io/testnet/transaction/25a7f884a9afa56a9ba3a4ad6dffd86dfa65b7534de0ce2a03fcdd55eacd69ae), shop [JyP9YUPCvJvGFwTQ1EiJ6](https://pugarhuda.github.io/kuasa/agents/shop.json) [tx](https://ccdexplorer.io/testnet/transaction/76e07492b42d66de77614303ae80eca45e53bb430a42f586f1dd598cd6b34e40) |
| **AI agent shops and insures itself** | Claude (headless, Kuasa MCP tools only) was asked to buy wine. The shop refused (no cover), so it bought 50 EUDemo cover (policy #4) and retried | premium [tx](https://ccdexplorer.io/testnet/transaction/d48f0cda489f1c9938f1e65ffa2e40c557b3e3e6c159f6e07dd0c8ff878c381c), purchase [tx](https://ccdexplorer.io/testnet/transaction/70b67f6cbed7929296c0370781ef01ab6ace7074a01c5a527ae5838c23f3d2f0) |
| **AI agent finds the duplicate and claims** | After a simulated retry bug (duplicate [tx](https://ccdexplorer.io/testnet/transaction/1022c01ee81f0e788fbdc11b972621ebb1e07d9f550fd298a058b7efa7b74c03)), Claude listed its payments, spotted the double charge, and filed claim #4 (sponsored). Assessed ok; 23 EUDemo is above the auto-pay limit, so a human approved | filing [tx](https://ccdexplorer.io/testnet/transaction/1d6627b2d7a3b84d63db5a445a60420ffa63f8690b488c10cdb09753101f4ee9), payout [tx](https://ccdexplorer.io/testnet/transaction/29d2f1bdf76cffabd284d26195196567d1e4f1b1fe1fcb3d87130699d6e42262) |
| **Tiered autonomy: automatic payout** | Claim #5 (duplicate bread, payout 2 EUDemo, below the 10 EUDemo auto-pay limit) was paid automatically after the 2-minute objection window; no human involved (`decidedBy: auto`) | payout [tx](https://ccdexplorer.io/testnet/transaction/8fcdcbb0ed44f1e635e670afe589388b728ddf8bd69e22f6b6c1b17b3a141690) |
| Pool capital + proof of solvency | 90 EUDemo of capital added to the pool; the insurer's public `/solvency` recomputes pool vs live exposure from the cover contract | capital [tx](https://ccdexplorer.io/testnet/transaction/736dc17dcc359d62de8b95ae2909774be41766898a02c955df092d55849a859e) |
| **The insurer as a badged A2A agent** | The insurer registered itself in CIS-8004 (token `2205000000000000`), published an Agent Card with four A2A skills (solvency, risk, cover-status, quote) and pinned its hash. `check_badge` returns valid. It answers A2A `message/send` at `/a2a` | register [tx](https://ccdexplorer.io/testnet/transaction/afb371a0b06a3e22913554dae3f4ca25844d636a472ea8c95cad86c7a0fb0a65), badge [JyP9UXdod6ZP39bFGudSW](https://pugarhuda.github.io/kuasa/agents/insurer.json) [tx](https://ccdexplorer.io/testnet/transaction/98c1b1149f67d0d520ef3407daec724f9a13c54d26645b3fd27886786340c825) |
| Public explorer + public A2A | [kuasa-explorer.vercel.app](https://kuasa-explorer.vercel.app) reads every policy and claim above from the contract in the browser and recomputes solvency. `POST /a2a` answers the insurer's read-only A2A skills from testnet (no keys). The insurer's card points there; re-pinned, badge still valid | card re-pin [tx](https://ccdexplorer.io/testnet/transaction/eed7dd721f85d9069c74e445067a8f231d1119554f79adee452bbded08aa7038) |

## The mandate layer, transaction by transaction (first run)

| Step | What happened | Link |
|---|---|---|
| 1. Agents registered | Alice's agent (token `ee04000000000000`) and teen's agent (`ef04000000000000`) in CIS-8004 | [alice](https://ccdexplorer.io/testnet/transaction/26f23772bf268733594e741a2d8dbe57ce3cb3d014d1a9943393b9aca332d7a9), [teen](https://ccdexplorer.io/testnet/transaction/155bd23c681bc795f90df6cd6d91faa35805eee878bc01287e1743d7285ef9ec) |
| 2. EU nationality proven, accounts allow-listed for EUDemo | Web3Id proof checked by Concordium's verifier, then added to the allow list and funded | [teen's agent](https://ccdexplorer.io/testnet/transaction/7866c8ede2c114a26f0bf2417b9a07d88146e18c6124dedbfb5a4655228868c2), [shop](https://ccdexplorer.io/testnet/transaction/b929d00dcc525ad5b7ecbf49d874361173b6643d15828bd6109d3c05def9b33e) |
| 3. Owner proves 18+ and EU residency once (Verify & Access V1), bound to the agent | Anchored verification request; the presentation is made with the agent payer's credential | [alice anchor](https://ccdexplorer.io/testnet/transaction/568d64f21a4e32f671bb03b1a3c5497d384e3322d64ed378a234b04ae6898d9d), [teen anchor](https://ccdexplorer.io/testnet/transaction/bfd70ca4446e83bc23d3b6df5addd99d9c2d4cfa4ff3b686536a6e8a9f8a46d1) |
| 4. Mandate issued on-chain | 50 EUDemo per order, 100 total, groceries + wine, this shop only, 30 days | [alice](https://ccdexplorer.io/testnet/transaction/69b635e56d12821f407a43c475c294c3ea0f9fc76a9dc89be3d1a930b2f7c39f), [teen](https://ccdexplorer.io/testnet/transaction/a4d49d535c8fcac198bd9757242590b2eded520222206004cd7aeccd737dfd55) |
| 5. Alice's agent buys wine (24 EUDemo) | x402 payment, fee sponsored by the shop: the agent holds no CCD for gas | [payment](https://ccdexplorer.io/testnet/transaction/9bb4f27b8e908728e3a1e0a689a7bc0d521a6df67f96bf2a3c226a75da176f7b) |
| 6. Receipt anchored, budget drawn down | `recordReceipt` on the registry: spent 24 / 100 | [receipt](https://ccdexplorer.io/testnet/transaction/c36cf3ef5e099c93ffe3ff3ae4cd89152522361653c45fe6bfccd3c5b1a7aab1) |
| 7. Teen's agent tries the same wine | Refused **before payment** (`age>=18 not proven`), also when it skips the quote and pays directly. No transaction exists, which is the point | – |
| 8. EUDemo sent to a non-allow-listed account | Rejected by the protocol: `recipient not in allow list` | [rejected tx](https://ccdexplorer.io/testnet/transaction/a5a5a1b88ab06d69d4da51c4d3b8051b9f21265a75973879c72b2d378bccfbf3) |
| 9. Owner revokes a mandate | Next purchase refused with `mandate revoked` | [revoke](https://ccdexplorer.io/testnet/transaction/bac831327f93b4ade7f34c8642fc29151cbcc120459ff12a2b5bc5683c07947c) |
| 10. Merchant files an incident | Evidence hash of the receipts, counted on the mandate | [incident](https://ccdexplorer.io/testnet/transaction/7047e1411930abd92841f74d564eb5010509669ffb123b7c800adc86908f00f1) |

Earlier CCD-denominated runs (before switching to EUDemo) are also on chain, e.g. [payment](https://ccdexplorer.io/testnet/transaction/8f6731a6717026217327e76e2f413aeddd15a499533d39c54afa7b0189ad4bbf) and [receipt](https://ccdexplorer.io/testnet/transaction/fa61b54e3eb7dbba81222c3552ed40aa2668bdba5da478faa65feffe9d5dfba7).

## Reproduce

See the README: `provision.ts`, `allowlist.ts`, `setup.ts`, then start the shop and console and run the agent CLI. `token-compliance.ts` reproduces step 8.
