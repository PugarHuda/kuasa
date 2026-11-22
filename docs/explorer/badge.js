/*
 * "Insured by Kuasa" badge for any shop page. The shop drops one tag where the badge should appear:
 *   <script src="https://kuasa-explorer.vercel.app/badge.js" data-payer="<agent payer account>"></script>
 * It asks the insurer's public, read-only A2A skill (cover-status) what the contract says about that agent's
 * cover, and shows it. No keys, no cookies; the answer is read from Concordium testnet.
 */
(() => {
  const me = document.currentScript;
  const payer = me && me.dataset.payer;
  if (!payer) return;
  const box = document.createElement('a');
  box.href = 'https://kuasa-explorer.vercel.app/';
  box.target = '_blank';
  box.rel = 'noopener';
  Object.assign(box.style, { display: 'inline-flex', gap: '8px', alignItems: 'center', padding: '6px 12px', borderRadius: '999px', font: '600 13px system-ui, sans-serif', textDecoration: 'none', border: '1px solid #2a7', color: '#185', background: '#effaf3' });
  box.textContent = 'Kuasa Cover: checking…';
  me.after(box);
  fetch('https://kuasa-explorer.vercel.app/a2a', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: String(Date.now()), parts: [{ kind: 'data', data: { skill: 'cover-status', payer } }] } } }),
  }).then((r) => r.json()).then((j) => {
    const c = j.result && j.result.parts && j.result.parts[0] && j.result.parts[0].data && j.result.parts[0].data.onChain;
    const left = c ? Number(c.periodRemaining) / 1e6 : 0;
    if (c && c.policyId !== null && left > 0) box.textContent = `✔ Insured by Kuasa Cover · ${left} EUDemo of cover left (on-chain)`;
    else { box.textContent = '✖ Not insured by Kuasa Cover'; Object.assign(box.style, { borderColor: '#b44', color: '#933', background: '#fdf0f0' }); }
  }).catch(() => { box.textContent = 'Kuasa Cover: status unavailable'; });
})();
