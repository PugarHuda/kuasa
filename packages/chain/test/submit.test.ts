import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountAddress, SequenceNumber, TransactionHash } from '@concordium/web-sdk';
import { cis8004SetMetadataTx, submit, wallet } from '../src/index.js';

test('a duplicate nonce is retried with a fresh nonce on the same builder (sponsored too)', async () => {
  const addr = AccountAddress.fromBuffer(new Uint8Array(32).fill(1).buffer).address;
  const w = wallet(addr, '11'.repeat(32));
  for (const sponsor of [undefined, wallet(AccountAddress.fromBuffer(new Uint8Array(32).fill(2).buffer).address, '22'.repeat(32))]) {
    let sends = 0, nonce = 5;
    const grpc = {
      getNextAccountNonce: async () => ({ nonce: SequenceNumber.create(nonce++) }),
      sendTransaction: async () => { if (sends++ === 0) throw new Error('Duplicate nonce'); return TransactionHash.fromHexString('ab'.repeat(32)); },
      waitForTransactionFinalization: async () => ({ summary: {} }),
    };
    const r = await submit(grpc as never, cis8004SetMetadataTx('ee04000000000000', 'k', 'v'), w, sponsor);
    assert.equal(sends, 2);
    assert.equal(r.hash, 'ab'.repeat(32));
  }
});
