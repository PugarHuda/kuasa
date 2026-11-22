/**
 * Kuasa Explorer: a read-only public view of Kuasa Cover on Concordium testnet, straight from the
 * chain over gRPC-web (no backend, no keys). Policies, claims, the pool and proof of solvency are
 * recomputed in the browser from the kuasa-cover contract and the pool account.
 */
import { type Claim, type Policy } from '@kuasa/core';
import { quote, solvency } from '@kuasa/cover';
import { attestationOf, COVER_V1, coverOf, CURRENT, decisionOf, eudemoOf, holdOf, insurerInfo, MARKET, marketInsurers, POOL, poolBalance, scan } from './chain.js';

const LABELS: Record<string, string> = {
  '4WmdhhLRPTk92STxiaXQFFNyJFLaM6k5kRq1ryFN8xjho1aq3s': 'Alice (owner)',
  '4DRGyL6GkXQXs8CT7KovczM9SbwVgn8KsKAvQtFt4G4puhXKLc': "Alice's agent",
  '4j733XjURhA9UFkxfNbZHsKpRSMvnbQjJyjbbMHUKuzMu8huDH': 'Teen (owner)',
  '4Gw69UEYtxxE1EroXsp3AwAZWa38cKCuQZCgs9HYLc1Xys4oqg': "Teen's agent",
  '48gu4xmZFUdXDqGtZCAyL1FhsacGGbd4DR2EqxjQNkggDy7xT6': 'Bob (owner)',
  '44eHEQ2L14PfzVn3UDYLZq2injuFMegoVFHshFyxgYNnhW1965': "Bob's agent",
  '34BwTuaAu2EsgHNj3Us9TrYUNbKGo6Wnh3ixxUSanrca7KrPKv': 'Demo shop',
  [POOL]: 'Kuasa Cover pool',
  '3QLQkD8ZK4NDKEgQmxrwXkESkw3wwztrtF1sjjbYkGpHEsFcLo': 'Kuasa Re pool',
  '3EPeVYehgVZWPUCxtKSFtyKgUGKvqknxAjsECQbdve5CcbL1iC': 'Kuasa Re operator',
  '4Tw9uzZZSQmbLytV8XqRYU5dCDyrhu8yWU2xwvXovaS54sTZzJ': 'Kuasa Cover operator',
  '4HeXqTdciL1dVAaNZ6kiVRAH3syJcDnFtqLM3z3phWbAq32UNp': 'Demo shop (recorder)',
};

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const eur = (v: bigint) => (Number(v) / 1e6).toLocaleString('en', { maximumFractionDigits: 4 }) + ' EUDemo';
const acct = (a: string) => `<a href="https://ccdexplorer.io/testnet/account/${esc(a)}" target="_blank" rel="noopener" title="${esc(a)}">${esc(LABELS[a] ?? a.slice(0, 8) + '…')}</a>`;
const tx = (h: string) => `<a class="mono" href="https://ccdexplorer.io/testnet/transaction/${esc(h)}" target="_blank" rel="noopener">${esc(h.slice(0, 8))}…</a>`;
const day = (ms: bigint) => new Date(Number(ms)).toISOString().slice(0, 10);

function decidedBy(d: Awaited<ReturnType<typeof decisionOf>> | undefined) {
  if (!d?.by) return '<span class="muted">–</span>';
  const code = d.reason ? ` <span class="mono" title="reason code">${esc(d.reason)}</span>` : '';
  const who = d.by === 'auto' ? '<span class="pill warn">automatic</span>' : d.by === 'panel' ? '<span class="pill ok">appeals panel</span>' : '<span class="pill ok">human</span>';
  return who + code;
}

function attested(a: string | null | undefined) {
  if (!a) return '<span class="muted">–</span>';
  return a === 'orders-match' ? '<span class="pill ok">orders match</span>' : a === 'orders-unknown' ? '<span class="pill bad">no such orders</span>' : '<span class="pill warn">partial</span>';
}

