/**
 * Coinbase AgentKit wiring: add Kuasa to an AgentKit agent's action providers.
 *   const agentkit = await AgentKit.from({ walletProvider, actionProviders: [kuasaActionProvider()] });
 * The AgentKit EvmWalletProvider signs the Kuasa challenge, so the agent proves itself with its own wallet.
 * Note: in this monorepo AgentKit 0.10.4 fails to load because of a transitive @solana/kit version
 * conflict with other packages; index.ts verifies the same actions with a viem signer instead.
 */
import { customActionProvider, type EvmWalletProvider } from '@coinbase/agentkit';
import { kuasaActions } from './kuasa.js';

export const kuasaActionProvider = () => customActionProvider<EvmWalletProvider>(kuasaActions as never);
