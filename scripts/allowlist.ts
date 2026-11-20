/**
 * Puts demo accounts on the EUDemo allow list, the same way the allowlist dApp does with a browser
 * wallet: prove EU nationality (Web3Id V0, account credential), have Concordium's verifier check it,
 * then ask the distribution backend to allow-list the account and send it test EUDemo.
 *
 * Usage: pnpm --filter @kuasa/scripts exec tsx allowlist.ts   (idempotent: skips accounts that already hold EUDemo)
 */
import * as sdk from '@concordium/web-sdk';
import { getVerifiablePresentation } from '@concordium/web-sdk/wasm';
import { connect } from '@kuasa/chain';
import { loadProfile } from './lib/identity.js';

const VERIFIER = 'https://web3id-verifier.testnet.concordium.com';
const BACKEND = 'https://allowlistapi.testnet.concordium.com';
const TOKEN = 'EUDemo';
const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
// agent payers, shop payTo, shop recorder (merchant-loss payouts), insurer treasury (premiums + payouts)
const targets: [string, number][] = [['alice', 1], ['teen', 1], ['merchant', 0], ['merchant', 1], ['insurer', 0]];

const grpc = connect();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eudemoBalance(address: string) {
  const info = await grpc.getAccountInfo(sdk.AccountAddress.fromBase58(address));
  const t = (info as any).accountTokens?.find((x: any) => String(x.id) === TOKEN);
  return t ? String(t.state.balance.value) : '0';
}

for (const [name, n] of targets) {
  const p = loadProfile(name);
  const acc = p.accounts.find((a) => a.credNumber === n)!;
  if ((await eudemoBalance(acc.address)) !== '0') { console.log(name, n, 'already holds', TOKEN); continue; }

  const values: Record<string, string> = (p.idObject.value ?? p.idObject).attributeList.chosenAttributes;
  const hd = sdk.ConcordiumHdWallet.fromHex(p.seed, 'Testnet');
  const randomness = Object.fromEntries(Object.keys(values).map((k) => [k, hd.getAttributeCommitmentRandomness(0, 0, n, sdk.AttributesKeys[k as keyof typeof sdk.AttributesKeys]).toString('hex')]));
  const presentation = getVerifiablePresentation({
    request: {
      challenge: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
      credentialStatements: [{ id: sdk.createAccountDID('Testnet', acc.credId), statement: [{ type: sdk.StatementTypes.AttributeInSet, attributeTag: 'nationality', set: EU }] as any }],
    },
    globalContext: await grpc.getCryptographicParameters(),
    commitmentInputs: [{ type: 'account', issuer: 0, values, randomness }],
  });

  const v = await fetch(`${VERIFIER}/v0/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: presentation.toString() });
  if (!v.ok) throw new Error(`${name}: verifier rejected the proof: ${v.status} ${await v.text()}`);
  console.log(name, n, 'EU nationality proof verified');

  const start = await fetch(`${BACKEND}/token-distribution/distribute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userAccount: acc.address, tokenId: TOKEN }) });
  if (!start.ok) throw new Error(`${name}: distribution refused: ${start.status} ${await start.text()}`);
  const { processId } = await start.json();
  for (let i = 0; i < 60; i++) {
    const s = await (await fetch(`${BACKEND}/token-distribution/status/${processId}`)).json();
    if (s.status === 'completed') { console.log(name, n, 'allow-listed + funded', s.result?.transactionHash ?? '', 'balance', await eudemoBalance(acc.address)); break; }
    if (s.status === 'failed') throw new Error(`${name}: distribution failed: ${s.error}`);
    await sleep(5000);
  }
}
process.exit(0);
