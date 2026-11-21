import { AccountAddress, type AccountInfo, type AccountSigner, signMessage, verifyMessageSignature } from '@concordium/web-sdk';

/**
 * Payer proof: the agent signs a short message with its payer account key to show it controls the
 * payer it asks for quotes and order references "as". Mandate URLs are public, so without this
 * anyone could use up an agent's quota. Bound to the service (audience) and a 5-minute window.
 */
export const PAYER_PROOF_HEADERS = { payer: 'x-kuasa-payer', ts: 'x-kuasa-payer-ts', sig: 'x-kuasa-payer-sig' } as const;
const WINDOW_MS = 5 * 60_000;

export const payerProofMessage = (payer: string, ts: number, audience: string) => `kuasa-payer-proof:v1:${new URL(audience).origin}:${payer}:${ts}`;

export async function makePayerProof(payer: string, signer: AccountSigner, audience: string, now = Date.now()): Promise<Record<string, string>> {
  const sig = await signMessage(AccountAddress.fromBase58(payer), payerProofMessage(payer, now, audience), signer);
  return {
    [PAYER_PROOF_HEADERS.payer]: payer,
    [PAYER_PROOF_HEADERS.ts]: String(now),
    [PAYER_PROOF_HEADERS.sig]: Buffer.from(JSON.stringify(sig)).toString('base64url'),
  };
}

export async function verifyPayerProof(args: {
  header: (name: string) => string | undefined;
  payer: string;
  /** This service's origin(s): e.g. its localhost address and its public URL. */
  audience: string | string[];
  now?: number;
  accountInfo: (address: AccountAddress.Type) => Promise<AccountInfo>;
}): Promise<boolean> {
  const { header, payer, audience } = args;
  const now = args.now ?? Date.now();
  if (header(PAYER_PROOF_HEADERS.payer) !== payer) return false;
  const ts = Number(header(PAYER_PROOF_HEADERS.ts));
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > WINDOW_MS) return false;
  try {
    const sig = JSON.parse(Buffer.from(header(PAYER_PROOF_HEADERS.sig) ?? '', 'base64url').toString());
    const info = await args.accountInfo(AccountAddress.fromBase58(payer));
    for (const a of Array.isArray(audience) ? audience : [audience]) {
      if (await verifyMessageSignature(payerProofMessage(payer, ts, a), sig, info)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
