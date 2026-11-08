import type { AssetName, MicroUsd } from '@anyfare/common';

import type { NetworkInfo } from '../networks.js';
import type { Environment, LoggerLevel } from './document.js';

// The platform config as apps use it: defaults applied, amounts in micro-USD, deeply frozen.

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
  readonly assets: readonly Asset[];
  readonly rateLimits: {
    // Sign-ups per client IP
    readonly signup: RateLimit;
  };
  readonly timeouts: {
    readonly connectMs: number;
    readonly requestMs: number;
    readonly settleMs: number;
  };
}
