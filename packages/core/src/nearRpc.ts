import { InvalidEnvironmentError, Secret, type SecretEnvironment } from '@anyfare/common';

import type { NetworkInfo } from './networks.js';
import type { PlatformConfig } from './platform/config.js';

// The x402 SDK's public NEAR RPCs (`NEAR_RPC_URLS` of @x402/near), by network. They're rate limited:
// production names its own in NEAR_RPC_URLS.
export const publicNearRpcUrls: Readonly<Record<string, string>> = {
  'near:mainnet': 'https://rpc.mainnet.fastnear.com',
  'near:testnet': 'https://rpc.testnet.fastnear.com',
};

export interface NearRpc {
  // The URL may carry a key in its path or query string
  readonly url: Secret;
  // For logs: never the path or query
  readonly host: string;
  // NEAR_RPC_URLS names none for the network: the x402 SDK's public RPC
  readonly public: boolean;
}

/** The NEAR network of the platform config: its first NEAR asset's. Undefined when it has none. */
export const nearNetworkOf = (config: Pick<PlatformConfig, 'assets'>): NetworkInfo | undefined =>
  config.assets.find(asset => asset.network.namespace === 'near')?.network;

const httpUrlOf = (value: string): URL | undefined => {
  try {
    const url = new URL(value);

    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  }
  catch {
    return undefined;
  }
};

/**
 * The NEAR RPC for the config's NEAR network: the first item of NEAR_RPC_URLS for it, else the x402
 * SDK's public RPC. NEAR_RPC_URLS holds `near:mainnet=https://…` items separated by commas, as the
 * facilitator and the workers read them, and may name only the config's NEAR network. A URL may carry a
 * key in its path or query string, never as a username or password, so an invalid item throws without
 * echoing it. Undefined when the config has no NEAR asset.
 */
export const readNearRpc = (env: SecretEnvironment, config: Pick<PlatformConfig, 'assets'>): NearRpc | undefined => {
  const network = nearNetworkOf(config)?.id;
  if (network === undefined)
    return undefined;
  let chosen: { readonly url: string; readonly host: string } | undefined;
  for (const item of (env['NEAR_RPC_URLS'] ?? '').split(',').map(entry => entry.trim()).filter(Boolean)) {
    const separator = item.indexOf('=');
    const name = separator < 0 ? '' : item.slice(0, separator).trim();
    const url = separator < 0 ? '' : item.slice(separator + 1).trim();
    const parsed = httpUrlOf(url);
    if (!Object.hasOwn(publicNearRpcUrls, name) || !parsed)
      throw new InvalidEnvironmentError('NEAR_RPC_URLS must be near:<network>=<HTTP(S) URL> items, separated by commas');
    if (parsed.username !== '' || parsed.password !== '')
      throw new InvalidEnvironmentError('NEAR_RPC_URLS can\'t carry a username or password: put a key in the path or the query string');
    if (name !== network)
      throw new InvalidEnvironmentError(`NEAR_RPC_URLS names ${name}, but the platform config's NEAR network is ${network}`);
    chosen ??= { url, host: parsed.host };
  }
  if (chosen)
    return { url: Secret.from(chosen.url), host: chosen.host, public: false };
  const fallback = publicNearRpcUrls[network]!;

  return { url: Secret.from(fallback), host: new URL(fallback).host, public: true };
};
