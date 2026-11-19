/**
 * Headless testnet identity + account provisioning (no browser, no human).
 *
 * Flow: random seed -> identity request to the Concordium testnet identity provider
 * (attributes chosen by us, as the testnet IdP allows) -> identity object -> one or more
 * account credentials deployed from that identity -> CCD from the wallet-proxy testnet drop.
 *
 * Every account created from the same identity is backed by the same (test) person, which is
 * exactly Kuasa's model: the owner account and the agent's payer account share an identity,
 * so the agent's spending is accountable to that person.
 *
 * State is persisted per profile in .kuasa/accounts/<name>.json so runs are resumable.
 * TESTNET ONLY: the seed is stored in plain text.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import type { ConcordiumGRPCClient } from '@concordium/web-sdk';

const WP = 'https://wallet-proxy.testnet.concordium.com';
const DIR = new URL('../../.kuasa/accounts/', import.meta.url);
const IP_INDEX = 0; // "Concordium testnet IP"

export type Attributes = { dob: string; countryOfResidence: string; nationality: string; firstName?: string; lastName?: string };

export type Profile = {
  name: string;
  seed: string;
  attributes: Attributes;
  idObject?: any;
  accounts: { credNumber: number; credId: string; address: string; key: string; credTx?: string }[];
};

const file = (name: string) => new URL(`${name}.json`, DIR);
export const loadProfile = (name: string): Profile => JSON.parse(readFileSync(file(name), 'utf8'));
const save = (p: Profile) => { mkdirSync(DIR, { recursive: true }); writeFileSync(file(p.name), JSON.stringify(p, null, 2)); };
const log = (...a: unknown[]) => console.log('[provision]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ipAndArs(grpc: ConcordiumGRPCClient) {
  const provs = await (await fetch(`${WP}/v1/ip_info`)).json();
  const ip = provs.find((x: any) => x.ipInfo?.ipIdentity === IP_INDEX);
  const ars: any[] = [];
  for await (const a of grpc.getAnonymityRevokers()) ars.push(a);
  return { ip, arsInfos: Object.fromEntries(ars.map((a) => [String(a.arIdentity), a])), arThreshold: ars.length, gp: await grpc.getCryptographicParameters() };
}

async function issueIdentity(grpc: ConcordiumGRPCClient, p: Profile) {
  const { ip, arsInfos, arThreshold, gp } = await ipAndArs(grpc);
  const req = sdk.createIdentityRequest({ ipInfo: ip.ipInfo, globalContext: gp, arsInfos, arThreshold, seed: p.seed, net: 'Testnet', identityIndex: 0 });
  let url = `${ip.metadata.issuanceStart}?${new URLSearchParams({ scope: 'identity', response_type: 'code', redirect_uri: 'http://localhost/kuasa', state: JSON.stringify({ idObjectRequest: req }) })}`;
  let page = '';
  for (let hop = 0; hop < 6; hop++) {
    const r = await fetch(url, { redirect: 'manual' });
    if (r.status === 200) { page = await r.text(); break; }
    const loc = r.headers.get('location');
    if (!loc) throw new Error(`identity provider: unexpected ${r.status}`);
    url = new URL(loc, url).toString();
  }
  // Fill the test IdP form with our chosen attributes.
  const fields: Record<string, string> = {};
  for (const m of page.matchAll(/<input[^>]*>/gi)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    if (name && name !== 'fail') fields[name] = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
  }
  Object.assign(fields, { expiry: '2030-12', firstName: 'Kuasa', lastName: p.name }, p.attributes);
  const action = new URL(/action="([^"]+)"/.exec(page)![1], url).toString();
  let next = (await fetch(action, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })).headers.get('location');
  let codeUri: string | undefined;
  for (let hop = 0; hop < 6 && next && !codeUri; hop++) {
    codeUri = decodeURIComponent(next).match(/code_uri=(https?:\/\/[^\s&#]+)/)?.[1];
    if (!codeUri) next = (await fetch(new URL(next, action), { redirect: 'manual' })).headers.get('location');
  }
  if (!codeUri) throw new Error('identity provider did not return a code_uri');
  for (let i = 0; i < 20; i++) {
    const s = await (await fetch(codeUri)).json().catch(() => ({ status: 'pending' }));
    if (s.status === 'done') { p.idObject = s.token.identityObject; save(p); log(p.name, 'identity issued'); return; }
    if (s.status === 'error') throw new Error(`identity issuance failed: ${JSON.stringify(s)}`);
    await sleep(3000);
  }
  throw new Error('identity not issued in time');
}

async function deployAccount(grpc: ConcordiumGRPCClient, p: Profile, credNumber: number) {
  const { ip, arsInfos, gp } = await ipAndArs(grpc);
  const wallet = sdk.ConcordiumHdWallet.fromHex(p.seed, 'Testnet');
  const key = wallet.getAccountSigningKey(IP_INDEX, 0, credNumber).toString('hex');
  const expiry = sdk.TransactionExpiry.fromDate(new Date(Date.now() + 30 * 60_000));
  const cdt = sdk.createCredentialPayload({
    ipInfo: { ...ip.ipInfo, ipRealName: ip.ipInfo.ipDescription?.name ?? 'Concordium testnet IP' },
    globalContext: gp, arsInfos, idObject: p.idObject.value ?? p.idObject, revealedAttributes: [],
    credNumber, seedAsHex: p.seed, net: 'Testnet', identityIndex: 0,
  } as any, expiry);
  const sig = await sdk.signCredentialTransaction(cdt, key);
  const credId: string = (cdt.unsignedCdi as any).values?.credId ?? (cdt.unsignedCdi as any).credId;
  const address = sdk.AccountAddress.toBase58(sdk.getAccountAddress(credId));
  const acc = { credNumber, credId, address, key, credTx: undefined as string | undefined };
  p.accounts.push(acc); save(p);
  const hash = await grpc.sendCredentialDeploymentTransaction(sdk.serializeCredentialDeploymentPayload([sig], cdt), expiry);
  acc.credTx = sdk.TransactionHash.toHexString(hash); save(p);
  await grpc.waitForTransactionFinalization(hash);
  log(p.name, `account #${credNumber}`, address);
}

export async function balance(grpc: ConcordiumGRPCClient, address: string): Promise<bigint> {
  const info = await grpc.getAccountInfo(sdk.AccountAddress.fromBase58(address)).catch(() => null);
  return info ? sdk.CcdAmount.toMicroCcd(info.accountAmount) : 0n;
}

/** Testnet CCD drop. Only works once per account and only before any other incoming transfer. */
export async function drip(grpc: ConcordiumGRPCClient, address: string) {
  if ((await balance(grpc, address)) > 0n) return;
  const r = await (await fetch(`${WP}/v0/testnetGTUDrop/${address}`, { method: 'PUT' })).json().catch(() => ({}));
  if (!r.submissionId) { log('drop refused for', address, JSON.stringify(r)); return; }
  await grpc.waitForTransactionFinalization(sdk.TransactionHash.fromHexString(r.submissionId));
  log('funded', address, Number(await balance(grpc, address)) / 1e6, 'CCD');
}

/** Ensures a profile with `accountCount` funded accounts exists. Idempotent. */
export async function provision(grpc: ConcordiumGRPCClient, name: string, attributes: Attributes, accountCount = 1): Promise<Profile> {
  const p: Profile = existsSync(file(name))
    ? loadProfile(name)
    : { name, seed: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('hex'), attributes, accounts: [] };
  save(p);
  if (!p.idObject) await issueIdentity(grpc, p);
  for (let n = 0; n < accountCount; n++) {
    const existing = p.accounts.find((a) => a.credNumber === n);
    if (!existing) await deployAccount(grpc, p, n);
    else if (existing.credTx && (await balance(grpc, existing.address)) === 0n) {
      await grpc.waitForTransactionFinalization(sdk.TransactionHash.fromHexString(existing.credTx)).catch(() => undefined);
    }
    await drip(grpc, p.accounts.find((a) => a.credNumber === n)!.address);
  }
  return p;
}
