import { withTimeout, type Clock, type MicroUsd, type NetworkId, type Secret } from '@anyfare/common';
import { findNetwork, type ApiKeyAuth, type CdpAuth, type PlatformConfig } from '@anyfare/core';
import { x402ResourceServer } from '@x402/core/server';
import type { Network, SchemeNetworkServer } from '@x402/core/types';
import { findDefaultAsset } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactNearScheme } from '@x402/near/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';

import { createCdpRequestSigner, type CdpApiKey } from './cdp.js';
import { createFacilitator, type Facilitator } from './facilitator.js';

/** An asset the x402 rail offers, with the scheme's `extra`: the EIP-712 domain on EVM. */
export interface X402Asset {
  readonly name: string;
  readonly network: NetworkId;
  readonly address: string;
  readonly decimals: number;
  readonly minPrice: MicroUsd;
  readonly payTo: string;
  readonly extra: Readonly<Record<string, unknown>>;
}

/** The x402 rail's view of the platform: the resource server, the enabled facilitators, and the assets offered. */
export interface X402Setup {
  readonly server: x402ResourceServer;
  readonly facilitators: readonly Facilitator[];
  readonly assets: readonly X402Asset[];
  /** The enabled facilitator that serves a network, such as for the settlement follow-up. */
  facilitatorFor(network: string): Facilitator | undefined;
  /** The registry name of an asset on a network, such as `base-usdc`, from every asset in platform config. */
  assetName(network: string, address: string): string | undefined;
}

