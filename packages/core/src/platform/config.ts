import type { AssetName, MicroUsd, NetworkId } from '@anyfare/common';

import type { NetworkInfo } from '../networks.js';
import type { Environment, LoggerLevel } from './document.js';

// The platform config as apps use it: defaults applied, amounts in micro-USD, deeply frozen.
// Secret fields keep the environment variable name; apps read values with `readSecret`.

export type SecretName = string;

export interface Asset {
  readonly name: AssetName;
  readonly network: NetworkInfo;
  readonly address: string;
  readonly decimals: number;
  readonly peg: 'usd';
  readonly minPrice: MicroUsd;
  // Undefined: the asset is not offered to buyers, but we can still pay APIs in it
  readonly payTo: string | undefined;
}

export interface CdpAuth {
  readonly type: 'cdp';
  readonly apiKeyId: SecretName;
  readonly apiKeySecret: SecretName;
}

export interface Facilitator {
  readonly name: string;
  readonly url: string;
  readonly networks: readonly NetworkId[];
  readonly auth: CdpAuth | undefined;
  // A disabled facilitator isn't checked at startup or for readiness, and its networks aren't offered
  readonly enabled: boolean;
}

export interface RateLimit {
  readonly requests: number;
  readonly windowSeconds: number;
}

export interface PlatformConfig {
  readonly version: 1;
  readonly environment: Environment;
  readonly logger: { readonly level: LoggerLevel };
  readonly urls: {
    readonly website: string;
    readonly api: string;
    readonly pay: string;
  };
  // Lowercase hostnames and IP addresses, including the hosts of `urls`
  readonly ownHosts: readonly string[];
  readonly keyPrefixes: {
    readonly master: string;
    readonly payment: string;
  };
  readonly paymentKeyDefaults: { readonly dailyBudget: MicroUsd };
  // The fee on top of a routed target's price, in basis points
  readonly routingFeeBps: number;
  readonly assets: readonly Asset[];
  readonly facilitators: readonly Facilitator[];
  readonly mpp: {
    readonly network: NetworkInfo;
    // Undefined: MPP is not offered to buyers
    readonly recipient: string | undefined;
    // A disabled MPP isn't offered or checked, and its RPC isn't called
    readonly enabled: boolean;
    // The Tempo RPC the proxy and workers use. Undefined: the chain's public RPC.
    readonly rpcUrl: string | undefined;
  };
  readonly rateLimits: {
    readonly paymentKey: RateLimit;
    readonly unpaidIp: RateLimit;
    // Sign-ups per client IP
    readonly signup: RateLimit;
    // Public documents per client IP
    readonly documents: RateLimit;
    // Probes of routed targets per client IP: calls whose quote isn't cached, paid or not
    readonly probeIp: RateLimit;
  };
  readonly timeouts: {
    readonly connectMs: number;
    readonly requestMs: number;
    readonly settleMs: number;
  };
  readonly sizeLimits: {
    readonly requestBodyBytes: number;
    readonly bufferedResponseBytes: number;
  };
  readonly signer: {
    readonly maxPerCall: MicroUsd;
    readonly maxPerNetworkPerHour: MicroUsd | undefined;
    readonly maxPerNetworkPerDay: MicroUsd;
    // The hot wallets' public addresses, by chain, for the balance monitor. Undefined: not watched.
    readonly wallets: { readonly base: string | undefined; readonly tempo: string | undefined; readonly solana: string | undefined };
  };
}
