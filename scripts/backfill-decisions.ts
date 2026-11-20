/**
 * Publishes past claim decisions on the insurer's CIS-8004 entry (kuasa:decision:<id>), from the
 * insurer's own records (current state + archived states). New decisions are published by the
 * insurer service as they happen. Idempotent: keys already set are skipped.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cis8004GetMetadata, cis8004SetMetadata, connect, wallet } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const root = new URL('../.kuasa/', import.meta.url);
const state = JSON.parse(readFileSync(new URL('state.json', root), 'utf8')) as { insurerAgent: string };
const files = [new URL('insurer-state.json', root), ...readdirSync(new URL('archive/', root)).map((d) => new URL(`archive/${d}/insurer-state.json`, root))].filter(existsSync);
const big = (x: unknown) => String((x as { $big?: string })?.$big ?? x);

type Rec = { claimId: unknown; verdict?: string; decidedBy?: string; paid?: string; assessment?: { noEvidence?: boolean } };
const decided = new Map<string, string>();
for (const f of files) {
  for (const c of (JSON.parse(readFileSync(f, 'utf8')).claims ?? []) as Rec[]) {
    if (!c.verdict) continue;
    const by = c.decidedBy === 'auto' || c.assessment?.noEvidence ? 'auto' : 'human';
    decided.set(big(c.claimId), `by=${by};verdict=${c.verdict};paid=${c.paid ?? '-'};at=backfill`);
  }
}

const grpc = connect();
const acc = loadProfile('insurer').accounts.find((a) => a.credNumber === 0)!;
for (const [id, value] of [...decided].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const key = `kuasa:decision:${id}`;
  if (await cis8004GetMetadata(grpc, state.insurerAgent, key)) { console.log(key, 'already published'); continue; }
  const r = await cis8004SetMetadata(grpc, state.insurerAgent, key, value, wallet(acc.address, acc.key));
  console.log(key, value.split(';').slice(0, 2).join(' '), r.hash);
}
process.exit(0);
