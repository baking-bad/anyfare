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

export interface CdpAuthDocument {
  readonly type: 'cdp';
  // The names of the environment variables that hold the key, never the values
  readonly apiKeyId: string;
  readonly apiKeySecret: string;
}

export interface ApiKeyAuthDocument {
  readonly type: 'api-key';
  // The name of the environment variable that holds the key, never the value
  readonly apiKey: string;
}

export interface FacilitatorDocument {
  readonly name: string;
  readonly url: string;
  readonly networks: readonly string[];
  readonly auth?: CdpAuthDocument | ApiKeyAuthDocument;
  // Default: true. A disabled facilitator isn't checked, and its networks aren't offered.
  readonly enabled?: boolean;
}

export interface MppDocument {
  readonly network: string;
  // Our Tempo address that receives MPP payments. Without it MPP is not offered to buyers.
  readonly recipient?: string;
  // Default: true. A disabled MPP isn't offered, and its RPC isn't checked.
  readonly enabled?: boolean;
  // The Tempo RPC, without credentials. Default: the chain's public RPC.
  readonly rpcUrl?: string;
}

export interface RateLimitDocument {
  readonly requests: number;
  readonly windowSeconds: number;
}

export interface RateLimitsDocument {
  readonly paymentKey: RateLimitDocument;
  readonly unpaidIp: RateLimitDocument;
  readonly signup: RateLimitDocument;
  readonly documents?: RateLimitDocument;
  readonly probeIp?: RateLimitDocument;
}

export interface TimeoutsDocument {
  readonly connectMs?: number;
  readonly requestMs?: number;
  readonly settleMs?: number;
}

export interface SizeLimitsDocument {
  readonly requestBodyBytes?: number;
  readonly bufferedResponseBytes?: number;
}

export interface SignerLimitsDocument {
  readonly maxPerCall?: string;
  readonly maxPerNetworkPerHour?: string;
  readonly maxPerNetworkPerDay?: string;
  // The hot wallets' public addresses, for the balance monitor. Never their keys. NEAR's is an account ID.
  readonly wallets?: { readonly base?: string; readonly tempo?: string; readonly solana?: string; readonly near?: string };
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
  // The fee on top of a routed target's price, in basis points
  readonly routingFeeBps: number;
  readonly assets: readonly AssetDocument[];
  readonly facilitators: readonly FacilitatorDocument[];
  readonly mpp: MppDocument;
  readonly rateLimits: RateLimitsDocument;
  readonly timeouts?: TimeoutsDocument;
  readonly sizeLimits?: SizeLimitsDocument;
  readonly signer?: SignerLimitsDocument;
}
