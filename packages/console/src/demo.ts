/**
 * Demo runner: the Kuasa Cover storyline, step by step, run for real on testnet. The shopping and
 * claim steps are done by a real AI agent (Claude via the Kuasa MCP server); the retry bug and the
 * teen's refused purchase are scripted. Used to record the submission video. Localhost only.
 */
import { KuasaAgent } from '@kuasa/agent';
import { runAiAgent } from './ai-agent.js';

const WINE = '/shop/wine/rioja';
let alice: KuasaAgent | undefined;
let teen: KuasaAgent | undefined;
const agents = () => {
  alice ??= KuasaAgent.fromDemo('alice');
  teen ??= KuasaAgent.fromDemo('teen');
  return { alice, teen };
};

type Ctx = { publishCover: (name: string) => Promise<unknown>; badge: (name: string) => Promise<unknown>; solvency: () => Promise<unknown> };
export type DemoStep = { id: string; title: string; caption: string; ai?: boolean; run?: (ctx: Ctx) => Promise<unknown> };

export const STEPS: DemoStep[] = [
  { id: 'intro', title: 'AI agents can pay. Who carries the loss when they get it wrong?',
    caption: 'Kuasa Cover makes agent commerce insurable on Concordium: verified owners, scoped mandates, ZK proofs, x402 payments in a regulated euro, and claims paid from on-chain evidence.' },
  { id: 'ai-shop', ai: true, title: 'A real AI agent is asked to buy wine',
    caption: 'Claude acts as Alice’s agent through the Kuasa MCP tools only. Its whole task is "buy one bottle of Rioja". Nobody tells it about insurance: it has to read the shop’s refusal and work out what to do.',
    run: () => runAiAgent(`Buy one bottle of Rioja (${WINE}) for Alice's dinner tonight.`) },
  { id: 'teen', title: "A 16-year-old's agent tries the same wine",
    caption: 'Same shop, same checks: no 18+ proof exists for this owner, so the purchase is refused before payment. The merchant never sees a birth date.',
    run: async () => agents().teen.buy(WINE) },
  { id: 'publish', title: 'Alice publishes "insured" in the Agent Registry',
    caption: 'The policy now shows on the agent’s CIS-8004 entry, next to its Verified-by-Concordium badge, so any merchant can see the agent is insured.',
    run: async (c) => c.publishCover('alice') },
  { id: 'bug', title: 'A retry bug repeats the checkout',
    caption: 'Simulated failure: the agent’s HTTP client retries a checkout that already went through. Alice is charged twice for one bottle. Both payments settle and leave receipts on-chain.',
    run: async () => agents().alice.buy(WINE) },
  { id: 'ai-claim', ai: true, title: 'The agent notices and files a claim itself',
    caption: 'The same AI agent reviews its purchases, finds the duplicate, and files a claim (fee sponsored by the insurer). The assessor matches both receipts on-chain and recommends a payout.',
    run: () => runAiAgent('Check your recent purchases at the shop and sort out anything that went wrong.') },
  { id: 'approve', title: 'Tiered autonomy: a human decides the bigger claims',
    caption: 'Claims up to the auto-pay limit are paid automatically after an objection window. This one is above it, so a human claims handler approves. Escrow protects you from bad sellers; Kuasa Cover protects you from your agent.' },
  { id: 'proof', title: 'Everything is verifiable',
    caption: 'A valid Verified-by-Concordium badge, a public proof of solvency computed from the cover contract, receipts, payouts and anchored audit batches (EU AI Act Art. 12). Live on testnet.',
    run: async (c) => ({ badge: await c.badge('alice'), solvency: await c.solvency() }) },
];
