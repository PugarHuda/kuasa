/** Claim / policy ids in console routes: plain decimal numbers only. */
export const isClaimId = (s: string) => /^\d{1,20}$/.test(s);
