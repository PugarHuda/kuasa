/**
 * For any merchant, on any stack: is the account paying you insured by Kuasa Cover? One standard CIS-2
 * call on the certificate contract, no Kuasa API and no trust in Kuasa's servers. The agent tells you its
 * policy id (or you read it from the insurer's public A2A `certificate` skill); balance 1 = insured now.
 *   tsx examples/merchant-certificate-check.ts <payer account> <policy id>
 */
import { AccountAddress, ConcordiumGRPCNodeClient, ContractAddress, Parameter, ReceiveName, ReturnValue } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';

const [payer, policy] = process.argv.slice(2);
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
// BalanceOfQueryParams: 1 query = (TokenIdU64: length 8 + 8 bytes LE, Address::Account: tag 0 + 32 bytes)
const query = Uint8Array.from([1, 0, 8, ...new Uint8Array(new BigUint64Array([BigInt(policy)]).buffer), 0, ...AccountAddress.fromBase58(payer).decodedAddress]);
const r = await node.invokeContract({ contract: ContractAddress.create(13120n, 0n), method: ReceiveName.fromString('kuasa_certificate.balanceOf'), parameter: Parameter.fromBuffer(query.buffer as ArrayBuffer) });
if (r.tag !== 'success' || !r.returnValue) throw new Error('certificate contract unreadable');
const insured = new Uint8Array(ReturnValue.toBuffer(r.returnValue))[2] === 1;
console.log(insured ? `insured: ${payer} holds Kuasa Cover certificate ${policy}` : `not insured under policy ${policy}`);
process.exit(insured ? 0 : 1);
