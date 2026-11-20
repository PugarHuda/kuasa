import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evmChallenge, verifyEvmAgent } from '../src/evm.js';

test('EVM agent proof: only a fresh kuasa challenge is accepted (checked before any lookup)', async () => {
  const now = 1_800_000_000_000;
  await assert.rejects(verifyEvmAgent({ message: evmChallenge(now - 6 * 60_000), signature: '0x00' }, now), /5-minute window/);
  await assert.rejects(verifyEvmAgent({ message: 'hello', signature: '0x00' }, now), /kuasa-evm-agent/);
  await assert.rejects(verifyEvmAgent({ message: `${evmChallenge(now)}:extra`, signature: '0x00' }, now), /kuasa-evm-agent/);
});
