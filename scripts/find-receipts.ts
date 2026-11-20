/**
 * Recovery helper: finds the kuasa-registry receipt transactions for given payment txs by scanning
 * the blocks right after each payment. Usage: tsx find-receipts.ts <paymentTx...>
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { connect, contractEvents } from '@kuasa/chain';
import { decodeRegistryEvent } from '@kuasa/core';

const grpc = connect();
const registry = BigInt(JSON.parse(readFileSync(new URL('../.kuasa/state.json', import.meta.url), 'utf8')).registry);
for (const pay of process.argv.slice(2)) {
  const st = await grpc.getBlockItemStatus(sdk.TransactionHash.fromHexString(pay));
  if (st.status !== 'finalized' || !st.outcome) { console.log(pay, 'not finalized'); continue; }
  const start = (await grpc.getBlockInfo(st.outcome.blockHash)).blockHeight;
  let found = '';
  for (let h = start; h < start + 120n && !found; h++) {
    for (const bh of await grpc.getBlocksAtHeight(h)) {
      for await (const item of grpc.getBlockTransactionEvents(bh)) {
        for (const raw of contractEvents(item, registry)) {
          const e = decodeRegistryEvent(raw);
          if (e?.type === 'Receipt' && e.paymentTx === pay) found = sdk.TransactionHash.toHexString((item as { hash: sdk.TransactionHash.Type }).hash);
        }
      }
    }
  }
  console.log(pay, '->', found || 'not found');
}
process.exit(0);
