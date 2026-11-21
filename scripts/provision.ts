/**
 * Provisions the demo cast on testnet:
 *   alice    - adult EU resident (DK). account #0 = owner, account #1 = her shopping agent's payer
 *   teen     - 16-year-old (DK). account #0 = owner, #1 = agent  (for the "blocked" demo)
 *   merchant - the shop. #0 = payTo, #1 = x402 facilitator / sponsor / receipt recorder
 *
 * Usage: pnpm --filter @kuasa/scripts exec tsx provision.ts [name...]
 */
import { connect } from '@kuasa/chain';
import { provision, type Attributes } from './lib/identity.js';

const cast: Record<string, [Attributes, number]> = {
  alice: [{ dob: '19900415', countryOfResidence: 'DK', nationality: 'DK' }, 2],
  teen: [{ dob: '20100301', countryOfResidence: 'DK', nationality: 'DK' }, 2],
  merchant: [{ dob: '19800101', countryOfResidence: 'NL', nationality: 'NL' }, 2],
  insurer: [{ dob: '19750101', countryOfResidence: 'NL', nationality: 'NL' }, 2], // #0 treasury (EUDemo pool), #1 operator
  insurer2: [{ dob: '19700101', countryOfResidence: 'DE', nationality: 'DE' }, 2], // a second insurer on the market ("Kuasa Re"): #0 pool, #1 operator
};

const grpc = connect();
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cast);
for (const name of names) {
  const [attrs, n] = cast[name] ?? (() => { throw new Error(`unknown profile ${name}`); })();
  const p = await provision(grpc, name, attrs, n);
  console.log(name, p.accounts.map((a) => a.address).join(' '));
}
process.exit(0);
