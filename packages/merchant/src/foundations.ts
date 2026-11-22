import * as sdk from '@concordium/web-sdk';
import type { ConcordiumGRPCClient, Network } from '@concordium/web-sdk';
import type { KuasaRegistry } from '@kuasa/chain';
import { type Claims, type CoverView, type Mandate, type MandateState, toMandateState } from '@kuasa/core';
import { verifyMandateProof } from './proof.js';

/**
 * Swappable foundations. Today Kuasa provides these itself; each is a stand-in for a
 * Concordium roadmap item, so the swap path is visible in code:
 *   IdentitySource -> AI Agent IDP credentials        (today: Verify & Access proof in the mandate)
 *   SpendControl   -> Protocol-Level Locks            (today: the kuasa mandate registry contract)
 */

export type ProofResult = { ok: true; claims: Claims } | { ok: false; reason: string };
export type SpendState = MandateState & { recorders: string[] };

export interface IdentitySource {
  claims(mandate: Mandate, mandateId: string): Promise<ProofResult>;
}

export interface SpendControl {
  state(mandate: Mandate, mandateId: string): Promise<SpendState | null>;
}

/** CIS-8004 Agent Registry lookup. */
export interface AgentRegistry {
  agentOf(tokenIdHex: string): Promise<{ owner: string; active: boolean } | null>;
  /** The agent's payment wallet (CIS-8004 agentWallet), null when unset (it is cleared on every transfer). */
  walletOf?(tokenIdHex: string): Promise<string | null>;
}

/** Kuasa Cover lookup (live cover for an agent payer, optionally for one order). */
export interface CoverCheck {
  coverOf(payer: string, order?: string): Promise<CoverView>;
}

const PROOF_TTL_MS = 5 * 60_000;
const PROOF_CACHE_MAX = 500;

/** Today's IdentitySource: re-verifies the owner's V&A proof referenced by the mandate (cached briefly). */
export class MandateProofIdentity implements IdentitySource {
  private cache = new Map<string, { at: number; result: Promise<ProofResult> }>();
  constructor(private o: {
    grpc: ConcordiumGRPCClient;
    network: Network;
    fetchText: (url: string) => Promise<string>;
    verify?: typeof verifyMandateProof;
    now?: () => number;
  }) {}

  private now = () => this.o.now?.() ?? Date.now();

  claims(mandate: Mandate, id: string): Promise<ProofResult> {
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < PROOF_TTL_MS) return hit.result;
    if (this.cache.size >= PROOF_CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    const result = this.o.fetchText(mandate.proof.auditRecordUri)
      .then((json) => (this.o.verify ?? verifyMandateProof)({ mandate, auditRecordJson: json, grpc: this.o.grpc, network: this.o.network }))
      .catch((): ProofResult => ({ ok: false, reason: 'proof document unavailable' }));
    this.cache.set(id, { at: this.now(), result });
    result.then((r) => { if (!r.ok) this.cache.delete(id); }); // never cache failures
    return result;
  }
}

/** Today's SpendControl: the kuasa mandate registry. */
export class MandateRegistrySpend implements SpendControl {
  constructor(private registry: Pick<KuasaRegistry, 'view'>) {}
  async state(mandate: Mandate, id: string): Promise<SpendState | null> {
    const entry = await this.registry.view(mandate.principal.account, id);
    return entry ? { ...toMandateState(entry, id), recorders: entry.recorders } : null;
  }
}

/** CIS-8004 `agentOf`, decoded with the registry's embedded schema (loaded once). */
export class Cis8004Registry implements AgentRegistry {
  private schema?: Promise<ArrayBuffer>;
  readonly address: sdk.ContractAddress.Type;
  constructor(private grpc: ConcordiumGRPCClient, index = 12802n, subindex = 0n) {
    this.address = sdk.ContractAddress.create(index, subindex);
  }

  private loadSchema() {
    this.schema ??= this.grpc.getInstanceInfo(this.address)
      .then((i) => this.grpc.getEmbeddedSchema(i.sourceModule))
      .then((s) => (s as unknown as { buffer: ArrayBuffer }).buffer);
    return this.schema;
  }

  async agentOf(tokenIdHex: string) {
    const t = Buffer.from(tokenIdHex, 'hex');
    const param = new Uint8Array([t.length, ...t]);
    const res = await this.grpc.invokeContract({
      contract: this.address,
      method: sdk.ReceiveName.fromString('CIS-8004.agentOf'),
      parameter: sdk.Parameter.fromBuffer(param.buffer as ArrayBuffer),
    });
    if (res.tag !== 'success' || !res.returnValue) throw new Error('CIS-8004.agentOf failed');
    const v = sdk.deserializeReceiveReturnValue(sdk.ReturnValue.toBuffer(res.returnValue).slice().buffer as ArrayBuffer, await this.loadSchema(),
      sdk.ContractName.fromString('CIS-8004'), sdk.EntrypointName.fromString('agentOf')) as { Some?: [{ owner_account: string; status: Record<string, unknown> }] };
    const a = v.Some?.[0];
    return a ? { owner: a.owner_account, active: 'Active' in a.status } : null;
  }

  async walletOf(tokenIdHex: string) {
    const t = Buffer.from(tokenIdHex, 'hex');
    const param = new Uint8Array([t.length, ...t]);
    const res = await this.grpc.invokeContract({
      contract: this.address,
      method: sdk.ReceiveName.fromString('CIS-8004.getAgentWallet'),
      parameter: sdk.Parameter.fromBuffer(param.buffer as ArrayBuffer),
    });
    if (res.tag !== 'success' || !res.returnValue) throw new Error('CIS-8004.getAgentWallet failed');
    const v = sdk.deserializeReceiveReturnValue(sdk.ReturnValue.toBuffer(res.returnValue).slice().buffer as ArrayBuffer, await this.loadSchema(),
      sdk.ContractName.fromString('CIS-8004'), sdk.EntrypointName.fromString('getAgentWallet')) as { Some?: [string] } | string | null;
    if (v && typeof v === 'object' && 'Some' in v) return v.Some?.[0] ?? null;
    return typeof v === 'string' ? v : null;
  }
}
