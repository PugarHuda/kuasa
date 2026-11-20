/** Read-only Kuasa Cover data straight from Concordium testnet over gRPC-web (browser and Node). */
import { AccountAddress, ConcordiumGRPCWebClient, ContractAddress, Parameter, ReceiveName, ReturnValue } from '@concordium/web-sdk';
import { decodeClaim, decodeCoverView, decodePolicy, encodeCoverQuery, encodeU64, type Claim, type Policy } from '@kuasa/core';
import { solvency } from '@kuasa/cover';

export const COVER = ContractAddress.create(13066n, 0n);
export const POOL = '3z1Xbe1xvT256jjptnBBPNQzESMM3xv8CYV45gEDu4PnkLmBut';
const grpc = new ConcordiumGRPCWebClient('https://grpc.testnet.concordium.com', 20000);

export async function viewCover(method: string, param: Uint8Array) {
  const r = await grpc.invokeContract({ contract: COVER, method: ReceiveName.fromString(`kuasa_cover.${method}`), parameter: Parameter.fromBuffer(param.slice().buffer as ArrayBuffer) });
  if (r.tag !== 'success' || !r.returnValue) throw new Error(`${method} failed`);
  return new Uint8Array(ReturnValue.toBuffer(r.returnValue));
}

async function all<T>(read: (id: bigint) => Promise<T | null>) {
  const out: T[] = [];
  for (let i = 0n; ; i++) { const x = await read(i); if (!x) break; out.push(x); }
  return out;
}

export async function scan() {
  const [policies, claims] = await Promise.all([
    all((id) => viewCover('policy', encodeU64(id)).then(decodePolicy)) as Promise<Policy[]>,
    all((id) => viewCover('claim', encodeU64(id)).then(decodeClaim)) as Promise<Claim[]>,
  ]);
  return { policies, claims };
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
  const { policies, claims } = await scan();
  const paidClaims = claims.filter((c) => c.status.tag === 'Paid' && policies[Number(c.policyId)]?.agentPayer === payer).length;
  return { payer, paidClaims, premiumMultiplier: Math.min(2, 1 + 0.2 * paidClaims), source: 'kuasa-cover <13066,0>' };
}

export async function coverOf(payer: string) {
  AccountAddress.fromBase58(payer);
  return decodeCoverView(await viewCover('coverOf', encodeCoverQuery(payer)));
}

const REGISTRY = ContractAddress.create(12802n, 0n);
const INSURER_TOKEN = [0x22, 0x05, 0, 0, 0, 0, 0, 0]; // the insurer's own CIS-8004 agent token
const lenPrefixed = (b: Uint8Array) => { const out = new Uint8Array(4 + b.length); new DataView(out.buffer).setUint32(0, b.length, true); out.set(b, 4); return out; };

/** The insurer publishes each claim decision on its CIS-8004 entry: by=auto|human;verdict=...;paid=... */
export async function decisionOf(claimId: number) {
  const param = Uint8Array.from([INSURER_TOKEN.length, ...INSURER_TOKEN, ...lenPrefixed(new TextEncoder().encode(`kuasa:decision:${claimId}`))]);
  const r = await grpc.invokeContract({ contract: REGISTRY, method: ReceiveName.fromString('CIS-8004.getMetadata'), parameter: Parameter.fromBuffer(param.buffer as ArrayBuffer) });
  if (r.tag !== 'success' || !r.returnValue) return null;
  const b = new Uint8Array(ReturnValue.toBuffer(r.returnValue));
  if (b[0] !== 1) return null;
  const n = new DataView(b.buffer, b.byteOffset + 1, 4).getUint32(0, true);
  const fields = Object.fromEntries(new TextDecoder().decode(b.subarray(5, 5 + n)).split(';').map((kv) => kv.split('=') as [string, string]));
  return { by: fields.by as 'auto' | 'human' | undefined, verdict: fields.verdict };
}
