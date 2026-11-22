# @kuasa/merchant: let insured agents buy from your x402 shop

`KuasaGuard` plugs into the hooks of an x402 resource server. Before any money moves it checks the buying
agent's mandate (budget, per-order limit, merchants, expiry), its owner's Verify & Access proof, its
CIS-8004 entry, any insurer's pause on it, and, for offers that ask for it, that the order is insured.
After settlement it records the receipt on-chain, which is the evidence a claim is paid from.

```ts
import { Cis8004Registry, KuasaGuard } from '@kuasa/merchant';

const guard = new KuasaGuard({
  grpc, network: 'Testnet', registry,           // kuasa-registry client (mandates, receipts)
  recorder: wallet(myAddress, myKey),           // the account that records receipts
  agents: new Cis8004Registry(grpc),            // the buyer must be a registered agent
  offers: { '/wine/:sku': { category: 'wine', requirements: { minAge: 18, minCover: 50_000_000n } } },
  cover,                                        // which insurers' covers count (see below)
  holdOf,                                       // insurers' circuit breaker (see below)
});

server
  .onBeforeVerify(guard.beforeVerify)           // refuse before the payment is verified
  .onAfterSettle(guard.afterSettle)             // record the receipt on-chain
  .onSettleFailure(guard.settleFailed)
  .onAfterVerify(guard.afterVerify)
  .onVerifyFailure(guard.verifyFailed)
  .onVerifiedPaymentCanceled(guard.verifiedCanceled);
```

`packages/shop/src/server.ts` is a complete shop built this way. Its `marketCover` sums cover across every
insurer on kuasa-market, and its `holdOf` honours a pause from any of them.

Every check is a read from Concordium testnet. The shop holds no customer data and runs no claims process;
the insurer pays claims from the receipts the guard records.

The package lives in this monorepo and is not published to npm yet. Publishing it is a step on the
[path to production](../../docs/PRODUCTION.md).
