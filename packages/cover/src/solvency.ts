/**
 * Proof of solvency from on-chain data: the pool balance against the cover still owed by every
 * live policy (limit minus what it already paid out). Anyone can recompute it from the contract.
 */
export type SolvencyInput = {
  pool: bigint;
  now: number;
  policies: { limit: bigint; paidOut: bigint; premium: bigint; validUntilMs: bigint; status: 'Active' | 'Cancelled' }[];
  claims: { status: string }[];
};

export function solvency({ pool, now, policies, claims }: SolvencyInput) {
  const live = policies.filter((p) => p.status === 'Active' && Number(p.validUntilMs) > now);
  const exposure = live.reduce((a, p) => a + (p.limit - p.paidOut), 0n);
  return {
    pool, exposure, livePolicies: live.length,
    premiums: policies.reduce((a, p) => a + p.premium, 0n),
    paidOut: policies.reduce((a, p) => a + p.paidOut, 0n),
    openClaims: claims.filter((c) => ['Filed', 'Assessed', 'Approved'].includes(c.status)).length,
    /** pool / exposure, 3 decimals; null when nothing is exposed. */
    coverage: exposure === 0n ? null : Number((pool * 1000n) / exposure) / 1000,
    solvent: pool >= exposure,
  };
}
