import type { RailName } from './ledger/payments.js';
import type { Chain } from './networks.js';
import type { PlatformConfig } from './platform/config.js';

// How a buyer paid, or how we paid the API. A network that is none of these is given as its network ID.
export const paidWithValues = ['near', 'base', 'solana', 'tempo', 'credits'] as const;
export type PaidWith = typeof paidWithValues[number];

/** A rail on one network the platform config names, and how a payment on it was paid. */
export interface PaidWithWay {
  readonly rail: 'x402' | 'mpp';
  readonly network: string;
  readonly paidWith: string;
}

export interface PaidWithRules {
  // Every network the platform config names, with its chain
  readonly chains: ReadonlyMap<string, Chain>;
  // Each rail on each of those networks, and its name. A pair not listed is paid with its network's ID,
  // or its rail's name without one; Credits are always `credits`.
  readonly ways: readonly PaidWithWay[];
  /** How a payment on `rail` and `network` was paid. */
  paidWithOf(rail: RailName, network: string | undefined): string;
}

// x402 is paid on these chains, MPP on Tempo
const x402Chains: ReadonlySet<Chain> = new Set(['near', 'base', 'solana']);

/** How payments were paid, from the rail and the platform config's networks. */
export const createPaidWith = (config: Pick<PlatformConfig, 'assets' | 'mpp'>): PaidWithRules => {
  const chains = new Map<string, Chain>([
    ...config.assets.map(asset => [asset.network.id, asset.network.chain] as const),
    [config.mpp.network.id, config.mpp.network.chain],
  ]);

  const paidWithOf = (rail: RailName, network: string | undefined): string => {
    if (rail === 'credits')
      return 'credits';
    if (network === undefined)
      return rail;
    const chain = chains.get(network);
    if (rail === 'mpp' && chain === 'tempo')
      return 'tempo';
    if (rail === 'x402' && chain !== undefined && x402Chains.has(chain))
      return chain;

    return network;
  };

  const ways = [...chains.keys()].flatMap(network => (['x402', 'mpp'] as const).map(rail => ({ rail, network, paidWith: paidWithOf(rail, network) })));

  return { chains, ways, paidWithOf };
};
