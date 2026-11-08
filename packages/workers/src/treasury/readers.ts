import { createPublicClient, erc20Abi, getAddress, http, type PublicClient } from 'viem';

import { AnyfareError, isRecord, type Logger, type Secret } from '@anyfare/common';
import type { Asset, BalanceReader } from '@anyfare/core';

/** EVM balances (Base, Tempo) through each network's JSON-RPC: the token's `balanceOf`. */
export const createEvmBalanceReader = ({ rpcUrlFor, timeoutMs }: {
  // The RPC of an `eip155:<chain ID>` network, without credentials
  readonly rpcUrlFor: (networkId: string) => string | undefined;
  readonly timeoutMs: number;
}): BalanceReader => {
  const clients = new Map<string, PublicClient>();
  const clientFor = (asset: Asset): PublicClient => {
    const url = rpcUrlFor(asset.network.id);
    if (!url)
      throw new Error(`No RPC for ${asset.network.id}`);
    const client = clients.get(url) ?? createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 0 }) });
    clients.set(url, client);

    return client;
  };

  return {
    // Async, so a network without an RPC rejects like any other failed read
    balance: async ({ address, asset }) => clientFor(asset).readContract({
      address: getAddress(asset.address),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [getAddress(address)],
    }),
  };
};

/** The Solana RPC didn't answer, or answered something unexpected. The message names the call, never the RPC's URL. */
export class SolanaRpcError extends AnyfareError {
  readonly code = 'solana_rpc_unavailable';
}

// Where `jsonParsed` puts a token account's atomic amount, as a string
const amountPath = ['account', 'data', 'parsed', 'info', 'tokenAmount', 'amount'] as const;

const atomicAmountOf = (account: unknown): bigint => {
  const amount = amountPath.reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, account);
  if (typeof amount !== 'string' || !/^\d{1,30}$/.test(amount))
    throw new SolanaRpcError('The Solana RPC answered a token account without an amount');

  return BigInt(amount);
};

/**
 * Solana balances through its JSON-RPC: the sum of the owner's token accounts for the asset's mint,
 * from `getTokenAccountsByOwner`. An owner without one holds `0n`. The URL may carry a key in its
 * path, so it stays in `Secret` and out of every error.
 */
