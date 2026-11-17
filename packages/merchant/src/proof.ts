import { AccountAddress, type ConcordiumGRPCClient, type Network } from '@concordium/web-sdk';
import { VerificationAuditRecordV1, VerifiableCredentialV1 } from '@concordium/web-sdk/wasm';
import { type Claims, deriveClaims, type Mandate, proofBinding, sha256Hex, type Statement } from '@kuasa/core';

/**
 * Re-verifies the principal's Verify & Access proof for a mandate, using only public
 * chain data. This is what makes a proof made once by a human reusable by an unattended
 * agent at any merchant:
 *
 * 1. the audit record (request + presentation) hashes to what the mandate committed to,
 * 2. the presentation is cryptographically valid, its credentials are active and the
 *    request anchor is registered on-chain (`createChecked`),
 * 3. the request context carries the mandate's binding string (payer + agent token),
 * 4. every credential is an *account* credential of the mandate's payer account, i.e. the
 *    agent pays from an account whose own identity-backed credential holds the proven
 *    attributes. Accountability therefore follows the money.
 */
export async function verifyMandateProof(args: {
  mandate: Mandate;
  auditRecordJson: string;
  grpc: ConcordiumGRPCClient;
  network: Network;
  now?: Date;
}): Promise<{ ok: true; claims: Claims } | { ok: false; reason: string }> {
  const { mandate, auditRecordJson, grpc, network } = args;

  if ((await sha256Hex(auditRecordJson)) !== mandate.proof.auditRecordSha256) {
    return { ok: false, reason: 'proof document does not match mandate' };
  }

  let record: VerificationAuditRecordV1.Type;
  try {
    record = VerificationAuditRecordV1.fromJSON(JSON.parse(auditRecordJson));
  } catch (e) {
    return { ok: false, reason: `malformed proof: ${(e as Error).message}` };
  }

  const checked = await VerificationAuditRecordV1.createChecked(record.id, record.request, record.presentation, grpc, network);
  if (checked.type === 'failed') return { ok: false, reason: `proof invalid: ${checked.error.message}` };

  const binding = proofBinding(mandate);
  const bound = record.request.context.given.some((g) => g.label === 'ContextString' && g.context === binding);
  if (!bound) return { ok: false, reason: 'proof is not bound to this agent' };

  const payerCreds = await payerCredentialIds(grpc, mandate.agent.payer);
  const statements: Statement[] = [];
  for (const cred of record.presentation.verifiableCredential) {
    if (!VerifiableCredentialV1.isAccountCredential(cred)) {
      return { ok: false, reason: 'proof must be made with the agent payer account credential' };
    }
    const credId = cred.credentialSubject.id.split(':').pop()!.toLowerCase();
    if (!payerCreds.has(credId)) return { ok: false, reason: 'proof credential does not belong to the payer account' };
    statements.push(...(cred.credentialSubject.statement as unknown as Statement[]));
  }

  return { ok: true, claims: deriveClaims(statements, args.now ?? new Date()) };
}

async function payerCredentialIds(grpc: ConcordiumGRPCClient, payer: string): Promise<Set<string>> {
  const info = await grpc.getAccountInfo(AccountAddress.fromBase58(payer));
  const ids = Object.values(info.accountCredentials).map((c) => {
    const v = c.value.contents as { credId?: string; regId?: string };
    return (v.credId ?? v.regId ?? '').toLowerCase();
  });
  return new Set(ids);
}
