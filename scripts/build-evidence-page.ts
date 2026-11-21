/**
 * Builds docs/explorer/evidence.html from docs/TESTNET.md: every live step ("Kuasa Cover, transaction by
 * transaction") as a card with its transaction links, newest first, so judges read one page instead of a
 * markdown table. TESTNET.md stays the single source. Usage: tsx build-evidence-page.ts (then deploy).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const md = readFileSync(new URL('../docs/TESTNET.md', import.meta.url), 'utf8');
const start = md.indexOf('## Kuasa Cover, transaction by transaction');
const end = md.indexOf('\n## ', start + 10);
const rows = md.slice(start, end).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Step') && !l.startsWith('|---'));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// a small, safe inline markdown: escape first, then links (http(s) only), code and bold
const inline = (s: string) => esc(s)
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
const cells = (l: string) => l.slice(2, -2).split(' | ');
const cards = rows.map(cells).filter((c) => c.length >= 3).reverse()
  .map(([step, what, link]) => `<article class="card"><h3>${inline(step)}</h3><p>${inline(what)}</p><p class="links">${inline(link)}</p></article>`).join('\n');

writeFileSync(new URL('../docs/explorer/evidence.html', import.meta.url), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kuasa Evidence Tour</title>
<style>
  :root { --bg: #f7f7f5; --panel: #fff; --ink: #16181d; --muted: #5d6570; --line: #e3e5e8; --accent: #2f5bd3; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #0f1216; --panel: #171b21; --ink: #eef0f2; --muted: #9aa3ad; --line: #262c34; --accent: #7aa2ff; } }
  :root[data-theme="dark"] { --bg: #0f1216; --panel: #171b21; --ink: #eef0f2; --muted: #9aa3ad; --line: #262c34; --accent: #7aa2ff; }
  * { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; } h1 { margin: 0; font-size: 28px; } header p { color: var(--muted); }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin: 14px 0; }
  .card h3 { margin: 0 0 6px; font-size: 16px; } .card p { margin: 6px 0; font-size: 15px; overflow-wrap: anywhere; } .links { color: var(--muted); font-size: 14px; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; background: var(--line); padding: 0 4px; border-radius: 4px; }
</style></head>
<body><div class="wrap">
<header><h1>Kuasa evidence tour</h1>
<p>Every step below ran live on Concordium testnet (and Ethereum Sepolia for ERC-8004), newest first. Each link opens the transaction on a public explorer. ${rows.length} steps. Source: <a href="https://github.com/PugarHuda/kuasa/blob/main/docs/TESTNET.md">docs/TESTNET.md</a> · <a href="./">live explorer</a></p></header>
${cards}
</div></body></html>
`);
console.log(`evidence.html: ${rows.length} steps`);
