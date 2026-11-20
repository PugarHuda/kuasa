import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleA2a } from '../src/a2a.js';

const skills = {
  solvency: async () => ({ solvent: true }),
  'cover-status': async (d: Record<string, unknown>) => ({ payer: d.payer, policyId: '5' }),
};
const msg = (data: unknown, method = 'message/send') => ({ jsonrpc: '2.0', id: 7, method, params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data }] } } });

test('A2A message/send routes a data part to the named skill and answers with an agent message', async () => {
  const r = await handleA2a(msg({ skill: 'cover-status', payer: 'P' }), skills) as { id: number; result: { kind: string; role: string; parts: { kind: string; data: unknown }[] } };
  assert.equal(r.id, 7);
  assert.equal(r.result.kind, 'message');
  assert.equal(r.result.role, 'agent');
  assert.deepEqual(r.result.parts[0], { kind: 'data', data: { payer: 'P', policyId: '5' } });
});

test('A2A errors are JSON-RPC errors, never thrown', async () => {
  assert.equal(((await handleA2a(msg({ skill: 'nope' }), skills)) as { error: { code: number } }).error.code, -32602);
  assert.equal(((await handleA2a(msg({}, 'tasks/get'), skills)) as { error: { code: number } }).error.code, -32601);
  assert.equal(((await handleA2a({ nonsense: true }, skills)) as { error: { code: number } }).error.code, -32600);
  const boom = await handleA2a(msg({ skill: 'solvency' }), { solvency: async () => { throw new Error('chain down'); } }) as { error: { message: string } };
  assert.match(boom.error.message, /chain down/);
});
