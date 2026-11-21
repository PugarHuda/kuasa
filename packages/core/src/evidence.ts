import type { ClaimKind } from './cover.js';
import { canonicalJson, sha256Hex } from './mandate.js';

/**
 * Claim reason codes, modelled on card-network chargeback reason codes: the on-chain claim kind
 * says who bears the loss, the reason code says what went wrong and which evidence proves it.
 */
export const REASON_CODES = {
  'AM10': { kind: 'AgentMistake', label: 'duplicate order', evidence: 'two on-chain receipts: same amount, different payments, within 10 minutes' },
  'AM20': { kind: 'AgentMistake', label: 'outside the user intent (e.g. prompt injection)', evidence: 'merchant-signed delivery note for an item the policy’s AP2 intent does not list' },
  'WI10': { kind: 'WrongItem', label: 'wrong item shipped', evidence: 'merchant-signed delivery note: shipped item differs from the ordered item' },
  'ML10': { kind: 'MerchantLoss', label: 'merchant harmed by the insured agent', evidence: 'one receipt and an incident on the mandate' },
} as const satisfies Record<string, { kind: ClaimKind; label: string; evidence: string }>;
export type ReasonCode = keyof typeof REASON_CODES;

export const defaultReason = (kind: ClaimKind): ReasonCode => (kind === 'AgentMistake' ? 'AM10' : kind === 'WrongItem' ? 'WI10' : 'ML10');

/**
 * What a merchant packed and shipped for one paid order. It is signed by the account that recorded
 * the order's receipt on-chain (a recorder the mandate authorised), so the note is tied to the chain.
 */
export type DeliveryNote = { v: 1; order: string; paymentTx: string; ordered: string; shipped: string; at: number };
export type SignedDeliveryNote = { note: DeliveryNote; signer: string; sig: unknown };
export const deliveryMessage = (n: DeliveryNote) => `kuasa-delivery:v1:${canonicalJson(n)}`;

/** The claim's off-chain evidence; its sha256 is the claim's on-chain `evidence` field. */
export type ClaimEvidence = { v: 2; reason: ReasonCode; paymentTxs: string[]; note: string; delivery?: SignedDeliveryNote[] };
export const evidenceHash = (e: ClaimEvidence) => sha256Hex(canonicalJson(e));
