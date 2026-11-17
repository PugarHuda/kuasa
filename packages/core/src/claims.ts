/**
 * Claims = what a verified presentation proved about the principal behind an agent,
 * reduced to the facts merchants actually gate on.
 *
 * We derive claims from the atomic statements of a presentation that has already been
 * cryptographically verified (see presentation.ts). Never derive claims from unverified input.
 */

export type Claims = {
  /** Principal is at least this many years old (from a dob range proof). */
  ageOver?: number;
  /** countryOfResidence ∈ this set (ISO 3166-1 alpha-2). */
  residency?: string[];
  /** nationality ∈ this set. */
  nationality?: string[];
  /** Revealed Legal Entity Identifier (business identity via Global FinReg). LEIs are public. */
  lei?: string;
  /** Revealed legal country of the business. */
  legalCountry?: string;
};

/** Structural subset of Concordium's AtomicStatement we read. */
export type Statement =
  | { type: 'AttributeInRange'; attributeTag: string; lower: unknown; upper: unknown }
  | { type: 'AttributeInSet' | 'AttributeNotInSet'; attributeTag: string; set: unknown[] }
  | { type: 'RevealAttribute'; attributeTag: string }
  | { type: 'AttributeValue'; attributeTag: string; attributeValue: unknown };

/** "YYYYMMDD" → full years elapsed until `at`. */
export function yearsSince(yyyymmdd: string, at: Date): number {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  let years = at.getUTCFullYear() - y;
  const beforeBirthday = at.getUTCMonth() + 1 < m || (at.getUTCMonth() + 1 === m && at.getUTCDate() < d);
  if (beforeBirthday) years -= 1;
  return years;
}

/**
 * dob ∈ [lower, upper) proves the holder was born before `upper`, i.e. is at least
 * yearsSince(upper) old at time `at`. Age only grows, so a proof stays valid over time.
 */
export function deriveClaims(statements: Statement[], at: Date, revealed: Record<string, string> = {}): Claims {
  const c: Claims = {};
  for (const s of statements) {
    if (s.type === 'AttributeInRange' && s.attributeTag === 'dob') {
      const upper = String(s.upper);
      if (!isCalendarDate(upper)) continue; // malformed bound proves nothing
      c.ageOver = Math.max(c.ageOver ?? 0, yearsSince(upper, at));
    } else if (s.type === 'AttributeInSet' && s.attributeTag === 'countryOfResidence') {
      c.residency = intersect(c.residency, s.set.map(String));
    } else if (s.type === 'AttributeInSet' && s.attributeTag === 'nationality') {
      c.nationality = intersect(c.nationality, s.set.map(String));
    } else if ((s.type === 'RevealAttribute' || s.type === 'AttributeValue') && s.attributeTag === 'lei') {
      const v = s.type === 'AttributeValue' ? s.attributeValue : revealed.lei;
      if (v != null) c.lei = String(v);
    } else if ((s.type === 'RevealAttribute' || s.type === 'AttributeValue') && s.attributeTag === 'legalCountry') {
      const v = s.type === 'AttributeValue' ? s.attributeValue : revealed.legalCountry;
      if (v != null) c.legalCountry = String(v);
    }
  }
  return c;
}

function isCalendarDate(yyyymmdd: string): boolean {
  if (!/^\d{8}$/.test(yyyymmdd)) return false;
  const [y, m, d] = [yyyymmdd.slice(0, 4), yyyymmdd.slice(4, 6), yyyymmdd.slice(6, 8)].map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function intersect(a: string[] | undefined, b: string[]): string[] {
  return a ? a.filter((x) => b.includes(x)) : [...b];
}

/** What a merchant requires before it will sell to an agent. */
export type Requirements = {
  minAge?: number;
  /** Buyer's residency must be provably inside this set. */
  residencyIn?: string[];
  nationalityIn?: string[];
  /** Require a business principal (revealed LEI). */
  business?: boolean;
};

/** Returns the list of unmet requirements (empty = satisfied). */
export function unmetRequirements(claims: Claims, req: Requirements): string[] {
  const out: string[] = [];
  // fail closed: anything that is not a finite proven age >= minAge is unmet
  if (req.minAge != null && !(Number.isFinite(claims.ageOver) && claims.ageOver! >= req.minAge)) out.push(`age>=${req.minAge} not proven`);
  if (req.residencyIn && !subset(claims.residency, req.residencyIn)) out.push(`residency in [${req.residencyIn.join(',')}] not proven`);
  if (req.nationalityIn && !subset(claims.nationality, req.nationalityIn)) out.push(`nationality in [${req.nationalityIn.join(',')}] not proven`);
  if (req.business && !claims.lei) out.push('business identity (LEI) not proven');
  return out;
}

/** A proven set S satisfies "value ∈ allowed" only if S ⊆ allowed (and S is non-empty). */
function subset(proven: string[] | undefined, allowed: string[]): boolean {
  return !!proven && proven.length > 0 && proven.every((x) => allowed.includes(x));
}
