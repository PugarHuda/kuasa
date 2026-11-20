/**
 * AP2 interop: map a Google Agent Payments Protocol (AP2) IntentMandate onto the parts of a Kuasa
 * mandate scope that Kuasa enforces on-chain (merchant accounts, expiry). Anything Kuasa cannot
 * enforce is refused rather than widened: an intent open to any merchant is not insurable as-is.
 * Field names follow the AP2 IntentMandate (snake_case); budget and categories come from the owner.
 */
export type Ap2IntentMandate = {
  user_cart_confirmation_required: boolean;
  natural_language_description: string;
  merchants?: string[] | null;
  skus?: string[] | null;
  requires_refundability?: boolean;
  intent_expiry: string;
};

export type Ap2Scope = { merchants: string[]; validUntil: number; description: string; humanConfirmsEachCart: boolean; requiresRefundability: boolean; skus?: string[] };

export function scopeFromAp2Intent(intent: Ap2IntentMandate, merchantAccount: (name: string) => string | undefined): Ap2Scope | { refused: string } {
  if (!intent.merchants?.length) return { refused: 'AP2 intent allows any merchant; Kuasa needs a merchant allowlist to insure it' };
  const merchants: string[] = [];
  for (const m of intent.merchants) {
    const a = merchantAccount(m);
    if (!a) return { refused: `no Concordium account known for merchant: ${m}` };
    merchants.push(a);
  }
  const ms = Date.parse(intent.intent_expiry);
  if (!Number.isFinite(ms)) return { refused: 'AP2 intent_expiry is not a valid date' };
  return {
    merchants, validUntil: Math.floor(ms / 1000), description: intent.natural_language_description,
    humanConfirmsEachCart: intent.user_cart_confirmation_required, requiresRefundability: !!intent.requires_refundability,
    ...(intent.skus?.length ? { skus: intent.skus } : {}),
  };
}
