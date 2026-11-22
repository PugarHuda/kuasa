/**
 * Keeps .kuasa (keys, books, receipts, audit) in Postgres for a host without a persistent disk (Render
 * free). The whole folder is one gzipped tar in one row: restored before the services start, saved
 * every 2 minutes when it changed and on shutdown.
 * Seed from the laptop: DATABASE_URL=<external url> tsx state-sync.ts --push
 * ponytail: one row, last writer wins; a crash loses at most the last 2 minutes of local state (the
 * chain itself is the record of policies, claims and payouts).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const db = () => new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('render.com') ? true : undefined }); // external URL: verified TLS; Render's internal URL: private network

// through stdin/stdout: no archive path (GNU tar on Windows reads "C:" as a remote host)
const pack = (): Buffer => execFileSync('tar', ['--exclude=.kuasa/archive', '-czf', '-', '.kuasa'], { cwd: ROOT, maxBuffer: 64 << 20 });
// gzip carries a timestamp: compare the tar's content, not the archive bytes
const digest = () => createHash('sha256').update(execFileSync('tar', ['--exclude=.kuasa/archive', '-cf', '-', '--sort=name', '--mtime=@0', '.kuasa'], { cwd: ROOT, maxBuffer: 64 << 20 })).digest('hex');

async function save(data: Buffer) {
  const c = db(); await c.connect();
  try {
    await c.query('create table if not exists kuasa_state (id int primary key, data bytea not null, at timestamptz not null default now())');
    await c.query('insert into kuasa_state (id, data) values (1, $1) on conflict (id) do update set data = excluded.data, at = now()', [data]);
  } finally { await c.end(); }
}

/** Restores .kuasa from the database; false if there is nothing saved yet. */
export async function restore() {
  const c = db(); await c.connect();
  try {
    await c.query('create table if not exists kuasa_state (id int primary key, data bytea not null, at timestamptz not null default now())');
    const r = await c.query('select data, at from kuasa_state where id = 1');
    if (!r.rows[0]) return false;
    execFileSync('tar', ['-xzf', '-'], { cwd: ROOT, input: r.rows[0].data });
    console.log(`[state] restored .kuasa saved at ${r.rows[0].at.toISOString()}`);
    return true;
  } finally { await c.end(); }
}

/** Saves every 2 minutes when the folder changed, and once more on SIGTERM (Render stops with it). */
export function startSync() {
  let last = existsSync(join(ROOT, '.kuasa')) ? digest() : '';
  const tick = async () => {
    const d = digest();
    if (d === last) return;
    await save(pack());
    last = d;
    console.log('[state] saved');
  };
  setInterval(() => void tick().catch((e) => console.error('[state] save failed', (e as Error).message)), 120_000);
  process.once('SIGTERM', () => void tick().catch(() => undefined).finally(() => process.exit(0)));
}

if (process.argv.includes('--push')) {
  await save(pack());
  console.log('[state] pushed .kuasa');
  process.exit(0);
}
