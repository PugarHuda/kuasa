/**
 * Verify & Access V1 with a real Concordium Browser Wallet, not keys in a script.
 *   tsx wallet-proof.ts request <walletAccount>    Kuasa anchors the request (18+, EU residency, bound to that
 *                                                  account) and writes .kuasa/wallet/request.json
 *   (the wallet answers it: window.concordium.requestVerifiablePresentationV1(request), the user approves)
 *   tsx wallet-proof.ts finish <presentation.json> Kuasa checks it against the chain, anchors the audit record
 *                                                  and writes docs/explorer/wallet-proof.json
 * The hosted version of the same flow: https://kuasa-explorer.vercel.app/wallet.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from '@kuasa/chain';
import { anchorWalletRequest, checkWalletPresentation } from './lib/wallet-vp.js';

const grpc = connect();
const reqFile = new URL('../.kuasa/wallet/request.json', import.meta.url);
const [mode, arg] = process.argv.slice(2);
if (mode === 'request') {
  const r = await anchorWalletRequest(grpc, arg);
  writeFileSync(reqFile, JSON.stringify(r.request));
  console.log(`request anchored: ${r.requestAnchorTx} -> .kuasa/wallet/request.json`);
} else if (mode === 'finish') {
  const account = (JSON.parse(readFileSync(new URL('../.kuasa/wallet/browser-wallet.json', import.meta.url), 'utf8')) as { account: string }).account;
  const r = await checkWalletPresentation(grpc, JSON.parse(readFileSync(reqFile, 'utf8')), JSON.parse(readFileSync(arg, 'utf8')), account);
  if (!r.verified) throw new Error(`wallet presentation failed verification: ${r.error}`);
  writeFileSync(new URL('../docs/explorer/wallet-proof.json', import.meta.url), JSON.stringify({
    what: 'A Verify & Access V1 presentation made by the Concordium Browser Wallet (not by keys in a script): 18+ and EU residency, zero-knowledge, bound to the wallet account',
    requestAnchorTx: r.requestAnchorTx, auditAnchorTx: r.auditAnchorTx, record: r.record,
  }, null, 1));
  console.log(`verified; audit anchor ${r.auditAnchorTx} -> docs/explorer/wallet-proof.json`);
} else throw new Error('usage: wallet-proof.ts request <account> | finish <presentation.json>');
process.exit(0);
