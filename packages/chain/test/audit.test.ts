import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, sha256Hex } from '@kuasa/core';
import { AuditLog } from '../src/audit.js';

const dir = () => pathToFileURL(mkdtempSync(join(tmpdir(), 'audit-')) + '/');

test('flush with empty batch is a no-op; batch hash matches file content', async () => {
  const anchored: string[] = [];
  const log = new AuditLog({ dir: dir(), register: async (d) => { anchored.push(Buffer.from(d).toString('hex')); return { hash: 'ab'.repeat(32) }; }, now: () => 1_000 });
  assert.equal(await log.flush(), null);
  log.append({ kind: 'guard', amount: 24n, decision: 'allowed' });
  log.append({ kind: 'claim', id: 0n, decision: 'approved' });
  const a = await log.flush();
  assert.ok(a);
  const file = JSON.parse(readFileSync(a.file, 'utf8'));
  assert.equal(file.anchorTx, 'ab'.repeat(32));
  assert.equal(await sha256Hex(canonicalJson(file.records)), file.sha256);
  assert.deepEqual(anchored, [file.sha256], 'exactly the batch hash is anchored');
  assert.equal(file.records.length, 2);
  assert.equal(log.anchors().length, 1);
  assert.equal(await log.flush(), null, 'batch cleared after anchoring');
});

test('a failed anchor keeps the records for the next flush', async () => {
  let fail = true;
  const log = new AuditLog({ dir: dir(), register: async () => { if (fail) throw new Error('node down'); return { hash: 'cd'.repeat(32) }; } });
  log.append({ kind: 'guard' });
  await assert.rejects(log.flush());
  fail = false;
  log.append({ kind: 'guard', n: 2 });
  const a = await log.flush();
  assert.equal(JSON.parse(readFileSync(a!.file, 'utf8')).records.length, 2);
});
