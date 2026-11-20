/**
 * Demo runner: the Kuasa Cover storyline, step by step, run for real on testnet by the demo
 * agents (alice: adult EU owner; teen: 16-year-old owner). Used to record the submission video.
 * Localhost only; the agents' testnet keys come from .kuasa like the CLI.
 */
import { KuasaAgent } from '@kuasa/agent';

const EUR = 1_000_000n;
const WINE = '/shop/wine/rioja';
let alice: KuasaAgent | undefined;
let teen: KuasaAgent | undefined;
const mem: { payments: string[]; claimId?: string } = { payments: [] };

const agents = () => {
  alice ??= KuasaAgent.fromDemo('alice');
  teen ??= KuasaAgent.fromDemo('teen');
  return { alice, teen };
};

export type DemoStep = { id: string; title: string; caption: string; run?: (ctx: { publishCover: (name: string) => Promise<unknown>; badge: (name: string) => Promise<unknown> }) => Promise<unknown> };

export const STEPS: DemoStep[] = [
  { id: 'intro', title: 'AI agents can pay. Who carries the loss when they get it wrong?',
    caption: 'Kuasa Cover makes agent commerce insurable on Concordium: verified owners, scoped mandates, ZK proofs, x402 payments in a regulated euro, and claims paid from on-chain evidence.' },
  { id: 'uninsured', title: "Alice's agent tries to buy wine, uninsured",
    caption: 'The shop sells age-restricted goods only to insured agents. Before any money moves, the guard checks the mandate, the owner’s ZK proof (18+, EU), the agent’s CIS-8004 entry, and cover.',
    run: async () => agents().alice.buy(WINE) },
  { id: 'teen', title: "A 16-year-old's agent tries the same wine",
    caption: 'Same shop, same checks: no 18+ proof exists for this owner, so the purchase is refused before payment. The merchant never sees a birth date.',
    run: async () => agents().teen.buy(WINE) },
  { id: 'quote', title: 'Alice’s agent asks for insurance',
    caption: 'The premium is priced from on-chain facts: how tight the mandate is, what the owner proved with ZK, the category risk and the agent’s history. Every factor is explained.',
    run: async () => agents().alice.coverQuote(100n * EUR, 30) },
  { id: 'cover', title: 'The agent insures itself over x402',
    caption: 'It pays the premium in EUDemo (an allow-listed euro) under its own mandate; the insurer sponsors the fee and writes the policy to the Kuasa Cover contract.',
    run: async () => agents().alice.coverBuy(100n * EUR, 30) },
  { id: 'publish', title: 'The owner publishes "insured" in the Agent Registry',
    caption: 'The policy is now visible on the agent’s CIS-8004 entry, next to its Verified-by-Concordium badge. Any merchant can read it.',
    run: async (c) => c.publishCover('alice') },
  { id: 'mistake', title: 'The agent makes a mistake: it buys the same wine twice',
    caption: 'Both purchases are insured and allowed. Each settles over x402 and leaves a receipt on-chain that draws down the mandate budget.',
    run: async () => {
      const r = await agents().alice.buyTwice(WINE);
      mem.payments = [r.first, r.second].map((x) => (x.ok ? x.paymentTx : undefined)).filter((x): x is string => !!x);
      return r;
    } },
  { id: 'claim', title: 'The agent files a claim',
    caption: 'Signed by the agent, fee sponsored by the insurer. The assessor matches the two duplicate receipts on-chain and recommends a payout. No money moves yet.',
    run: async () => {
      const r = await agents().alice.fileClaim('AgentMistake', mem.payments, 24n * EUR, 'duplicate order');
      mem.claimId = (r as { claimId?: string }).claimId ?? undefined;
      return r;
    } },
  { id: 'approve', title: 'A human claims handler decides',
    caption: 'Approve sends the payout in EUDemo from the pool and records it on the cover contract. Escrow protects you from bad sellers; Kuasa Cover protects you from your agent.' },
  { id: 'proof', title: 'Everything is verifiable',
    caption: 'Verified-by-Concordium badge, mandate and cover contracts, receipts, payouts and anchored audit batches (EU AI Act Art. 12) are all on testnet. Path to production: the pool moves into a Protocol-Level Lock released by the cover contract.',
    run: async (c) => ({ badge: await c.badge('alice'), claimId: mem.claimId }) },
];

export const demoClaimId = () => mem.claimId;