export const createSolanaBalanceReader = ({ rpcUrl, timeoutMs, fetch = globalThis.fetch }: {
  // SOLANA_RPC_URL, or the network's public RPC
  readonly rpcUrl: Secret;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}): Required<BalanceReader> => {
  const tokenAccounts = async ({ address, asset }: { readonly address: string; readonly asset: Asset }): Promise<readonly bigint[]> => {
    const what = 'getTokenAccountsByOwner';
    let response: Response;
    try {
      response = await fetch(rpcUrl.expose(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: what, params: [address, { mint: asset.address }, { encoding: 'jsonParsed', commitment: 'confirmed' }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    catch (error) {
      throw new SolanaRpcError(`The Solana RPC didn't answer ${what}`, { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SolanaRpcError(`The Solana RPC answered ${what} with status ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    }
    catch {
      throw new SolanaRpcError(`The Solana RPC answered ${what} with invalid JSON`);
    }
    if (isRecord(body) && isRecord(body['error']))
      throw new SolanaRpcError(`The Solana RPC refused ${what}: ${typeof body['error']['code'] === 'number' ? body['error']['code'] : 'no code'}`);
    const accounts = isRecord(body) && isRecord(body['result']) ? body['result']['value'] : undefined;
    if (!Array.isArray(accounts))
      throw new SolanaRpcError(`The Solana RPC answered ${what} without a list of accounts`);

    return accounts.map(atomicAmountOf);
  };

  return {
    balance: async input => (await tokenAccounts(input)).reduce((sum, amount) => sum + amount, 0n),
    hasTokenAccount: async input => (await tokenAccounts(input)).length > 0,
  };
};

/** The NEAR RPC didn't answer, or answered something unexpected. The message names the call, never the RPC's URL. */
export class NearRpcError extends AnyfareError {
  readonly code = 'near_rpc_unavailable';
}

/** NEAR balances, and the chain's final height, through one network's RPCs. */
export interface NearBalanceReader extends BalanceReader {
  /** The final block's height, for the settlement follow-up. */
  height(): Promise<bigint>;
}

const nearAmountPattern = /^\d{1,40}$/;

// An RPC's host, for a line: its path and query string may carry a key
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  }
  catch {
    return 'an RPC';
  }
};

/**
 * NEAR balances through the network's JSON-RPC: the token contract's NEP-141 `ft_balance_of` for the
 * account, a `query` of `call_function` at the final block. An account the token holds nothing for
 * reads 0. Its `storage_balance_of` is the account's storage deposit, not a balance: not read. Each
 * call goes to the RPCs in order, and to the next when one fails, with a warning naming the host. A
 * URL may carry a key in its path or query string, so no error or line holds it.
 */
export const createNearBalanceReader = ({ rpcUrls, logger, timeoutMs, fetch = globalThis.fetch }: {
  // NEAR_RPC_URLS for the network, then the x402 SDK's public RPC
  readonly rpcUrls: readonly string[];
  readonly logger: Logger;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}): NearBalanceReader => {
  if (rpcUrls.length === 0)
    throw new Error('The NEAR balance reader needs an RPC');

  // One JSON-RPC call to one RPC: its result, or a NearRpcError that names the call
  const callOnce = async (url: string, what: string, method: string, params: unknown): Promise<unknown> => {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'treasury', method, params }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    }
    catch (error) {
      throw new NearRpcError(`The NEAR RPC didn't answer ${what}`, { cause: error });
    }
    if (!response.ok)
      throw new NearRpcError(`The NEAR RPC answered ${what} with status ${response.status}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    }
    catch {
      throw new NearRpcError(`The NEAR RPC answered ${what} with invalid JSON`);
    }
    if (isRecord(body) && isRecord(body['error'])) {
      const cause = isRecord(body['error']['cause']) && typeof body['error']['cause']['name'] === 'string' ? body['error']['cause']['name'].slice(0, 64) : 'no cause';
      throw new NearRpcError(`The NEAR RPC refused ${what}: ${cause}`);
    }
    if (!isRecord(body) || !('result' in body))
      throw new NearRpcError(`The NEAR RPC answered ${what} without a result`);

    return body['result'];
  };

  // Through each RPC in turn, until one answers what `read` takes
  const call = async <TResult>(what: string, method: string, params: unknown, read: (result: unknown) => TResult): Promise<TResult> => {
    let failure: unknown;
    for (const [index, url] of rpcUrls.entries()) {
      try {
        return read(await callOnce(url, what, method, params));
      }
      catch (error) {
        failure = error;
        const next = rpcUrls[index + 1];
        if (next !== undefined)
          logger.warn({ error, host: hostOf(url), next: hostOf(next) }, 'A NEAR RPC failed: trying the next');
      }
    }
    throw failure;
  };

  return {
    balance: ({ address, asset }) => call('ft_balance_of', 'query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: asset.address,
      method_name: 'ft_balance_of',
      args_base64: Buffer.from(JSON.stringify({ account_id: address })).toString('base64'),
    }, result => {
      // A contract's failure is a result with nearcore's error text
      if (isRecord(result) && typeof result['error'] === 'string')
        throw new NearRpcError('The NEAR RPC answered ft_balance_of with the contract\'s error');
      const bytes = isRecord(result) ? result['result'] : undefined;
      let amount: unknown;
      try {
        amount = Array.isArray(bytes) ? JSON.parse(Buffer.from(bytes as number[]).toString('utf8')) : undefined;
      }
      catch {
        amount = undefined;
      }
      if (typeof amount !== 'string' || !nearAmountPattern.test(amount))
        throw new NearRpcError('The NEAR RPC answered ft_balance_of without an amount');

      return BigInt(amount);
    }),
    height: () => call('block', 'block', { finality: 'final' }, result => {
      const height = isRecord(result) && isRecord(result['header']) ? result['header']['height'] : undefined;
      if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0)
        throw new NearRpcError('The NEAR RPC answered block without a height');

      return BigInt(height);
    }),
  };
};

/** Picks the reader for an asset's chain. Undefined: no reader was given for that chain. */
export const readerFor = (readers: { readonly evm?: BalanceReader; readonly solana?: BalanceReader; readonly near?: BalanceReader }) => (asset: Asset): BalanceReader | undefined => {
  switch (asset.network.namespace) {
    case 'eip155':
      return readers.evm;
    case 'solana':
      return readers.solana;
    case 'near':
      return readers.near;
    default:
      return undefined;
  }
};
