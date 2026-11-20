import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverBindsToAgent, evmChallenge, verifyEvmAgent } from '../src/evm.js';

const now = 1_800_000_000_000;
const nonce = 'a'.repeat(32);

test('EVM agent proof: the message must name this verifier, carry the caller nonce and be fresh', async () => {
  const ok = evmChallenge(nonce, now);
  assert.equal(ok, `kuasa-evm-agent:v1:kuasa-explorer.vercel.app:${nonce}:${now}`);
  await assert.rejects(verifyEvmAgent({ message: evmChallenge(nonce, now - 6 * 60_000), nonce, signature: '0x00' }, now), /window/);
  await assert.rejects(verifyEvmAgent({ message: evmChallenge(nonce, now + 60_000), nonce, signature: '0x00' }, now), /window/, 'no future timestamps');
  await assert.rejects(verifyEvmAgent({ message: ok, nonce: 'b'.repeat(32), signature: '0x00' }, now), /nonce/, 'nonce issued by the caller');
  await assert.rejects(verifyEvmAgent({ message: ok.replace('kuasa-explorer.vercel.app', 'evil.example'), nonce, signature: '0x00' }, now), /kuasa-evm-agent/, 'audience bound');
  await assert.rejects(verifyEvmAgent({ message: evmChallenge('short', now), nonce: 'short', signature: '0x00' }, now), /nonce/);
});

test('cover counts only if the policy belongs to that agent and its owner', () => {
  const agent = { token_id: '1262', owner_account: 'OWNER' };
  assert.equal(coverBindsToAgent({ agentToken: 'ee04000000000000', holder: 'OWNER' }, agent), true);
  assert.equal(coverBindsToAgent({ agentToken: 'ef04000000000000', holder: 'OWNER' }, agent), false, 'another agent’s policy');
  assert.equal(coverBindsToAgent({ agentToken: 'ee04000000000000', holder: 'SOMEONE' }, agent), false, 'another owner’s policy');
});
