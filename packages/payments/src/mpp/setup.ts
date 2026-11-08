import type { Challenge, Receipt } from 'mppx';
import { Mppx, tempo } from 'mppx/server';
import type { Address, Client } from 'viem';

import type { MicroUsd, Secret } from '@anyfare/common';
import type { PlatformConfig } from '@anyfare/core';

import type { ReplayStore } from '../ports.js';
import { createTempoRpc, type TempoRpc } from './rpc.js';

/** A Tempo asset MPP offers: a TIP-20 USD stablecoin on `mpp.network`, paid to the recipient. */
export interface MppAsset {
  // The asset's registry name, such as `tempo-pathusd`
  readonly name: string;
  readonly address: Address;
  readonly decimals: number;
  readonly minPrice: MicroUsd;
}

/** The options a credential is checked against: the charge request and the URL it is bound to. */
export interface MppCredentialOptions {
  readonly request: Readonly<Record<string, unknown>>;
  readonly scope: string;
}

/** The part of an `mppx` server the rail uses (`Mppx.create`). */
export interface MppxServer {
  readonly challenge: {
    readonly tempo: {
      readonly charge: (options: Readonly<Record<string, unknown>> & { readonly description?: string; readonly scope?: string }) => Promise<Challenge.Challenge>;
    };
  };
  /** Checks a credential against the request without moving anything. Throws a PaymentError when refused. */
  validateCredential(credential: string, options: MppCredentialOptions): Promise<unknown>;
  /** Validates again, claims the transaction in the replay store, broadcasts it, and waits for its receipt. */
  broadcastCredential(credential: string, options: MppCredentialOptions): Promise<Receipt.Receipt>;
}

/** The `mppx` servers of one asset: one checks credentials, the other broadcasts. */
export interface MppServers {
  // Its RPC calls within the connect timeout
  readonly validator: MppxServer;
  // Its RPC calls within the settle timeout
  readonly broadcaster: MppxServer;
}

// One `mppx` server for one asset: the Tempo charge in pull mode, with its challenges bound to our
// realm. One method per server: two methods on one server would both match a credential's request,
// and `mppx` would refuse every credential.
const createServer = ({ asset, chainId, recipient, store, client, secretKey, realm }: {
  readonly asset: MppAsset;
  readonly chainId: number;
  readonly recipient: Address;
  readonly store: ReplayStore;
  readonly client: Client;
  readonly secretKey: string;
  readonly realm: string;
}): MppxServer => {
  const server = Mppx.create({
    methods: [tempo.charge({
      currencies: [asset.address],
      decimals: asset.decimals,
      recipient,
      chainId,
      store,
      getClient: () => client,
      // The buyer signs, and we broadcast after a billable answer
      supportedModes: ['pull'],
      // No fee sponsorship: the buyer pays its own transaction's fees
      sponsorBudget: false,
      waitForConfirmation: true,
    })],
    secretKey,
    realm,
  });

  return {
    challenge: server.challenge as unknown as MppxServer['challenge'],
    validateCredential: (credential, options) => server.validateCredential(credential, options),
    broadcastCredential: (credential, options) => server.broadcastCredential(credential, options),
  };
};

/** The MPP rail's view of the platform. */
export interface MppSetup {
  // mpp.network, CAIP-2, such as eip155:42431
  readonly network: string;
  readonly chainId: number;
  readonly recipient: Address;
  readonly assets: readonly MppAsset[];
  // Each asset's servers, by the asset's address in lowercase
  readonly servers: ReadonlyMap<string, MppServers>;
  readonly store: ReplayStore;
  readonly rpc: TempoRpc;
  // Readiness and startup: the RPC answers with mpp.network's chain ID
  check(timeoutMs: number): Promise<void>;
}

export interface MppSetupOptions {
  readonly config: PlatformConfig;
  // MPP_SECRET_KEY: the challenges' HMAC key, at least 32 bytes, the same on every replica
  readonly secretKey: Secret;
  // Shared by every proxy replica
  readonly store: ReplayStore;
  // How long the startup check may take
  readonly timeoutMs: number;
  // Default: mpp.rpcUrl, else the chain's public RPC
  readonly rpcUrl?: string;
}

/**
 * Prepares the MPP rail, for a platform with MPP enabled. MPP needs `mpp.recipient`, or this throws.
 * The Tempo RPC must answer with `mpp.network`'s chain ID within the timeout, or this throws and the
 * proxy doesn't start. Offered: the asset registry's Tempo assets on `mpp.network`. The realm is the
 * canonical pay host, never a request's `Host`.
 */
export const initializeMpp = async ({ config, secretKey, store, timeoutMs, rpcUrl }: MppSetupOptions): Promise<MppSetup> => {
  const { network, recipient } = config.mpp;
  if (recipient === undefined)
    throw new Error('MPP is on without a recipient. Set mpp.recipient, or set mpp.enabled: false');
  const assets = config.assets
    .filter(asset => asset.network.id === network.id)
    .map(asset => ({ name: asset.name, address: asset.address as Address, decimals: asset.decimals, minPrice: asset.minPrice }));
  if (assets.length === 0)
    throw new Error(`MPP is on, but no asset is on mpp.network (${network.id}). Add a Tempo asset, or set mpp.enabled: false`);

  const rpc = createTempoRpc({ network, url: rpcUrl ?? config.mpp.rpcUrl });
  await rpc.check(timeoutMs);

  const chainId = rpc.chain.id;
  const common = { chainId, recipient: recipient as Address, store, secretKey: secretKey.expose(), realm: new URL(config.urls.pay).host };
  const servers = new Map(assets.map(asset => [asset.address.toLowerCase(), {
    validator: createServer({ ...common, asset, client: rpc.client(config.timeouts.connectMs) }),
    broadcaster: createServer({ ...common, asset, client: rpc.client(config.timeouts.settleMs) }),
  }] as const));

  return {
    network: network.id,
    chainId,
    recipient: recipient as Address,
    assets,
    servers,
    store,
    rpc,
    check: ms => rpc.check(ms),
  };
};