export interface FacilitatorsOptions {
  readonly config: PlatformConfig;
  // The CDP API key a facilitator's auth names: the caller reads its two secrets with readSecret
  readonly cdpApiKey: (auth: CdpAuth) => CdpApiKey;
  // The static key an `api-key` auth names: the caller reads its secret with readSecret. Needed when
  // an enabled facilitator uses that auth.
  readonly facilitatorApiKey?: (auth: ApiKeyAuth) => Secret;
  readonly clock: Clock;
  // `/supported` and `/verify`. Default: platform config's connect timeout.
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const apiKeyOf = (name: string, auth: ApiKeyAuth, read: FacilitatorsOptions['facilitatorApiKey']): Secret => {
  if (!read)
    throw new Error(`The ${name} facilitator uses an API key (${auth.apiKey}), but no reader for it is set`);

  return read(auth);
};

/** The enabled facilitators of platform config, as HTTP clients. CDP signs each request, an api-key auth sends its key. */
export const createFacilitators = ({ config, cdpApiKey, facilitatorApiKey, clock, requestTimeoutMs = config.timeouts.connectMs, fetch }: FacilitatorsOptions): Facilitator[] =>
  config.facilitators.filter(facilitator => facilitator.enabled).map(facilitator => createFacilitator({
    name: facilitator.name,
    url: facilitator.url,
    networks: facilitator.networks,
    signer: facilitator.auth?.type === 'cdp' ? createCdpRequestSigner({ apiKey: cdpApiKey(facilitator.auth), clock }) : undefined,
    ...facilitator.auth?.type === 'api-key' ? { apiKey: apiKeyOf(facilitator.name, facilitator.auth, facilitatorApiKey) } : {},
    requestTimeoutMs,
    settleTimeoutMs: config.timeouts.settleMs,
    ...(fetch ? { fetch } : {}),
  }));

export interface X402SetupOptions {
  readonly config: PlatformConfig;
  // From `createFacilitators`, or fakes in tests. Matched to platform config by name.
  readonly facilitators: readonly Facilitator[];
  // How long the startup check may take
  readonly timeoutMs: number;
}

const sameAddress = (namespace: string, left: string, right: string): boolean =>
  namespace === 'eip155' ? left.toLowerCase() === right.toLowerCase() : left === right;

/** The enabled facilitator that serves each network, from platform config and the clients by name. */
export const createFacilitatorLookup = (config: PlatformConfig, facilitators: readonly Facilitator[]): ((network: string) => Facilitator | undefined) => {
  const byName = new Map(facilitators.map(facilitator => [facilitator.name, facilitator]));
  const byNetwork = new Map<string, Facilitator>();
  for (const { name, networks } of config.facilitators.filter(facilitator => facilitator.enabled)) {
    const client = byName.get(name);
    if (!client)
      throw new Error(`No client for the ${name} facilitator`);
    for (const network of networks)
      byNetwork.set(network, client);
  }

  return network => byNetwork.get(network);
};

/** The registry name of an asset on a network, such as `base-usdc`, from every asset in platform config. */
export const createAssetLookup = (config: PlatformConfig) => (network: string, address: string): string | undefined =>
  config.assets.find(asset => asset.network.id === network && sameAddress(asset.network.namespace, asset.address, address))?.name;

export interface CheckFacilitatorsOptions {
  readonly config: PlatformConfig;
  readonly facilitators: readonly Facilitator[];
  readonly timeoutMs: number;
}

/** Whether a Solana kind of `/supported` names the fee payer and the transaction versions buyers build. */
const solanaProblem = (extra: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const feePayer = extra?.['feePayer'];
  if (typeof feePayer !== 'string' || feePayer === '')
    return 'no fee payer';
  const versions = extra?.['transactionVersions'];
  if (!Array.isArray(versions) || versions.length === 0 || versions.some(version => version !== 0 && version !== 1))
    return 'no transaction versions of 0 or 1';

  return undefined;
};

/**
 * Every enabled facilitator answers `/supported` within the timeout, and lists `exact` (x402 v2) on
 * each network platform config gives it, with the fee payer and the transaction versions on Solana.
 * Otherwise this throws, so an app that pays or settles through them fails fast.
 */
export const checkFacilitators = async ({ config, facilitators, timeoutMs }: CheckFacilitatorsOptions): Promise<void> => {
  const networksOf = new Map(config.facilitators.map(facilitator => [facilitator.name, facilitator.networks]));
  await withTimeout(async () => {
    await Promise.all(facilitators.map(async facilitator => {
      let supported;
      try {
        supported = await facilitator.getSupported();
      }
      catch (error) {
        throw new Error(`The ${facilitator.name} facilitator's /supported failed`, { cause: error });
      }
      const missing = (networksOf.get(facilitator.name) ?? []).filter(network =>
        !supported.kinds.some(kind => kind.x402Version === 2 && kind.scheme === 'exact' && kind.network === network));
      if (missing.length > 0)
        throw new Error(`The ${facilitator.name} facilitator's /supported doesn't list exact on ${missing.join(', ')}`);
      for (const network of (networksOf.get(facilitator.name) ?? []).filter(id => findNetwork(id)?.namespace === 'solana')) {
        const kind = supported.kinds.find(item => item.x402Version === 2 && item.scheme === 'exact' && item.network === network);
        const problem = solanaProblem(kind?.extra);
        if (problem)
          throw new Error(`The ${facilitator.name} facilitator's /supported has ${problem} on ${network}`);
      }
    }));
  }, { timeoutMs });
};

// The SDK's `exact` scheme for a network's namespace
const schemes: Readonly<Record<string, () => SchemeNetworkServer>> = {
  eip155: () => new ExactEvmScheme(),
  solana: () => new ExactSvmScheme(),
  near: () => new ExactNearScheme(),
};

/** The scheme's `extra` an asset's quotes carry: the EIP-712 domain on EVM, and the transfer method when the SDK names one. */
const extraFor = (asset: PlatformConfig['assets'][number]): Record<string, unknown> => {
  const { id, namespace } = asset.network;
  if (namespace !== 'eip155')
    return {};

  const known = findDefaultAsset(asset.address, id);
  if (!known)
    throw new Error(`The asset ${asset.name} has no EIP-712 domain in the x402 SDK's defaults, so buyers can't sign for it`);

  return { name: known.name, version: known.version, ...known.assetTransferMethod ? { assetTransferMethod: known.assetTransferMethod } : {} };
};

/**
 * Prepares the x402 rail. Every enabled facilitator must answer `/supported` within the timeout, or
 * this throws: the proxy fails fast. Then the resource server loads what each supports, such as the
 * Solana fee payer and transaction versions. Offered: the assets on Base, Solana and NEAR networks whose
 * facilitator is enabled, with a `payTo`. An EVM asset needs its EIP-712 domain from the SDK's
 * defaults.
 */
export const initializeX402 = async ({ config, facilitators, timeoutMs }: X402SetupOptions): Promise<X402Setup> => {
  const facilitatorFor = createFacilitatorLookup(config, facilitators);
  await checkFacilitators({ config, facilitators, timeoutMs });

  const server = new x402ResourceServer([...facilitators]);
  const assets: X402Asset[] = [];
  const namespaces = new Map<string, string>();
  for (const asset of config.assets) {
    const { id, namespace } = asset.network;
    // Tempo assets are paid through MPP. An asset without payTo isn't offered: we only pay APIs in it.
    const { payTo } = asset;
    if (!facilitatorFor(id) || !(namespace in schemes) || asset.network.chain === 'tempo' || payTo === undefined)
      continue;

    assets.push({ name: asset.name, network: id, address: asset.address, decimals: asset.decimals, minPrice: asset.minPrice, payTo, extra: extraFor(asset) });
    namespaces.set(id, namespace);
  }
  for (const [network, namespace] of namespaces)
    server.register(network as Network, schemes[namespace]!());
  await withTimeout(() => server.initialize(), { timeoutMs });

  return {
    server,
    facilitators,
    assets,
    facilitatorFor,
    assetName: createAssetLookup(config),
  };
};
