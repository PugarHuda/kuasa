import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMarketInsurers, W } from '../src/index.js';

test('decodes the kuasa-market insurers view (Vec<(AccountAddress, Insurer)>)', () => {
  const pool = '3QLQkD8ZK4NDKEgQmxrwXkESkw3wwztrtF1sjjbYkGpHEsFcLo';
  const b = new W().u32(1).account(pool).str('Kuasa Re').u64(13108n).u64(0n).str('http://localhost:4024').u32(8500).str('').u64(10_000_000n).u8(1).u64(42n).done();
  assert.deepEqual(decodeMarketInsurers(b), [{ pool, name: 'Kuasa Re', cover: 13108n, url: 'http://localhost:4024', priceBps: 8500, evm: '', bond: 10_000_000n, exitAt: 42n }]);
});
