# Kuasa A2A extension, v1

URI: `https://github.com/PugarHuda/kuasa/blob/main/docs/agents/kuasa-extension-v1.md`

An agent or merchant that carries this extension in `capabilities.extensions` of its A2A Agent Card takes part in **Kuasa**: mandated, insured agent commerce on Concordium.

| Param | Meaning |
|---|---|
| `role` | `buyer` (an agent that shops under a Kuasa mandate) or `merchant` (a shop that enforces Kuasa before taking x402 payments) |
| `mandateRegistry` | `kuasa-registry` contract holding mandates, budgets, receipts and incidents (testnet `<13065,0>`) |
| `cover` | `kuasa-cover` contract holding Kuasa Cover policies and claims (testnet `<13066,0>`) |
| `asset` | Payment asset (`EUDemo`, an allow-listed euro PLT) |
| `network` | CAIP-2 chain id |

**How a counterparty uses it.**
- **Buying agents:** the agent sends its mandate URL in the `x-kuasa-mandate` header. It can be checked against `mandateRegistry`, and live cover can be read from `cover` (`coverOf`).
- **Merchants:** the agent checks that the merchant's CIS-8004 token (the Verified-by-Concordium badge in the same card) is active and owned by the account it is asked to pay.

The agent's insured status is also published as `kuasa:cover` metadata on its CIS-8004 entry.
