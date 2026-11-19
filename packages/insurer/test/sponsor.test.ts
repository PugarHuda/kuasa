import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';
import { checkSponsorable, jsonSafe } from '../src/sponsor.js';

const key = '11'.repeat(32);
const addr = (n: number) => sdk.AccountAddress.fromBuffer(new Uint8Array(32).fill(n).buffer);
const [AGENT, OPERATOR] = [addr(2), addr(5)];
const COVER = sdk.ContractAddress.create(13066n, 0n);
const meta = { sender: AGENT, nonce: sdk.SequenceNumber.create(1n), expiry: sdk.TransactionExpiry.futureMinutes(5) };

async function signed(builder: Transaction.Builder, sponsor = OPERATOR) {
  const tx = await Transaction.sign(builder.addMetadata(meta).addSponsor(sponsor).build() as never, sdk.buildBasicAccountSigner(key));
  return JSON.parse(JSON.stringify(Transaction.toJSON(tx), jsonSafe));
}
const update = (receive: string, address = COVER, amount = 0n) => Transaction.updateContract({
  amount: sdk.CcdAmount.fromMicroCcd(amount), address, receiveName: sdk.ReceiveName.fromString(receive), message: sdk.Parameter.fromBuffer(new Uint8Array([1, 2, 3]).buffer),
}, sdk.Energy.create(60_000)) as Transaction.Builder;

test('only fileClaim to the cover contract, sponsored by the operator, is co-signed', async () => {
  const ok = await checkSponsorable(await signed(update('kuasa_cover.fileClaim')), COVER, OPERATOR);
  assert.ok(!('refused' in ok), 'refused' in ok ? ok.refused : '');
});

test('fileClaim is refused by sponsor endpoint for non-fileClaim tx', async () => {
  const transfer = Transaction.transfer({ amount: sdk.CcdAmount.fromMicroCcd(1n), toAddress: OPERATOR }) as Transaction.Builder;
  assert.match((await checkSponsorable(await signed(transfer), COVER, OPERATOR) as { refused: string }).refused, /fileClaim/);
  assert.match((await checkSponsorable(await signed(update('kuasa_cover.recordPayout')), COVER, OPERATOR) as { refused: string }).refused, /fileClaim/);
  assert.match((await checkSponsorable(await signed(update('kuasa_cover.fileClaim', sdk.ContractAddress.create(1n, 0n))), COVER, OPERATOR) as { refused: string }).refused, /fileClaim/);
  assert.match((await checkSponsorable(await signed(update('kuasa_cover.fileClaim', COVER, 5n)), COVER, OPERATOR) as { refused: string }).refused, /amount/);
  assert.match((await checkSponsorable(await signed(update('kuasa_cover.fileClaim'), addr(9)), COVER, OPERATOR) as { refused: string }).refused, /sponsor/);
  assert.match((await checkSponsorable({ nonsense: true }, COVER, OPERATOR) as { refused: string }).refused, /malformed/);
});

test('sponsorship is rate-limited per sender', async () => {
  const { SponsorBudget } = await import('../src/sponsor.js');
  let now = 0;
  const b = new SponsorBudget(3, 60_000, () => now);
  assert.deepEqual([b.take('a'), b.take('a'), b.take('a'), b.take('a')], [true, true, true, false]);
  assert.equal(b.take('b'), true, 'per sender');
  now = 61_000;
  assert.equal(b.take('a'), true, 'window slides');
});
