/**
 * Kuasa actions for EVM agents, framework-neutral ({ name, description, schema, invoke }): prove this
 * agent is a Verified-by-Concordium agent insured by Kuasa Cover (signed with its own EVM wallet),
 * check another agent the same way, read the insurer's solvency. They call the public read-only Kuasa
 * A2A endpoint; the EVM key is bound to the Concordium agent in the CIS-8 External Key Registry.
 * AgentKit wiring: agentkit.ts. Verified run: index.ts.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const A2A = process.env.KUASA_A2A_URL ?? 'https://kuasa-explorer.vercel.app/a2a';

async function a2a(data: Record<string, unknown>) {
  const r = await fetch(A2A, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: randomBytes(8).toString('hex'), parts: [{ kind: 'data', data }] } } }),
  });
  const out = (await r.json()) as { result?: { parts: { data: unknown }[] }; error?: { message: string } };
  if (out.error) throw new Error(out.error.message);
  return out.result!.parts[0].data;
}

/** Anything that can sign an EIP-191 message: an AgentKit EvmWalletProvider, a viem account, ... */
export type Signer = { signMessage(message: string): Promise<string> };

export const kuasaActions = [
  {
    name: 'kuasa_prove_insured',
    description: 'Prove that this agent is a Verified-by-Concordium agent insured by Kuasa Cover. Pass the nonce the counterparty gave you (or none to check yourself). Returns badge validity, live cover and claims history.',
    schema: z.object({ nonce: z.string().regex(/^[0-9a-f]{32,64}$/i).optional() }),
    invoke: async (wallet: Signer, args: { nonce?: string }) => {
      const nonce = args.nonce ?? randomBytes(16).toString('hex');
      const message = `kuasa-evm-agent:v1:${new URL(A2A).host}:${nonce}:${Date.now()}`;
      const signature = await wallet.signMessage(message);
      return JSON.stringify({ message, signature, nonce, verified: await a2a({ skill: 'verify-evm-agent', message, signature, nonce }) });
    },
  },
  {
    name: 'kuasa_check_counterparty',
    description: 'Before dealing with another agent: verify its signed Kuasa challenge (message, signature, the nonce you issued) and get its Concordium badge and Kuasa Cover status.',
    schema: z.object({ message: z.string(), signature: z.string(), nonce: z.string() }),
    invoke: async (args: { message: string; signature: string; nonce: string }) => JSON.stringify(await a2a({ skill: 'verify-evm-agent', ...args })),
  },
  {
    name: 'kuasa_insurer_solvency',
    description: "Kuasa Cover's proof of solvency: pool vs the cover owed by live policies, recomputed from the Concordium contract.",
    schema: z.object({}),
    invoke: async () => JSON.stringify(await a2a({ skill: 'solvency' })),
  },
];
