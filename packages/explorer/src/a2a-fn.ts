/**
 * Public, read-only A2A endpoint of the Kuasa Cover insurer (Vercel function at /a2a). No keys:
 * every skill recomputes its answer from Concordium testnet. Quotes and purchases need the insurer
 * service itself (payer proof + x402 checkout), so `quote` is not served here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleA2a } from '../../insurer/src/a2a.js';
import { solvency } from '@kuasa/cover';
import { coverOf, eudemoOf, marketInsurers, riskOf, scan, solvencyNow } from './chain.js';
import { feedbackFor } from './erc8004.js';
import { verifyEvmAgent } from './evm.js';

/**
 * The market in one call: every insurer on the open registry (kuasa-market <13118,0>) with its bond,
 * price and URL, and its pool, live limits and free capacity recomputed from its own book.
 */
async function market() {
  const [listed, { books }] = await Promise.all([marketInsurers(), scan()]);
  const out = [];
  for (const i of listed) {
    const book = books.find((b) => b.cover === i.cover);
    const pool = await eudemoOf(i.pool).catch(() => 0n);
    const s = book ? solvency({ pool, now: Date.now(), policies: book.policies, claims: book.claims.map((c) => ({ status: c.status.tag })) }) : null;
    out.push({ name: i.name, pool: i.pool, cover: `<${i.cover},0>`, url: i.url, priceMultiplier: i.priceBps / 10_000, bondMicroCcd: String(i.bond), leaving: i.exitAt !== null,
      poolBalance: String(pool), liveLimits: s ? String(s.exposure) : null, freeCapacity: s ? String(s.pool > s.exposure ? s.pool - s.exposure : 0n) : null });
  }
  return { registry: '<13118,0>', insurers: out, note: 'free capacity counts this book only; an insurer may back other books from the same pool' };
}

const skills = {
  market: () => market(),
  solvency: () => solvencyNow(),
  risk: async (d: Record<string, unknown>) => riskOf(String(d.payer ?? '')),
  // Cross-chain: an agent on an EVM chain proves its Ethereum key; we answer with its Concordium badge and cover.
  'verify-evm-agent': async (d: Record<string, unknown>) => verifyEvmAgent(d),
  // Portable reputation: this agent's claim outcomes as ERC-8004 Reputation Registry feedback entries.
  'erc8004-feedback': async (d: Record<string, unknown>) => ({ payer: String(d.payer ?? ''), standard: 'ERC-8004 reputation feedback (score 0-100, tag1, tag2, evidence pointer)', feedback: feedbackFor(String(d.payer ?? ''), (await scan()).books) }),
  'cover-status': async (d: Record<string, unknown>) => ({ onChain: await coverOf(String(d.payer ?? '')) }),
  quote: async () => { throw new Error('quotes need the insurer service (payer proof, then x402 checkout); see github.com/PugarHuda/kuasa/blob/main/docs/INTEGRATIONS.md'); },
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  if (req.method === 'OPTIONS') return send(res, 204, null);
  if (req.method !== 'POST') return send(res, 200, { agent: 'Kuasa Cover insurer', protocol: 'A2A JSON-RPC message/send', skills: Object.keys(skills), card: 'https://pugarhuda.github.io/kuasa/agents/insurer.json' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = undefined; } }
  send(res, 200, await handleA2a(body, skills));
}
