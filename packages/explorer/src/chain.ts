/** Read-only Kuasa Cover data straight from Concordium testnet over gRPC-web (browser and Node). */
import { AccountAddress, ConcordiumGRPCWebClient, ContractAddress, Parameter, ReceiveName, ReturnValue } from '@concordium/web-sdk';
import { decodeClaim, decodeCoverView, decodePolicy, encodeCoverQuery, encodeU64, type Claim, type Policy } from '@kuasa/core';
import { solvency } from '@kuasa/cover';

/** kuasa-cover instances, oldest first: v1 (history) and v2 (current, automation rules on-chain). */
export const COVER_V1 = 13066n;
export const COVERS = [COVER_V1, 13100n];
export const CURRENT = COVERS[COVERS.length - 1];
/** v1 claim records keep un-namespaced CIS-8004 keys; later contracts namespace them (same rule as @kuasa/chain claimKey). */
export const claimKey = (kind: 'decision' | 'attest', cover: bigint, id: number | bigint) =>
  cover === COVER_V1 ? `kuasa:${kind}:${id}` : `kuasa:${kind}:${cover}:${id}`;
export const POOL = '3z1Xbe1xvT256jjptnBBPNQzESMM3xv8CYV45gEDu4PnkLmBut';
const grpc = new ConcordiumGRPCWebClient('https://grpc.testnet.concordium.com', 20000);

export async function viewCover(method: string, param: Uint8Array, cover = CURRENT) {
  const r = await grpc.invokeContract({ contract: ContractAddress.create(cover, 0n), method: ReceiveName.fromString(`kuasa_cover.${method}`), parameter: Parameter.fromBuffer(param.slice().buffer as ArrayBuffer) });
  if (r.tag !== 'success' || !r.returnValue) throw new Error(`${method} failed`);
  return new Uint8Array(ReturnValue.toBuffer(r.returnValue));
}

async function all<T>(read: (id: bigint) => Promise<T | null>) {
  const out: T[] = [];
  for (let i = 0n; ; i++) { const x = await read(i); if (!x) break; out.push(x); }
  return out;
}

async function scanBook(cover: bigint) {
  const [policies, claims] = await Promise.all([
    all((id) => viewCover('policy', encodeU64(id), cover).then(decodePolicy)) as Promise<Policy[]>,
    all((id) => viewCover('claim', encodeU64(id), cover).then(decodeClaim)) as Promise<Claim[]>,
  ]);
  return { cover, policies, claims };
}

/** Every book (ids are per contract), plus flat lists with a {cover, id} ref per row. The pool is shared. */
export async function scan() {
  const books = await Promise.all(COVERS.map(scanBook));
  return {
    books,
    policies: books.flatMap((b) => b.policies),
    claims: books.flatMap((b) => b.claims),
    policyRefs: books.flatMap((b) => b.policies.map((_, id) => ({ cover: b.cover, id }))),
    claimRefs: books.flatMap((b) => b.claims.map((_, id) => ({ cover: b.cover, id }))),
  };
}

export async function poolBalance() {
  const info = await grpc.getAccountInfo(AccountAddress.fromBase58(POOL));
  const t = (info as unknown as { accountTokens?: { id: unknown; state: { balance: { value: bigint | string } } }[] }).accountTokens?.find((x) => String(x.id) === 'EUDemo');
  return t ? BigInt(t.state.balance.value) : 0n;
}

export async function solvencyNow(s?: Awaited<ReturnType<typeof scan>>) {
  const { policies, claims } = s ?? (await scan());
  return solvency({ pool: await poolBalance(), now: Date.now(), policies, claims: claims.map((c) => ({ status: c.status.tag })) });
}

export async function riskOf(payer: string) {
  AccountAddress.fromBase58(payer); // throws on a bad address
  const { books } = await scan();
  const paidClaims = books.reduce((n, b) => n + b.claims.filter((c) => c.status.tag === 'Paid' && b.policies[Number(c.policyId)]?.agentPayer === payer).length, 0);
  return { payer, paidClaims, premiumMultiplier: Math.min(2, 1 + 0.2 * paidClaims), source: COVERS.map((c) => `kuasa-cover <${c},0>`).join(' + ') };
}

export async function coverOf(payer: string, cover = CURRENT) {
  AccountAddress.fromBase58(payer);
  return decodeCoverView(await viewCover('coverOf', encodeCoverQuery(payer), cover));
}

const REGISTRY = ContractAddress.create(12802n, 0n);
const INSURER_TOKEN = [0x22, 0x05, 0, 0, 0, 0, 0, 0]; // the insurer's own CIS-8004 agent token
const lenPrefixed = (b: Uint8Array) => { const out = new Uint8Array(4 + b.length); new DataView(out.buffer).setUint32(0, b.length, true); out.set(b, 4); return out; };

async function metadata(token: number[], key: string) {
  const param = Uint8Array.from([token.length, ...token, ...lenPrefixed(new TextEncoder().encode(key))]);
  const r = await grpc.invokeContract({ contract: REGISTRY, method: ReceiveName.fromString('CIS-8004.getMetadata'), parameter: Parameter.fromBuffer(param.buffer as ArrayBuffer) });
  if (r.tag !== 'success' || !r.returnValue) return null;
  const b = new Uint8Array(ReturnValue.toBuffer(r.returnValue));
  if (b[0] !== 1) return null;
  const n = new DataView(b.buffer, b.byteOffset + 1, 4).getUint32(0, true);
  return new TextDecoder().decode(b.subarray(5, 5 + n));
}
const fields = (v: string | null) => (v ? Object.fromEntries(v.split(';').map((kv) => kv.split('=') as [string, string])) : null);

/** The insurer publishes each claim decision on its CIS-8004 entry: by=auto|human;verdict=...;paid=... */
export async function decisionOf(claimId: number, cover = CURRENT) {
  const f = fields(await metadata(INSURER_TOKEN, claimKey('decision', cover, claimId)));
  return f ? { by: f.by as 'auto' | 'human' | undefined, verdict: f.verdict, reason: f.reason } : null;
}

/** Circuit breaker: the insurer's purchase hold on an agent payer (kuasa:hold:<payer>), if one is in force. */
export async function holdOf(payer: string) {
  const v = await metadata(INSURER_TOKEN, `kuasa:hold:${payer}`);
  return v?.startsWith('hold') ? fields(v) : null;
}

const SHOP_TOKEN = [0xf3, 0x04, 0, 0, 0, 0, 0, 0]; // the demo shop's CIS-8004 agent token
/** The shop (the other party to every purchase) attests whether a claim's orders are in its records. */
export async function attestationOf(claimId: number, cover = CURRENT) {
  const v = await metadata(SHOP_TOKEN, claimKey('attest', cover, claimId));
  return v ? v.split(';')[0] : null;
}
