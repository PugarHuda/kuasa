/**
 * Keyless check of every transaction docs/TESTNET.md links to: each must be finalized on Concordium
 * testnet and must not have been rejected (unless the row says it was meant to be). Needs no keys, no
 * accounts and none of the services: only the public node.
 *   pnpm verify            (from the repo root)
 *   pnpm verify --costs    also writes docs/COSTS.md: the measured fee of each kind of action
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { connect } from '@kuasa/chain';

const doc = readFileSync(new URL('../docs/TESTNET.md', import.meta.url), 'utf8');
const rows = doc.split('\n').filter((l) => l.includes('/transaction/'));
const items = new Map<string, { row: string; expectReject: boolean }>();
for (const row of rows) {
  for (const m of row.matchAll(/transaction\/([0-9a-f]{64})/g)) {
    if (items.has(m[1])) continue;
    // a step that shows a refusal (a rejected slash, a refused purchase) links a transaction meant to fail
    items.set(m[1], { row: row.slice(0, 90).replace(/\|/g, ' ').trim(), expectReject: /reject|refus|fail/i.test(row.slice(row.indexOf(m[1]) - 60, row.indexOf(m[1]))) });
  }
}
const grpc = connect();
type Out = { hash: string; ok: boolean; finalized: boolean; rejected: boolean; kind: string; costMicro: bigint; energy?: bigint };
const out: Out[] = [];
const kindOf = (s: Record<string, unknown>): string => {
  const t = s.transactionType as string | undefined;
  if (t === 'update') return `contract call ${((s.contractUpdate ?? s) as { receiveName?: string }).receiveName ?? (s.events as { receiveName?: string }[] | undefined)?.find((e) => e.receiveName)?.receiveName ?? ''}`.trim();
  if (t === 'tokenUpdate') return 'token transfer (EUDemo PLT)';
  if (t === 'initContract') return 'contract deployment (init)';
  if (t === 'deployModule') return 'module deployment';
  if (t === 'registerData') return 'registerData (audit anchor)';
  if (t === 'transfer' || t === 'transferWithMemo') return 'CCD transfer';
  return t ?? 'other';
};
const queue = [...items.keys()];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let h = queue.shift(); h; h = queue.shift()) {
    try {
      const st = await grpc.getBlockItemStatus(sdk.TransactionHash.fromHexString(h));
      if (st.status !== 'finalized') { out.push({ hash: h, ok: false, finalized: false, rejected: false, kind: '?', costMicro: 0n }); continue; }
      const s = st.outcome.summary as unknown as Record<string, unknown>;
      const rejected = s.transactionType === 'failed' || 'rejectReason' in s || (s as { result?: { outcome?: string } }).result?.outcome === 'reject';
      const cost = BigInt((s.cost as bigint | string | undefined) ?? 0);
      const energy = BigInt(((s.energyCost as { value?: bigint | string } | undefined)?.value) ?? 0);
      out.push({ hash: h, ok: !rejected || items.get(h)!.expectReject, finalized: true, rejected, kind: kindOf(s), costMicro: cost, energy });
    } catch (e) {
      out.push({ hash: h, ok: false, finalized: false, rejected: false, kind: `unreadable: ${(e as Error).message.slice(0, 40)}`, costMicro: 0n });
    }
  }
}));
const bad = out.filter((o) => !o.ok);
console.log(`${out.length} transactions linked from docs/TESTNET.md: ${out.filter((o) => o.finalized).length} finalized, ${out.filter((o) => o.rejected && o.ok).length} rejected on purpose, ${bad.length} problems`);
for (const b of bad) console.log(`  ${b.hash}  ${b.finalized ? 'rejected' : 'not found/finalized'}  ${b.kind}  (${items.get(b.hash)!.row})`);

if (process.argv.includes('--costs')) {
  const by = new Map<string, bigint[]>();
  const en = new Map<string, bigint[]>();
  for (const o of out) if (o.finalized && !o.rejected && o.costMicro > 0n) { by.set(o.kind, [...(by.get(o.kind) ?? []), o.costMicro]); en.set(o.kind, [...(en.get(o.kind) ?? []), o.energy ?? 0n]); }
  const ccd = (m: bigint) => (Number(m) / 1e6).toFixed(4);
  const lines = [...by.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => {
    const s = [...v].sort((a, b) => (a < b ? -1 : 1));
    const e = [...en.get(k)!].sort((a, b) => (a < b ? -1 : 1));
    return `| ${k} | ${v.length} | ${e[Math.floor(e.length / 2)]} | ${ccd(s[0])} | ${ccd(s[Math.floor(s.length / 2)])} | ${ccd(s[s.length - 1])} |`;
  });
  writeFileSync(new URL('../docs/COSTS.md', import.meta.url), `# Measured fees per action

Every number below is the fee actually charged on Concordium testnet for the transactions that
docs/TESTNET.md links to, read back from the chain by \`pnpm verify --costs\` (${new Date().toISOString().slice(0, 10)}).
Fees are in CCD and are paid by the sender, or by the sponsor for sponsored transactions (the agent
and the claimant never hold CCD for these). EUDemo amounts (prices, premiums, payouts) are not fees.

| Action | Transactions | Median energy (NRG) | Min CCD | Median CCD | Max CCD |
|---|---|---|---|---|---|
${lines.join('\n')}

What a policy costs to run, end to end, in fees: one premium payment, one \`issuePolicy\`, and per
claim a \`fileClaim\` (sponsored), an \`assessClaim\`, an \`autoApprove\` or \`decideClaim\`, the payout
transfer and a \`recordPayout\`. Energy (NRG) is what an action consumes; the protocol prices energy in
CCD at a EUR-pegged rate set by chain governance, so the CCD fee for the same action moves with the
CCD/EUR rate and the median energy is the stable number to budget with.
`);
  console.log('wrote docs/COSTS.md');
}
process.exit(bad.length ? 1 : 0);
