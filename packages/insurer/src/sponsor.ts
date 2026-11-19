import type { AccountAddress, ContractAddress } from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk/transactions';

/** JSON replacer used for signed transactions on the wire (same convention as @x402/concordium). */
export const jsonSafe = (_k: string, v: unknown) =>
  typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString()) : v;

const MAX_ENERGY = 60_000;

/**
 * The insurer operator co-signs (sponsors) claim filings so an agent never needs CCD for fees.
 * It sponsors exactly one thing: `kuasa_cover.fileClaim` on our cover contract, with no CCD
 * attached, naming the operator as sponsor. Anything else is refused.
 */
export async function checkSponsorable(json: unknown, cover: ContractAddress.Type, operator: AccountAddress.Type): Promise<{ signable: Transaction.Signable } | { refused: string }> {
  let signable: Transaction.Signable;
  try {
    signable = Transaction.signableFromJSON(json);
  } catch {
    return { refused: 'malformed transaction' };
  }
  if (signable.version !== 1) return { refused: 'malformed transaction (not a sponsorable v1 transaction)' };
  const j = JSON.parse(JSON.stringify(Transaction.toJSON(signable), jsonSafe));
  const p = j.payload;
  const target = p?.type === 'update' && p.receiveName === 'kuasa_cover.fileClaim'
    && BigInt(p.address?.index ?? -1) === cover.index && BigInt(p.address?.subindex ?? -1) === cover.subindex;
  if (!target) return { refused: 'only kuasa_cover.fileClaim on the cover contract is sponsored' };
  if (String(p.amount) !== '0') return { refused: 'amount must be zero' };
  if (j.header?.sponsor?.account !== operator.address) return { refused: 'sponsor must be the insurer operator' };
  if (Number(j.header?.executionEnergyAmount) > MAX_ENERGY) return { refused: 'energy too high' };
  return { signable };
}
