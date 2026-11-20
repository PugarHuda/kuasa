/**
 * Kuasa Explorer: a read-only public view of Kuasa Cover on Concordium testnet, straight from the
 * chain over gRPC-web (no backend, no keys). Policies, claims, the pool and proof of solvency are
 * recomputed in the browser from the kuasa-cover contract and the pool account.
 */
import { AccountAddress, ConcordiumGRPCWebClient, ContractAddress, Parameter, ReceiveName, ReturnValue } from '@concordium/web-sdk';

import { decodeClaim, decodePolicy, encodeU64, type Claim, type Policy } from '@kuasa/core';
import { solvency } from '@kuasa/cover';

const COVER = ContractAddress.create(13066n, 0n);
const POOL = '3z1Xbe1xvT256jjptnBBPNQzESMM3xv8CYV45gEDu4PnkLmBut';
const LABELS: Record<string, string> = {
  '4WmdhhLRPTk92STxiaXQFFNyJFLaM6k5kRq1ryFN8xjho1aq3s': 'Alice (owner)',
  '4DRGyL6GkXQXs8CT7KovczM9SbwVgn8KsKAvQtFt4G4puhXKLc': "Alice's agent",
  '4j733XjURhA9UFkxfNbZHsKpRSMvnbQjJyjbbMHUKuzMu8huDH': 'Teen (owner)',
  '4Gw69UEYtxxE1EroXsp3AwAZWa38cKCuQZCgs9HYLc1Xys4oqg': "Teen's agent",
  '34BwTuaAu2EsgHNj3Us9TrYUNbKGo6Wnh3ixxUSanrca7KrPKv': 'Demo shop',
  [POOL]: 'Kuasa Cover pool',
  '4Tw9uzZZSQmbLytV8XqRYU5dCDyrhu8yWU2xwvXovaS54sTZzJ': 'Kuasa Cover operator',
};

const grpc = new ConcordiumGRPCWebClient('https://grpc.testnet.concordium.com', 20000);
const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const eur = (v: bigint) => (Number(v) / 1e6).toLocaleString('en', { maximumFractionDigits: 4 }) + ' EUDemo';
const acct = (a: string) => `<a href="https://ccdexplorer.io/testnet/account/${esc(a)}" target="_blank" rel="noopener" title="${esc(a)}">${esc(LABELS[a] ?? a.slice(0, 8) + '…')}</a>`;
const tx = (h: string) => `<a class="mono" href="https://ccdexplorer.io/testnet/transaction/${esc(h)}" target="_blank" rel="noopener">${esc(h.slice(0, 8))}…</a>`;
const day = (ms: bigint) => new Date(Number(ms)).toISOString().slice(0, 10);

async function view(method: string, id: bigint) {
  const r = await grpc.invokeContract({ contract: COVER, method: ReceiveName.fromString(`kuasa_cover.${method}`), parameter: Parameter.fromBuffer(encodeU64(id).slice().buffer as ArrayBuffer) });
  if (r.tag !== 'success' || !r.returnValue) throw new Error(`${method} failed`);
  return new Uint8Array(ReturnValue.toBuffer(r.returnValue));
}

async function all<T>(read: (id: bigint) => Promise<T | null>) {
  const out: T[] = [];
  for (let i = 0n; ; i++) { const x = await read(i); if (!x) break; out.push(x); }
  return out;
}

async function poolBalance() {
  const info = await grpc.getAccountInfo(AccountAddress.fromBase58(POOL));
  const t = (info as unknown as { accountTokens?: { id: unknown; state: { balance: { value: bigint | string } } }[] }).accountTokens?.find((x) => String(x.id) === 'EUDemo');
  return t ? BigInt(t.state.balance.value) : 0n;
}

function statusPill(tag: string) {
  const cls = tag === 'Paid' || tag === 'Active' ? 'ok' : tag === 'Rejected' || tag === 'Fraud' || tag === 'Cancelled' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${esc(tag)}</span>`;
}

function render(policies: Policy[], claims: Claim[], pool: bigint) {
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
    return `<tr><td>#${i}</td><td>#${c.policyId}</td><td>${esc(c.kind)}</td><td>${acct(c.claimant)}</td><td class="n">${eur(c.amount)}</td><td class="n">${c.payout ? eur(c.payout) : '–'}</td><td>${payout}</td><td>${statusPill(c.status.tag)}</td></tr>`;
  }).reverse().join('');
  $('updated').textContent = `Read from Concordium testnet at ${new Date().toLocaleTimeString()}`;
}

async function load() {
  try {
    const cover = (m: string, d: (b: Uint8Array) => unknown) => (id: bigint) => view(m, id).then(d);
    const [policies, claims, pool] = await Promise.all([
      all(cover('policy', decodePolicy) as (id: bigint) => Promise<Policy | null>),
      all(cover('claim', decodeClaim) as (id: bigint) => Promise<Claim | null>),
      poolBalance(),
    ]);
    render(policies, claims, pool);
  } catch (e) {
    $('updated').textContent = `Could not read testnet: ${(e as Error).message}`;
  }
}

void load();
setInterval(load, 60_000);
