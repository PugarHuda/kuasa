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

test('the registry cache is bounded and never stores empty answers', async () => {
  let calls = 0;
  const f = withRetryAndCache(async (k: string) => { calls++; return k === 'none' ? null : k; }, 60_000, 3);
  await f('none'); await f('none');
  assert.equal(calls, 2, 'null answers are not cached');
  for (const k of ['a', 'b', 'c', 'd']) await f(k);
  calls = 0;
  await f('a');
  assert.equal(calls, 1, 'oldest entry was evicted at the cap');
  await f('d');
  assert.equal(calls, 1, 'recent entry still cached');
});
