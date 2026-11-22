# Measured fees per action

Every number below is the fee actually charged on Concordium testnet for the transactions that
docs/TESTNET.md links to, read back from the chain by `pnpm verify --costs` (2026-11-22).
Fees are in CCD and are paid by the sender, or by the sponsor for sponsored transactions (the agent
and the claimant never hold CCD for these). EUDemo amounts (prices, premiums, payouts) are not fees.

| Action | Transactions | Median energy (NRG) | Min CCD | Median CCD | Max CCD |
|---|---|---|---|---|---|
| token transfer (EUDemo PLT) | 23 | 679 | 4.9128 | 5.1927 | 7.4899 |
| contract call CIS-8004.setMetadata | 9 | 2546 | 13.4723 | 19.0219 | 40.9817 |
| contract deployment (init) | 8 | 1173 | 6.5615 | 9.0474 | 10.7894 |
| contract call kuasa_cover.autoApprove | 6 | 1437 | 9.3177 | 10.9864 | 11.5817 |
| contract call CIS-8004.register | 5 | 2273 | 16.5131 | 16.6085 | 17.0973 |
| contract call kuasa.issue | 5 | 1542 | 10.7875 | 11.2173 | 12.2028 |
| contract call kuasa.recordReceipt | 5 | 1498 | 10.4561 | 10.8972 | 11.8272 |
| contract call CIS-8004.setAgentURI | 5 | 1867 | 13.3297 | 13.7502 | 14.0164 |
| contract call kuasa_cover.claim | 5 | 2129 | 11.9563 | 16.3541 | 17.2884 |
| registerData (audit anchor) | 4 | 524 | 3.5976 | 3.8271 | 4.6225 |
| contract call kuasa_market.register | 4 | 1168 | 8.5355 | 9.0741 | 9.3615 |
| contract call kuasa_cover.bondRules | 4 | 1940 | 14.6779 | 14.9633 | 15.0943 |
| module deployment | 3 | 67550 | 297.3739 | 491.3916 | 747.7867 |
| contract call kuasa.reportIncident | 2 | 1472 | 9.9958 | 11.0131 | 11.0131 |
| contract call kuasa.view | 2 | 1797 | 11.4464 | 13.7387 | 13.7387 |
| contract call kuasa_cover.postBond | 2 | 1424 | 9.9390 | 11.3839 | 11.3839 |
| contract call kuasa_cover.decideClaim | 2 | 1398 | 10.7211 | 10.7389 | 10.7389 |
| contract call CIS-8.registerExternalKey | 1 | 2894 | 21.3139 | 21.3139 | 21.3139 |
| contract call CIS-8.ownerOfKey | 1 | 3328 | 24.5102 | 24.5102 | 24.5102 |
| contract call kuasa_cover.cancelPolicy | 1 | 1268 | 9.4868 | 9.4868 | 9.4868 |
| contract call kuasa_cover.setTerms | 1 | 1263 | 9.6561 | 9.6561 | 9.6561 |
| contract call kuasa_cover.fileClaimFor | 1 | 2124 | 16.2388 | 16.2388 | 16.2388 |
| contract call kuasa_market.vetoSlash | 1 | 1278 | 9.8171 | 9.8171 | 9.8171 |
| contract call kuasa.revoke | 1 | 1294 | 9.4551 | 9.4551 | 9.4551 |

What a policy costs to run, end to end, in fees: one premium payment, one `issuePolicy`, and per
claim a `fileClaim` (sponsored), an `assessClaim`, an `autoApprove` or `decideClaim`, the payout
transfer and a `recordPayout`. Energy (NRG) is what an action consumes; the protocol prices energy in
CCD at a EUR-pegged rate set by chain governance, so the CCD fee for the same action moves with the
CCD/EUR rate and the median energy is the stable number to budget with.
