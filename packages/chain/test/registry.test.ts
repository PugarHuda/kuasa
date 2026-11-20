import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSetMetadata } from '../src/index.js';

test('setMetadata encoding matches what the CIS-8004 registry accepted on testnet (dry-run)', () => {
  assert.equal(Buffer.from(encodeSetMetadata('ee04000000000000', 'kuasa:cover', 'x')).toString('hex'),
    '08' + 'ee04000000000000' + '0b000000' + Buffer.from('kuasa:cover').toString('hex') + '01000000' + '78');
  assert.throws(() => encodeSetMetadata('ee04000000000000', 'kuasa:cover', 'a"b'), /quotes/);
});
