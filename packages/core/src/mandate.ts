import { z } from 'zod';

/**
 * A Kuasa mandate ("surat kuasa"): a principal (person or business) delegates scoped,
 * revocable purchasing authority to one agent.
 *
 * The full mandate document lives off-chain (served at `uri`). The on-chain registry stores
 * its SHA-256, the payer account, limits, cumulative spend and revocation state, so any
 * merchant can check the document is authentic and still in force.
 */

const ccdAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{45,55}$/, 'invalid Concordium address');
const atomic = z.string().regex(/^\d+$/, 'amount must be an integer string in atomic units');

export const MandateSchema = z.object({
  v: z.literal(1),
  network: z.string(), // CAIP-2, e.g. ccd:4221332d34e1694168c2a0c0b3fd0f27
  principal: z.object({
    kind: z.enum(['person', 'business']),
    account: ccdAddress, // the owner's Concordium account (identity-backed)
    displayName: z.string().max(80).optional(),
  }),
  agent: z.object({
    /** CIS-8004 Agent Registry token, e.g. "<12802,0>/5" */
    registry: z.object({ index: z.string(), subindex: z.string(), tokenId: z.string() }),
    /** The account the agent pays from. Must be created from the principal's identity. */
    payer: ccdAddress,
    /** Optional link to the same agent on another chain (registered via CIS-8). */
    external: z.object({ namespace: z.string(), address: z.string() }).optional(),
  }),
  scope: z.object({
    asset: z.string(), // "CCD" or a PLT token id, e.g. "EUDemo"
    maxPerOrder: atomic,
    maxTotal: atomic,
    categories: z.array(z.string()).min(1),
    /** Merchant payTo allowlist; empty/absent = any merchant. */
    merchants: z.array(ccdAddress).optional(),
    validFrom: z.number().int(),
    validUntil: z.number().int(),
  }),
  /**
   * Verify & Access audit record (request + presentation) the principal produced once.
   * Its request context binds it to this agent's payer account, so it cannot be reused
   * by another agent; anyone can re-verify it against public chain data.
   */
  proof: z.object({
    auditRecordUri: z.string().url(),
    auditRecordSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  createdAt: z.number().int(),
});

export type Mandate = z.infer<typeof MandateSchema>;

/** Deterministic JSON: sorted keys, no whitespace. Hash input for mandates and receipts. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Mandate id = sha256(canonical mandate). The registry is keyed by this. */
export const mandateId = (m: Mandate) => sha256Hex(canonicalJson(m));

/**
 * The string the principal's presentation must carry in its request context.
 * Binding the proof to (network, payer, registry token) stops a stolen proof being
 * attached to someone else's agent.
 */
export function proofBinding(m: Pick<Mandate, 'network' | 'agent'>): string {
  const r = m.agent.registry;
  return `kuasa:v1:${m.network}:${m.agent.payer}:${r.index}.${r.subindex}/${r.tokenId}`;
}
