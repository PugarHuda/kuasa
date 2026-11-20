import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClaimId } from '../src/validate.js';

test('claim ids are plain decimal numbers', () => {
  for (const ok of ['0', '2', '1234']) assert.equal(isClaimId(ok), true, ok);
  for (const bad of ['', 'd', 'dd', '-1', '1a', '0x1', '1 ']) assert.equal(isClaimId(bad), false, bad);
});
