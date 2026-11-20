/**
 * Minimal A2A (Agent2Agent) endpoint: JSON-RPC 2.0 `message/send` with a data part
 * `{ skill, ...args }`, answered synchronously with an agent message carrying a data part.
 * Skills are the ones listed on the insurer's Agent Card.
 */
import { randomUUID } from 'node:crypto';

export type A2aSkills = Record<string, (data: Record<string, unknown>) => Promise<unknown>>;

const err = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function handleA2a(body: unknown, skills: A2aSkills) {
  const b = body as { jsonrpc?: string; id?: unknown; method?: string; params?: { message?: { parts?: { kind?: string; data?: unknown }[] } } };
  if (!b || b.jsonrpc !== '2.0' || typeof b.method !== 'string') return err(b?.id, -32600, 'invalid request');
  if (b.method !== 'message/send') return err(b.id, -32601, `method not supported: ${b.method}`);
  const data = b.params?.message?.parts?.find((p) => p.kind === 'data')?.data as Record<string, unknown> | undefined;
  const skill = typeof data?.skill === 'string' && Object.hasOwn(skills, data.skill) ? skills[data.skill] : undefined;
  if (!data || !skill) return err(b.id, -32602, `send a data part with one of the skills: ${Object.keys(skills).join(', ')}`);
  try {
    const out = await skill(data);
    return { jsonrpc: '2.0', id: b.id, result: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'data', data: out }] } };
  } catch (e) {
    return err(b.id, -32000, (e as Error).message);
  }
}
