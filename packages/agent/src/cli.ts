/**
 * Usage: tsx src/cli.ts <alice|teen> <catalog|mandate|quote|buy|rogue-buy> [path]
 *   tsx src/cli.ts alice buy /shop/wine/rioja
 */
import { KuasaAgent } from './client.js';

const [name = 'alice', cmd = 'catalog', path = ''] = process.argv.slice(2);
const agent = KuasaAgent.fromDemo(name);
const out = cmd === 'buy' ? await agent.buy(path) : cmd === 'rogue-buy' ? await agent.buy(path, true) : cmd === 'quote' ? await agent.quote(path) : cmd === 'mandate' ? await agent.mandate() : await agent.catalog();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
