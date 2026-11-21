/**
 * Portable reputation for EVM ecosystems: Kuasa Cover's claim outcomes for an agent, shaped as
 * ERC-8004 Reputation Registry feedback (score 0-100, two tags, a pointer to the evidence). Every
 * entry is recomputed from the Concordium cover contracts, so any reader can check it there.
 * Not posted to an Ethereum ERC-8004 registry from here: that needs the agent's ERC-8004 id and gas.
 */
import type { Claim, Policy } from '@kuasa/core';

export type Book = { cover: bigint; policies: Policy[]; claims: Claim[] };
export type Feedback = {
  score: number; tag1: 'kuasa-cover'; tag2: string; createdAt: string;
  evidence: { network: 'ccd:testnet'; contract: string; claimId?: string; policyId: string; status: string };
};

/** What each outcome says about the agent itself (a wrong item is the merchant's fault, not the agent's). */
const SCORE: Record<string, (c: Claim) => number | null> = {
  AgentMistake: (c) => (c.status.tag === 'Paid' ? 60 : null),
  WrongItem: () => null,
  MerchantLoss: (c) => (c.status.tag === 'Paid' ? 30 : null),
};

export function feedbackFor(payer: string, books: Book[], now = Date.now()): Feedback[] {
  const out: Feedback[] = [];
  for (const b of books) {
    const contract = `<${b.cover},0>`;
    b.policies.forEach((p, policyId) => {
      if (p.agentPayer !== payer) return;
      const claims = b.claims.map((c, id) => ({ c, id })).filter((x) => Number(x.c.policyId) === policyId);
      for (const { c, id } of claims) {
        const score = c.status.tag === 'Fraud' ? 0 : SCORE[c.kind]?.(c);
        if (score === null || score === undefined) continue;
        out.push({ score, tag1: 'kuasa-cover', tag2: c.status.tag === 'Fraud' ? 'fraud' : c.kind, createdAt: new Date(Number(p.validFromMs)).toISOString(), evidence: { network: 'ccd:testnet', contract, claimId: String(id), policyId: String(policyId), status: c.status.tag } });
      }
      // a policy that ran its course without any claim is the best signal an insurer can give
      if (claims.length === 0 && Number(p.validUntilMs) < now && p.status === 'Active') {
        out.push({ score: 100, tag1: 'kuasa-cover', tag2: 'claim-free', createdAt: new Date(Number(p.validUntilMs)).toISOString(), evidence: { network: 'ccd:testnet', contract, policyId: String(policyId), status: 'Expired' } });
      }
    });
  }
  return out;
}
