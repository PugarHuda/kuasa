/**
 * Kuasa Explorer: a read-only public view of Kuasa Cover on Concordium testnet, straight from the
 * chain over gRPC-web (no backend, no keys). Policies, claims, the pool and proof of solvency are
 * recomputed in the browser from the kuasa-cover contract and the pool account.
 */
import { type Claim, type Policy } from '@kuasa/core';
import { solvency } from '@kuasa/cover';
import { attestationOf, decisionOf, POOL, poolBalance, scan } from './chain.js';

const LABELS: Record<string, string> = {
  '4WmdhhLRPTk92STxiaXQFFNyJFLaM6k5kRq1ryFN8xjho1aq3s': 'Alice (owner)',
  '4DRGyL6GkXQXs8CT7KovczM9SbwVgn8KsKAvQtFt4G4puhXKLc': "Alice's agent",
  '4j733XjURhA9UFkxfNbZHsKpRSMvnbQjJyjbbMHUKuzMu8huDH': 'Teen (owner)',
  '4Gw69UEYtxxE1EroXsp3AwAZWa38cKCuQZCgs9HYLc1Xys4oqg': "Teen's agent",
  '34BwTuaAu2EsgHNj3Us9TrYUNbKGo6Wnh3ixxUSanrca7KrPKv': 'Demo shop',
  [POOL]: 'Kuasa Cover pool',
  '4Tw9uzZZSQmbLytV8XqRYU5dCDyrhu8yWU2xwvXovaS54sTZzJ': 'Kuasa Cover operator',
};

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const eur = (v: bigint) => (Number(v) / 1e6).toLocaleString('en', { maximumFractionDigits: 4 }) + ' EUDemo';
const acct = (a: string) => `<a href="https://ccdexplorer.io/testnet/account/${esc(a)}" target="_blank" rel="noopener" title="${esc(a)}">${esc(LABELS[a] ?? a.slice(0, 8) + '…')}</a>`;
const tx = (h: string) => `<a class="mono" href="https://ccdexplorer.io/testnet/transaction/${esc(h)}" target="_blank" rel="noopener">${esc(h.slice(0, 8))}…</a>`;
const day = (ms: bigint) => new Date(Number(ms)).toISOString().slice(0, 10);

function decidedBy(d: Awaited<ReturnType<typeof decisionOf>> | undefined) {
  if (!d?.by) return '<span class="muted">–</span>';
  return d.by === 'auto' ? '<span class="pill warn">automatic</span>' : '<span class="pill ok">human</span>';
}

function attested(a: string | null | undefined) {
  if (!a) return '<span class="muted">–</span>';
  return a === 'orders-match' ? '<span class="pill ok">orders match</span>' : a === 'orders-unknown' ? '<span class="pill bad">no such orders</span>' : '<span class="pill warn">partial</span>';
}

function statusPill(tag: string) {
  const cls = tag === 'Paid' || tag === 'Active' ? 'ok' : tag === 'Rejected' || tag === 'Fraud' || tag === 'Cancelled' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${esc(tag)}</span>`;
}

function render(policies: Policy[], claims: Claim[], pool: bigint, decisions: (Awaited<ReturnType<typeof decisionOf>>)[] = [], attests: (string | null)[] = []) {
  const now = Date.now();
  const s = solvency({ pool, now, policies, claims: claims.map((c) => ({ status: c.status.tag })) });
  $('stats').innerHTML = [
    ['Pool', eur(s.pool)], ['Live exposure', eur(s.exposure)], ['Coverage', s.coverage === null ? '–' : `×${s.coverage}`],
    ['Live policies', String(s.livePolicies)], ['Premiums in', eur(s.premiums)], ['Paid out', eur(s.paidOut)],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  $('solvent').innerHTML = `<span class="pill ${s.solvent ? 'ok' : 'bad'}">${s.solvent ? 'Solvent: the pool covers every live limit' : 'Under-reserved'}</span>`;

  $('policies').innerHTML = policies.map((p, i) => {
    const live = p.status === 'Active' && Number(p.validUntilMs) > now;
    return `<tr><td>#${i}</td><td>${acct(p.agentPayer)}</td><td>${typeof p.kind === 'object' ? 'one order' : 'period'}</td><td class="n">${eur(p.limit)}</td><td class="n">${eur(p.paidOut)}</td><td class="n">${eur(p.premium)}</td><td>${tx(p.premiumTx)}</td><td>${day(p.validUntilMs)}</td><td>${statusPill(live ? 'Active' : p.status === 'Active' ? 'Expired' : p.status)}</td></tr>`;
  }).reverse().join('');

  $('claims').innerHTML = claims.map((c, i) => {
    const payout = c.status.tag === 'Paid' ? tx((c.status as { payoutTx: string }).payoutTx) : '–';
    return `<tr><td>#${i}</td><td>#${c.policyId}</td><td>${esc(c.kind)}</td><td>${acct(c.claimant)}</td><td class="n">${eur(c.amount)}</td><td class="n">${c.payout ? eur(c.payout) : '–'}</td><td>${payout}</td><td>${decidedBy(decisions[i])}</td><td>${attested(attests[i])}</td><td>${statusPill(c.status.tag)}</td></tr>`;
  }).reverse().join('');
  $('updated').textContent = `Read from Concordium testnet at ${new Date().toLocaleTimeString()}`;
}

async function load() {
  try {
    const [{ policies, claims }, pool] = await Promise.all([scan(), poolBalance()]);
    render(policies, claims, pool);
    // decisions are read after the first paint (one registry read per claim)
    const decisions: Awaited<ReturnType<typeof decisionOf>>[] = [];
    const attests: (string | null)[] = [];
    for (let i = 0; i < claims.length; i++) { // one at a time: gentle on the public node
      decisions.push(await decisionOf(i).catch(() => decisionOf(i)).catch(() => null));
      attests.push(await attestationOf(i).catch(() => attestationOf(i)).catch(() => null));
    }
    render(policies, claims, pool, decisions, attests);
  } catch (e) {
    $('updated').textContent = `Could not read testnet: ${(e as Error).message}`;
  }
}

void load();
setInterval(load, 60_000);
