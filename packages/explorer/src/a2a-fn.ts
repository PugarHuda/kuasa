/**
 * Public, read-only A2A endpoint of the Kuasa Cover insurer (Vercel function at /a2a). No keys:
 * every skill recomputes its answer from Concordium testnet. Quotes and purchases need the insurer
 * service itself (payer proof + x402 checkout), so `quote` is not served here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleA2a } from '../../insurer/src/a2a.js';
import { coverOf, riskOf, solvencyNow } from './chain.js';
import { verifyEvmAgent } from './evm.js';

const skills = {
  solvency: () => solvencyNow(),
  risk: async (d: Record<string, unknown>) => riskOf(String(d.payer ?? '')),
  // Cross-chain: an agent on an EVM chain proves its Ethereum key; we answer with its Concordium badge and cover.
  'verify-evm-agent': async (d: Record<string, unknown>) => verifyEvmAgent(d),
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
