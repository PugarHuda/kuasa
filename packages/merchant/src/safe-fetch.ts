import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Fetches attacker-supplied URLs (mandate documents, proof records) without SSRF:
 * https only, public addresses only, no redirects, bounded time and size.
 * ponytail: DNS is checked before connecting; a rebinding resolver could still race this.
 * Pin the resolved IP in a custom agent if mandates are ever fetched from untrusted hosts at scale.
 */
export async function safeFetchText(url: string, opts: { timeoutMs?: number; maxBytes?: number; localOrigin?: string } = {}): Promise<string> {
  const u = new URL(url);
  // Dev only: exactly one trusted local origin (e.g. this shop serving its own demo documents).
  const local = !!opts.localOrigin && u.origin === new URL(opts.localOrigin).origin;
  if (!local) {
    if (u.protocol !== 'https:') throw new Error('only https URLs are accepted');
    const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('host resolves to a non-public address');
  }
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
  if (!res.ok) throw new Error(`upstream returned ${res.status}`);
  const max = opts.maxBytes ?? 256 * 1024;
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new Error('response too large'); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function isPrivate(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9')
    || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
}
