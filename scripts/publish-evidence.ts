/**
 * Publishes claim evidence documents next to the explorer, content-addressed: docs/explorer/evidence/<hash>.json,
 * where <hash> = sha256 of the canonical JSON = the claim's on-chain `evidence`. A document is written only
 * when its hash matches the claim on the current cover contract, so anyone can re-hash it and compare.
 * Sources: documents the insurer verified at assessment, and the insurer-filed duplicates (rebuilt from its
 * detections exactly as it filed them). Usage: tsx publish-evidence.ts, then redeploy the explorer.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { canonicalJson, type ClaimEvidence, evidenceHash } from '@kuasa/core';
import { connect, KuasaCover } from '@kuasa/chain';

const root = new URL('../.kuasa/', import.meta.url);
const big = (v: unknown) => (v && typeof v === 'object' && '$big' in v ? BigInt((v as { $big: string }).$big) : BigInt(v as string));
const st = JSON.parse(readFileSync(new URL('state.json', root), 'utf8')) as { cover: string };
const ins = JSON.parse(readFileSync(new URL('insurer-state.json', root), 'utf8')) as {
  claims?: { claimId: unknown; evidenceDoc?: ClaimEvidence }[];
  detections?: { claimId?: unknown; filedBy?: string; paymentTxs: string[] }[];
};
const cover = new KuasaCover(connect(), BigInt(st.cover));

const docs: { claimId: bigint; doc: ClaimEvidence }[] = [
  ...(ins.claims ?? []).filter((c) => c.evidenceDoc).map((c) => ({ claimId: big(c.claimId), doc: c.evidenceDoc! })),
  ...(ins.detections ?? []).filter((d) => d.filedBy === 'insurer' && d.claimId !== undefined)
    .map((d) => ({ claimId: big(d.claimId), doc: { v: 2, reason: 'AM10', paymentTxs: [...d.paymentTxs], note: 'detected on-chain and filed by the insurer' } as ClaimEvidence })),
];
const out = new URL('../docs/explorer/evidence/', import.meta.url);
mkdirSync(out, { recursive: true });
const seen = new Set<string>();
for (const { claimId, doc } of docs) {
  const hash = await evidenceHash(doc);
  if (seen.has(hash)) continue;
  const onChain = (await cover.claim(claimId))?.evidence;
  if (onChain !== hash) { console.log(`claim #${claimId}: hash differs from the chain, not published`); continue; }
  seen.add(hash);
  writeFileSync(new URL(`${hash}.json`, out), canonicalJson(doc));
  console.log(`claim #${claimId}: evidence/${hash}.json`);
}
process.exit(0);
