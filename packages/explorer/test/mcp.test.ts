import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetryAndCache } from '../src/evm.js';

test('registry lookups retry a transient failure and cache answers briefly', async () => {
  let calls = 0;
  const flaky = withRetryAndCache(async (k: string) => { calls++; if (calls === 1) throw new Error('502'); return `v:${k}`; }, 60_000);
  assert.equal(await flaky('a'), 'v:a', 'second attempt succeeds');
  assert.equal(await flaky('a'), 'v:a');
  assert.equal(calls, 2, 'served from cache');
  const down = withRetryAndCache(async () => { throw new Error('down'); }, 60_000);
  await assert.rejects(down('x'), /down/);
});
