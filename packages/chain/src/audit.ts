import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Hex } from '@kuasa/core';

type Anchor = { at: string; tx: string; sha256: string; file: string; count: number };

/**
 * Audit trail for EU AI Act Art. 12 record keeping: decisions are appended locally and each batch
 * is anchored on-chain as sha256(canonical records) via `registerData`. The batch file plus the
 * anchor transaction let anyone prove the log existed unchanged at that time. No personal data
 * goes on-chain, only the hash.
 */
export class AuditLog {
  private batch: Record<string, unknown>[] = [];
  private done: Anchor[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private o: {
    dir: URL;
    /** Anchors 32 bytes on-chain (registerData); returns the transaction hash. */
    register: (data: Uint8Array) => Promise<{ hash: string }>;
    now?: () => number;
  }) {}

  private now = () => this.o.now?.() ?? Date.now();

  append(record: Record<string, unknown>) {
    // bigints as strings so the canonical form is stable JSON
    this.batch.push(JSON.parse(JSON.stringify({ at: new Date(this.now()).toISOString(), ...record }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
  }

  /** Anchors the pending batch. On failure the records stay queued for the next flush. */
  async flush(): Promise<Anchor | null> {
    if (!this.batch.length) return null;
    const records = this.batch.splice(0);
    try {
      const sha256 = await sha256Hex(canonicalJson(records));
      const { hash } = await this.o.register(Uint8Array.from(Buffer.from(sha256, 'hex')));
      mkdirSync(this.o.dir, { recursive: true });
      const at = new Date(this.now()).toISOString();
      const url = new URL(`${at.replace(/[:.]/g, '-')}-${sha256.slice(0, 8)}.json`, this.o.dir);
      writeFileSync(url, JSON.stringify({ anchorTx: hash, sha256, records }, null, 2));
      const a = { at, tx: hash, sha256, file: fileURLToPath(url), count: records.length };
      this.done.push(a);
      return a;
    } catch (e) {
      this.batch.unshift(...records); // never lose records
      throw e;
    }
  }

  anchors = () => this.done.slice();

  /** Flushes every `intervalMs` when there is something to anchor. */
  start(intervalMs = 60_000, onError: (e: Error) => void = () => {}) {
    this.timer ??= setInterval(() => { this.flush().catch(onError); }, intervalMs);
    this.timer.unref?.();
    return this;
  }
}
