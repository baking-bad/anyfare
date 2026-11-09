import { AnyfareError, type Clock } from '@anyfare/common';

import type { OneClickClient, OneClickToken } from './oneClick.js';

/** No token on the blockchain matches what the client sent. */
export class UnknownTokenError extends AnyfareError {
  readonly code = 'unknown_token';
  readonly blockchain: string;
  readonly token: string;

  constructor(blockchain: string, token: string) {
    super(`No token ${JSON.stringify(token)} on ${blockchain}. Send its symbol, its contract address or its 1Click asset ID`);

    this.blockchain = blockchain;
    this.token = token;
  }
}

/** Several tokens on the blockchain match. The message lists them, so the client can send one. */
export class AmbiguousTokenError extends AnyfareError {
  readonly code = 'ambiguous_token';
  readonly blockchain: string;
  readonly token: string;
  // Each match's contract address, or its asset ID when it has none
  readonly candidates: readonly string[];

  constructor(blockchain: string, token: string, candidates: readonly string[]) {
    super(`${candidates.length} tokens on ${blockchain} match ${JSON.stringify(token)}: ${candidates.join(', ')}. Send one of these instead`);

    this.blockchain = blockchain;
    this.token = token;
    this.candidates = candidates;
  }
}

export interface TokenQuery {
  // 1Click's name for the network, such as arb
  readonly blockchain: string;
  // A symbol, a contract address or a 1Click asset ID
  readonly token: string;
}

/** A refresh failed and the catalog answered from its older list. */
export interface StaleTokenList {
  readonly error: unknown;
  // How old the list it answered from is
  readonly ageMs: number;
}

export interface TokenCatalogOptions {
  readonly client: Pick<OneClickClient, 'tokens'>;
  readonly clock: Clock;
  // How long a list is used before it is fetched again. Default: 5 minutes.
  readonly ttlMs?: number;
  // How old a list may get while refreshes fail. Default: an hour.
  readonly maxStaleMs?: number;
  // Called once for each failed refresh that answers from the older list, so the caller can log it
  readonly onStale?: (stale: StaleTokenList) => void;
}

export interface TokenCatalog {
  /**
   * The one token on the blockchain that matches: by asset ID, else by contract address (without case
   * when it starts with 0x), else by symbol (without case). Throws UnknownTokenError, AmbiguousTokenError,
   * or OneClickUnavailableError when there is no list to answer from.
   */
  resolve(query: TokenQuery): Promise<OneClickToken>;
  // The tokens on the blockchain, in 1Click's order
  list(blockchain: string): Promise<readonly OneClickToken[]>;
}

// What an error message echoes of the client's input
const maxEchoLength = 128;

const sameAddress = (query: string, address: string | undefined): boolean => address !== undefined && (/^0x/i.test(query)
  ? address.toLowerCase() === query.toLowerCase()
  : address === query);

/**
 * The tokens 1Click swaps from, fetched once and kept for `ttlMs`. Concurrent callers share one fetch.
 * When a refresh fails, the older list answers for up to `maxStaleMs` after it was fetched, and
 * `onStale` hears of it. Without a list to answer from, the failure is thrown. Logs nothing itself.
 */
export const createTokenCatalog = ({ client, clock, ttlMs = 300_000, maxStaleMs = 3_600_000, onStale }: TokenCatalogOptions): TokenCatalog => {
  let cached: { readonly tokens: readonly OneClickToken[]; readonly fetchedAt: number } | undefined;
  let refreshing: Promise<readonly OneClickToken[]> | undefined;

  const refresh = async (): Promise<readonly OneClickToken[]> => {
    try {
      const tokens = await client.tokens();
      cached = { tokens, fetchedAt: clock.now().getTime() };

      return tokens;
    }
    catch (error) {
      // The client throws OneClickUnavailableError for every failure of the token list
      if (cached === undefined)
        throw error;
      const ageMs = clock.now().getTime() - cached.fetchedAt;
      if (ageMs > maxStaleMs)
        throw error;
      onStale?.({ error, ageMs });

      return cached.tokens;
    }
  };

  const tokens = (): Promise<readonly OneClickToken[]> => {
    if (cached !== undefined && clock.now().getTime() - cached.fetchedAt < ttlMs)
      return Promise.resolve(cached.tokens);

    refreshing ??= refresh().finally(() => {
      refreshing = undefined;
    });

    return refreshing;
  };

  const list = async (blockchain: string): Promise<readonly OneClickToken[]> =>
    (await tokens()).filter(token => token.blockchain === blockchain);

  return {
    list,
    resolve: async ({ blockchain, token: query }) => {
      const onChain = await list(blockchain);
      const lowered = query.toLowerCase();
      const byAssetId = onChain.filter(token => token.assetId === query);
      const byAddress = onChain.filter(token => sameAddress(query, token.contractAddress));
      const bySymbol = onChain.filter(token => token.symbol.toLowerCase() === lowered);
      const matches = [byAssetId, byAddress, bySymbol].find(found => found.length > 0) ?? [];
      const echoed = query.slice(0, maxEchoLength);
      if (matches.length === 0)
        throw new UnknownTokenError(blockchain, echoed);
      if (matches.length > 1)
        throw new AmbiguousTokenError(blockchain, echoed, matches.map(token => token.contractAddress ?? token.assetId));

      return matches[0]!;
    },
  };
};