function statusPill(tag: string) {
  const cls = tag === 'Paid' || tag === 'Active' ? 'ok' : tag === 'Rejected' || tag === 'Fraud' || tag === 'Cancelled' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${esc(tag)}</span>`;
}

type Ref = { cover: bigint; id: number };
/** Row label: v1 ids are shown as before, later books carry their contract index. */
const ref = (r: Ref | undefined, i: number) => {
  if (!r) return `#${i}`;
  if (r.cover === COVER_V1) return `v1 #${r.id}`;
  const m = MARKET.find((x) => x.cover === r.cover);
  return m ? `${m.name.replace('Kuasa ', '')} #${r.id}` : `#${r.id}`;
};
let policyRefs: Ref[] = [], claimRefs: Ref[] = [];
const ratio = (paid: bigint, premiums: bigint) => (premiums === 0n ? '–' : `${(Number((paid * 1000n) / premiums) / 10).toFixed(1)}%`);
let liveRatio = '–';
function render(policies: Policy[], claims: Claim[], pool: bigint, decisions: (Awaited<ReturnType<typeof decisionOf>>)[] = [], attests: (string | null)[] = []) {
  const now = Date.now();
  const s = solvency({ pool, now, policies, claims: claims.map((c) => ({ status: c.status.tag })) });
  $('stats').innerHTML = [
    ['Pool', eur(s.pool)], ['Live exposure', eur(s.exposure)], ['Coverage', s.coverage === null ? '–' : `×${s.coverage}`],
    ['Live policies', String(s.livePolicies)], ['Premiums in', eur(s.premiums)], ['Paid out', eur(s.paidOut)],
    // claims paid / premiums earned: the number an insurer and its regulator watch first. The early books
    // (v1, v2) were the build-up, with demo claims staged on purpose; v3 and the market are the live book.
    ['Loss ratio (all books)', ratio(s.paidOut, s.premiums)],
    ['Loss ratio (v3 + market)', liveRatio],
    // what the price is built for (docs/PRICING.md, Monte Carlo over the real assessor): the testnet book is
    // dominated by claims staged on purpose, far above any real agent's mistake rate
    ['Loss ratio priced for', '35% (0.5% mistakes)'],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  // Pool vs the cover it owes: one series, the title names it, values labelled.
  const max = s.pool > s.exposure ? s.pool : s.exposure;
  const pct = (v: bigint) => (max === 0n ? 0 : Number((v * 1000n) / max) / 10);
  $('solvency-chart').innerHTML = `<h3>Pool and the cover it owes (EUDemo)</h3><div class="hbar">${[['Pool', s.pool], ['Live exposure', s.exposure]]
    .map(([k, v]) => `<span>${k}</span><div class="track" title="${k}: ${eur(v as bigint)}"><div class="fill" style="width:${pct(v as bigint)}%"></div></div><span>${eur(v as bigint)}</span>`).join('')}</div>`;
  $('solvent').innerHTML = `<span class="pill ${s.solvent ? 'ok' : 'bad'}">${s.solvent ? 'Solvent: the pool covers every live limit' : 'Under-reserved'}</span>`;

  $('policies').innerHTML = policies.map((p, i) => {
    const live = p.status === 'Active' && Number(p.validUntilMs) > now;
    return `<tr><td>${ref(policyRefs[i], i)}</td><td>${acct(p.agentPayer)}</td><td>${typeof p.kind === 'object' ? 'one order' : 'period'}</td><td class="n">${eur(p.limit)}</td><td class="n">${eur(p.paidOut)}</td><td class="n">${eur(p.premium)}</td><td>${tx(p.premiumTx)}</td><td>${day(p.validUntilMs)}</td><td>${statusPill(live ? 'Active' : p.status === 'Active' ? 'Expired' : p.status)}</td></tr>`;
  }).reverse().join('');

  $('claims').innerHTML = claims.map((c, i) => {
    const payout = c.status.tag === 'Paid' ? tx((c.status as { payoutTx: string }).payoutTx) : '–';
    return `<tr><td>${ref(claimRefs[i], i)}</td><td>${ref(claimRefs[i] && { cover: claimRefs[i].cover, id: Number(c.policyId) }, Number(c.policyId))}</td><td>${esc(c.kind)}</td><td>${acct(c.claimant)}</td><td class="n">${eur(c.amount)}</td><td class="n">${c.payout ? eur(c.payout) : '–'}</td><td>${payout}</td><td>${decidedBy(decisions[i])}</td><td>${attested(attests[i])}</td><td>${statusPill(c.status.tag)}</td></tr>`;
  }).reverse().join('');
  // Claims by outcome: fixed category order and colours, legend always present, counts labelled.
  const cats = [
    { key: 'auto', label: 'Paid automatically', color: 'var(--s1)', n: claims.filter((c, i) => c.status.tag === 'Paid' && decisions[i]?.by === 'auto').length },
    { key: 'human', label: 'Paid after a human decision', color: 'var(--s2)', n: claims.filter((c, i) => c.status.tag === 'Paid' && decisions[i]?.by !== 'auto').length },
    { key: 'rejected', label: 'Rejected or fraud', color: 'var(--s3)', n: claims.filter((c) => c.status.tag === 'Rejected' || c.status.tag === 'Fraud').length },
    { key: 'open', label: 'Awaiting a decision', color: 'var(--s4)', n: claims.filter((c) => !['Paid', 'Rejected', 'Fraud'].includes(c.status.tag)).length },
  ];
  const total = cats.reduce((a, c) => a + c.n, 0);
  $('claims-chart').innerHTML = decisions.length === 0 ? '<span class="muted">Reading claim decisions…</span>' : `<h3>Claims by outcome (${total})</h3>
    <div class="stack" role="img" aria-label="${cats.map((c) => `${c.label}: ${c.n}`).join(', ')}">${cats.filter((c) => c.n > 0).map((c) => `<span style="flex:${c.n};background:${c.color}" title="${c.label}: ${c.n}">${c.n}</span>`).join('')}</div>
    <div class="legend">${cats.map((c) => `<span><i style="background:${c.color}"></i>${c.label} (${c.n})</span>`).join('')}</div>${byClass(claims, decisions)}`;
  renderTimelines(claims, decisions, attests);
  $('updated').textContent = `Read from Concordium testnet at ${new Date().toLocaleTimeString()}`;
}

/** The market table: one row per insurer, from its own book, its pool and its self-description. */
async function renderMarket(books: Awaited<ReturnType<typeof scan>>['books']) {
  const rows = [{ name: 'Kuasa Cover', cover: CURRENT, pool: POOL }, ...MARKET];
  const listed = await marketInsurers().catch(() => []);
  const html: string[] = [];
  for (const r of rows) {
    const b = books.find((x) => x.cover === r.cover);
    if (!b) continue;
    const [bal, info] = await Promise.all([eudemoOf(r.pool).catch(() => 0n), insurerInfo(r.cover).catch(() => null)]);
    // Kuasa Cover's pool also backs its earlier books: its exposure counts all of them
    const own = r.cover === CURRENT ? books.filter((x) => !MARKET.some((m) => m.cover === x.cover)) : [b];
    const s = solvency({ pool: bal, now: Date.now(), policies: own.flatMap((x) => x.policies), claims: own.flatMap((x) => x.claims).map((c) => ({ status: c.status.tag })) });
    const free = s.pool > s.exposure ? s.pool - s.exposure : 0n;
    const lb = solvency({ pool: 0n, now: Date.now(), policies: b.policies, claims: b.claims.map((c) => ({ status: c.status.tag })) });
    const reg = listed.find((x) => x.pool === r.pool);
    const bond = reg ? `${(Number(reg.bond) / 1e6).toLocaleString('en')} CCD${reg.exitAt !== null ? ' (leaving)' : ''}` : 'not listed';
    html.push(`<tr><td>${esc(r.name)}</td><td class="n">${esc(bond)}</td><td class="mono"><a href="https://ccdexplorer.io/testnet/instance/${r.cover}/0" target="_blank" rel="noopener">&lt;${r.cover},0&gt;</a></td><td>${info?.price ? `×${Number(info.price) / 10_000}` : '–'}</td><td class="n">${eur(s.pool)}</td><td class="n">${eur(s.exposure)}</td><td class="n">${eur(free)}</td><td class="n">${s.exposure > 0n ? `×${(Number(s.pool) / Number(s.exposure)).toFixed(2)}` : '–'}</td><td class="n">${b.policies.length}</td><td class="n">${ratio(lb.paidOut, lb.premiums)}</td></tr>`);
  }
  $('market').innerHTML = html.join('') || '<tr><td colspan="10" class="muted">–</td></tr>';
}

/** Paid out per risk class (reason-code family from the published decision): what each class of capital carries. */
function byClass(claims: Claim[], decisions: (Awaited<ReturnType<typeof decisionOf>>)[]) {
  const sums: Record<string, bigint> = { AM: 0n, WI: 0n, ML: 0n, other: 0n };
  claims.forEach((c, i) => { if (c.status.tag === 'Paid') { const k = decisions[i]?.reason?.slice(0, 2) ?? ''; sums[k in sums ? k : 'other'] += c.payout; } });
  const names: Record<string, string> = { AM: 'agent mistakes (AM)', WI: 'wrong items (WI)', ML: 'merchant loss (ML)', other: 'no reason code (before codes)' };
  return `<p class="muted" style="margin:10px 0 0">Paid by risk class: ${Object.entries(sums).filter(([, v]) => v > 0n).map(([k, v]) => `${names[k]} ${eur(v)}`).join(' · ') || '–'}</p>`;
}

const OPERATOR = '4Tw9uzZZSQmbLytV8XqRYU5dCDyrhu8yWU2xwvXovaS54sTZzJ';
const REASONS: Record<string, string> = { AM10: 'duplicate charge', AM20: 'outside the owner-signed intent', WI10: 'wrong item delivered', ML10: 'merchant loss' };
/** One claim's life, from what the chain holds: filing, the shop's attestation, the decision, the payout. */
function renderTimelines(claims: Claim[], decisions: (Awaited<ReturnType<typeof decisionOf>>)[], attests: (string | null)[]) {
  const pick = $('claim-pick') as HTMLSelectElement;
  const keep = pick.value;
  pick.innerHTML = claims.map((c, i) => `<option value="${i}">Claim ${ref(claimRefs[i], i)}: ${esc(c.kind)}, ${eur(c.amount)} (${esc(c.status.tag)})</option>`).reverse().join('');
  if (keep !== '' && Number(keep) < claims.length) pick.value = keep;
  const draw = () => {
    const i = Number(pick.value);
    const c = claims[i], d = decisions[i], a = attests[i];
    if (!c) return;
    const decided = ['Approved', 'Rejected', 'Paid', 'Fraud'].includes(c.status.tag);
    const step = (on: boolean, title: string, detail: string) => `<li class="${on ? '' : 'off'}"><b>${title}</b><span class="d">${detail}</span></li>`;
    const why = d?.reason && REASONS[d.reason] ? ` · claimed as ${esc(REASONS[d.reason])}` : '';
    $('timeline').innerHTML = [
      step(true, c.claimant === OPERATOR ? 'Filed by the insurer for the agent (parametric)' : 'Filed', `${acct(c.claimant)} claimed ${eur(c.amount)} for ${c.orders.length} order(s); evidence hash <span class="mono">${esc(c.evidence.slice(0, 12))}…</span>`),
      step(!!a, 'Shop attests', a ? attested(a) : 'no attestation from the shop'),
      step(decided, 'Decided', d?.by ? `${decidedBy(d)} ${esc(d.verdict ?? '')}${why}` : decided ? statusPill(c.status.tag) : 'awaiting a decision (the objection window runs first)'),
      step(c.status.tag === 'Paid', 'Paid', c.status.tag === 'Paid' ? `${eur(c.payout)} to the agent, tx ${tx((c.status as { payoutTx: string }).payoutTx)}` : c.status.tag === 'Rejected' || c.status.tag === 'Fraud' ? 'not paid' : '–'),
    ].join('');
    // content-addressed evidence (docs/explorer/evidence/<hash>.json): linked when published; its sha256 is the on-chain hash
    const hash = c.evidence;
    void fetch(`evidence/${hash}.json`, { method: 'HEAD' }).then((r) => {
      const span = $('timeline').querySelector('span.mono');
      if (r.ok && span && Number(pick.value) === i) span.outerHTML = `<a class="mono" href="evidence/${esc(hash)}.json" target="_blank" rel="noopener" title="sha256 of this document is the claim's on-chain evidence">${esc(hash.slice(0, 12))}… (document)</a>`;
    }).catch(() => {});
  };
  pick.onchange = draw;
  draw();
}

/** Premium calculator: the insurer's quote() on the form's inputs. */
function calc() {
  const f = new FormData($('calc') as HTMLFormElement);
  const n = (k: string) => Math.max(0, Math.floor(Number(f.get(k)) || 0));
  const E = 1_000_000n;
  const base = {
    limit: BigInt(Math.max(1, n('limit'))) * E, days: Math.min(365, Math.max(1, n('days'))),
    mandate: { maxPerOrder: BigInt(Math.max(1, n('maxPerOrder'))) * E, categories: [String(f.get('category'))], merchants: f.get('merchants') ? ['shop'] : undefined },
    provenAgeAndResidency: !!f.get('proven'), ownerKind: (f.get('business') ? 'business' : 'person') as 'person' | 'business',
    incidents: n('incidents'), receipts: n('receipts'), paidClaims: n('paidClaims'), bonded: !!f.get('bonded'), recentOrders: n('recentOrders'), recentSpend: BigInt(n('recentSpend')) * E,
  };
  const q = quote(base);
  if ('refused' in q) { $('premium').textContent = q.refused; $('factors').innerHTML = ''; return; }
  $('premium').textContent = `${eur(q.premium)} for ${base.days} days`;
  $('factors').innerHTML = q.factors.map((x) => `<tr><td>${esc(x.name)}</td><td class="n">×${x.multiplier}</td><td class="muted">${esc(x.reason)}</td></tr>`).join('');
  const o = quote({ ...base, order: { amount: base.mandate.maxPerOrder } });
  if (!('refused' in o)) $('order-premium').textContent = `One order of ${eur(base.mandate.maxPerOrder)} instead: ${eur(o.premium)} (${o.factors.map((x) => `${x.name} ×${x.multiplier}`).join(', ')}).`;
}

async function load() {
  try {
    const [{ policies, claims, policyRefs: pr, claimRefs: cr, books }, pool] = await Promise.all([scan(), poolBalance()]);
    policyRefs = pr; claimRefs = cr;
    const live = books.filter((b) => b.cover >= CURRENT);
    const liveS = solvency({ pool: 0n, now: Date.now(), policies: live.flatMap((b) => b.policies), claims: live.flatMap((b) => b.claims).map((c) => ({ status: c.status.tag })) });
    liveRatio = ratio(liveS.paidOut, liveS.premiums);
    void renderMarket(books);
    render(policies, claims, pool);
    // decisions are read after the first paint (one registry read per claim)
    const decisions: Awaited<ReturnType<typeof decisionOf>>[] = [];
    const attests: (string | null)[] = [];
    for (let i = 0; i < claims.length; i++) { // one at a time: gentle on the public node
      const { cover, id } = cr[i];
      decisions.push(await decisionOf(id, cover).catch(() => decisionOf(id, cover)).catch(() => null));
      attests.push(await attestationOf(id, cover).catch(() => attestationOf(id, cover)).catch(() => null));
    }
    render(policies, claims, pool, decisions, attests);
    // circuit breaker: agents the insurer paused after spotting duplicate orders on-chain
    const payers = [...new Set(policies.map((p) => p.agentPayer))];
    const held: string[] = [];
    for (const p of payers) { const h = await holdOf(p).catch(() => null); if (h) held.push(`${acct(p)} <span class="pill bad">paused: ${esc(h.reason ?? 'hold')}</span>`); }
    $('holds').innerHTML = held.length ? `Circuit breaker: ${held.join(' · ')}` : '<span class="pill ok">Circuit breaker: no agent paused</span>';
  } catch (e) {
    $('updated').textContent = `Could not read testnet: ${(e as Error).message}`;
  }
}

/**
 * Embeddable "insured by Kuasa" badge for a shop page: ?badge=<agent payer account>. Read from the cover
 * contract and the insurer's circuit breaker in the visitor's browser, so a shop cannot fake it.
 */
async function badge(payer: string) {
  document.body.innerHTML = `<a id="b" class="pill warn" style="margin:8px;display:inline-block" href="https://kuasa-explorer.vercel.app/" target="_blank" rel="noopener">Kuasa Cover: checking…</a>`;
  const b = document.getElementById('b')!;
  try {
    // every insurer on the market: period cover adds up, as the shop counts it
    const [views, h] = await Promise.all([Promise.all([CURRENT, ...MARKET.map((m) => m.cover)].map((c) => coverOf(payer, c))), holdOf(payer).catch(() => null)]);
    const v = { policyId: views.find((x) => x.policyId !== null)?.policyId ?? null, periodRemaining: views.reduce((a, x) => a + x.periodRemaining, 0n) };
    const live = v.policyId !== null && v.periodRemaining > 0n;
    b.className = `pill ${h ? 'bad' : live ? 'ok' : 'warn'}`;
    b.textContent = h ? 'Kuasa Cover: agent paused by the insurer' : live ? `Insured by Kuasa Cover · ${eur(v.periodRemaining)} of cover left` : 'Not insured by Kuasa Cover';
    b.title = `${payer} · read from kuasa-cover on Concordium testnet`;
  } catch {
    b.textContent = 'Kuasa Cover: not a valid agent account';
  }
}

const badgeFor = new URLSearchParams(location.search).get('badge');
if (badgeFor) void badge(badgeFor);
else {
  $('calc').addEventListener('input', calc);
  calc();
  void load();
  setInterval(load, 60_000);
}


/** Try it live: the hosted shop + insurer run the parametric claim and stream what happens. */
const TRY_URL = 'https://kuasa-live.onrender.com/try';
const linkify = (line: string) => esc(line).replace(/https:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? `${u.slice(0, 57)}…` : u}</a>`);
// wake the hosted demo as soon as the page opens (and show its state): it is up by the time someone presses the button
const showStatus = () => fetch(TRY_URL.replace(/\/try$/, '/status')).then((r) => r.json()).then((st: { running: boolean; runsLeftToday: number; agentEUDemo: number | null }) => {
  $('try-note').textContent = `Live server up. ${st.running ? 'A run is in progress right now. ' : ''}${st.runsLeftToday} live runs left today; the demo agent holds ${st.agentEUDemo ?? '?'} EUDemo (testnet).`;
}).catch(() => undefined);
void showStatus();
$('try-run').addEventListener('click', async () => {
  const btn = $('try-run') as HTMLButtonElement;
  const out = $('try-out');
  btn.disabled = true; out.hidden = false; out.innerHTML = 'Starting (waking the server if it was asleep)…\n';
  try {
    const r = await fetch(TRY_URL, { method: 'POST' });
    if (!r.ok || !r.body) { out.innerHTML += esc(await r.text()); return; }
    out.innerHTML = '';
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const l of lines) out.innerHTML += `${linkify(l)}\n`;
      out.scrollTop = out.scrollHeight;
    }
  } catch (e) { out.innerHTML += esc(`could not reach the live server: ${(e as Error).message}`); }
  finally { btn.disabled = false; }
});

/** Mistake to payout, measured on-chain over the recorded runs (scripts/payout-speed.ts). */
void fetch('payout-speed.json').then((r) => r.json()).then((k: { medianSeconds: number; runs: { claim: number; mistake: string; payout: string; seconds: number }[] }) => {
  const m = (s: number) => `${Math.floor(s / 60)} min ${s % 60} s`;
  $('payout-speed').innerHTML = `<b>From the mistake to the payout: ${m(k.medianSeconds)}</b> (median of ${k.runs.length} runs, block times on-chain), with no human. Most of it is the objection window the contract enforces before an automatic payout. Runs: ${k.runs.map((r) => `claim ${r.claim} <a href="https://ccdexplorer.io/testnet/transaction/${esc(r.mistake)}" target="_blank" rel="noopener">${m(r.seconds)}</a>`).join(' · ')}`;
}).catch(() => undefined);
