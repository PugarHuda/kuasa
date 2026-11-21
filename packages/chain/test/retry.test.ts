import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/index.js';

test('withRetry: transient node errors (429 / UNAVAILABLE) are retried; others fail at once; sync calls pass through', async () => {
  let n = 0, m = 0;
  const c = withRetry({
    async busy() { n++; if (n < 3) throw Object.assign(new Error('Received HTTP status code 429'), { code: 'UNAVAILABLE' }); return n; },
    async broken() { m++; throw new Error('contract rejected'); },
    sync() { return 'x'; },
  }, [1, 1, 1]);
  assert.equal(await c.busy(), 3);
  await assert.rejects(c.broken(), /contract rejected/);
  assert.equal(m, 1);
  assert.equal(c.sync(), 'x');
});
