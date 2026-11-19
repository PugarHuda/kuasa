# Kuasa on Concordium testnet

Everything below is on testnet and can be opened in CCDExplorer. Base URL: `https://ccdexplorer.io/testnet`.

## Contracts

| What | Address | Link |
|---|---|---|
| Kuasa registry (our contract) | `<13065,0>` | [instance](https://ccdexplorer.io/testnet/instance/13065/0) |
| Module deploy | `7a7c03f0…1031a` | [tx](https://ccdexplorer.io/testnet/transaction/221a2e727643c5b94e11c327b89ffca9a5ad263ed5cc645ecb1180cf590fe694) |
| Registry init | | [tx](https://ccdexplorer.io/testnet/transaction/24550535f602ee998d0f0ebd8886485adfbb4432d7bcc9df8be15c205f9ca53e) |
| CIS-8004 Agent Registry (Concordium) | `<12802,0>` | [instance](https://ccdexplorer.io/testnet/instance/12802/0) |

## Accounts

All identities come from the testnet identity provider with invented attributes. Every owner and their agent's payer account are created from the **same** identity, so the agent's spending stays accountable to that person.

| Role | Attributes | Account |
|---|---|---|
| Alice, owner | adult, DK resident and national | [4Wmdhh…o1aq3s](https://ccdexplorer.io/testnet/account/4WmdhhLRPTk92STxiaXQFFNyJFLaM6k5kRq1ryFN8xjho1aq3s) |
| Alice's agent (payer) | same identity | [4DRGyL…uhXKLc](https://ccdexplorer.io/testnet/account/4DRGyL6GkXQXs8CT7KovczM9SbwVgn8KsKAvQtFt4G4puhXKLc) |
| Teen, owner | 16 years old, DK | [4j733X…u8huDH](https://ccdexplorer.io/testnet/account/4j733XjURhA9UFkxfNbZHsKpRSMvnbQjJyjbbMHUKuzMu8huDH) |
| Teen's agent (payer) | same identity | [4Gw69U…ys4oqg](https://ccdexplorer.io/testnet/account/4Gw69UEYtxxE1EroXsp3AwAZWa38cKCuQZCgs9HYLc1Xys4oqg) |
| Shop (payTo) | NL | [34BwTu…KrPKv](https://ccdexplorer.io/testnet/account/34BwTuaAu2EsgHNj3Us9TrYUNbKGo6Wnh3ixxUSanrca7KrPKv) |
| Shop facilitator (fee sponsor, receipt recorder) | NL, **not** on the EUDemo allow list | [4HeXqT…q32UNp](https://ccdexplorer.io/testnet/account/4HeXqTdciL1dVAaNZ6kiVRAH3syJcDnFtqLM3z3phWbAq32UNp) |

## The flow, transaction by transaction

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
