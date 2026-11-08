// The platform config file as written: one per deployment.

export type Environment = 'staging' | 'production';
export type LoggerLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface PlatformUrlsDocument {
  readonly website: string;
  readonly api: string;
  readonly pay: string;
}

export interface KeyPrefixesDocument {
  readonly master: string;
  readonly payment: string;
}

export interface AssetDocument {
  readonly name: string;
  readonly network: string;
  // ERC-20 contract or Solana mint
  readonly address: string;
  readonly decimals: number;
  // Only USD-pegged stablecoins are supported: 1 unit = 1 USD
  readonly peg: 'usd';
  // Calls cheaper than this don't offer the asset, because its network fee would exceed the price
  readonly minPrice?: string;
  // Our address that receives the asset from buyers. Optional: without it the asset is not offered to
  // buyers, but we can still pay APIs in it.
  readonly payTo?: string;
}

export interface RateLimitDocument {
  readonly requests: number;
  readonly windowSeconds: number;
}

export interface RateLimitsDocument {
  readonly signup: RateLimitDocument;
}

export interface TimeoutsDocument {
  readonly connectMs?: number;
  readonly requestMs?: number;
  readonly settleMs?: number;
}

export interface PlatformConfigDocument {
  readonly version: 1;
  readonly environment: Environment;
  readonly logger?: { readonly level?: LoggerLevel };
  readonly urls: PlatformUrlsDocument;
  // Extra hosts and IP addresses we own. The hosts of `urls` are always included.
  readonly ownHosts?: readonly string[];
  readonly keyPrefixes: KeyPrefixesDocument;
  readonly paymentKeyDefaults?: { readonly dailyBudget?: string };
  readonly assets: readonly AssetDocument[];
  readonly rateLimits: RateLimitsDocument;
  readonly timeouts?: TimeoutsDocument;
}
