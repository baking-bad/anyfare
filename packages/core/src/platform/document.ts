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
  readonly topups?: RateLimitDocument;
  readonly publicReads?: RateLimitDocument;
}

export interface CallStreamDocument {
  // Open streams of calls per client IP on each API process. Default: 20.
  readonly maxPerIp?: number;
  // Open streams of calls on each API process. Default: 1000.
  readonly maxTotal?: number;
}

export interface StatsDocument {
  // How often the workers count today, 7 and 30 days, in seconds. Default: 300.
  readonly intervalSeconds?: number;
  // How often they count all time, in seconds. Default: 3600.
  readonly allIntervalSeconds?: number;
  // The services with pages of their own, by paid calls over 30 days. Default: 1000.
  readonly maxServices?: number;
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

export interface FreeCreditsDocument {
  // Default: false. The operator turns the gift on.
  readonly enabled?: boolean;
  // What each new account gets. Default: "0.1".
  readonly amount?: string;
  // New accounts per client IP that get the gift. Default: 3 a day.
  readonly perIp?: RateLimitDocument;
  // The most given across all IPs in one UTC day. No default: without it there is no daily cap.
  readonly maxPerDay?: string;
}

export interface TopupNetworkDocument {
  // What a client sends, such as base
  readonly name: string;
  // 1Click's name for the network, such as arb
  readonly blockchain: string;
  // The least a top-up on it must be worth, in USD. More than 0.
  readonly minimum: string;
}

export interface TopupsDocument {
  // Default: false
  readonly enabled?: boolean;
  // The 1Click API. Default: https://1click.chaindefuser.com
  readonly url?: string;
  // The name of the environment variable that holds the 1Click key, never the value. Optional.
  readonly apiKey?: string;
  // The registry asset 1Click delivers: one on a NEAR network
  readonly asset?: string;
  // The NEAR account that receives the asset
  readonly recipient?: string;
  // The account inside intents.near that receives refunds
  readonly refundTo?: string;
  // Default: 100
  readonly slippageBps?: number;
  // How long a deposit address takes transfers. Defaults: 1440 for a stablecoin, 120 for another token.
  readonly deadlineMinutes?: { readonly stablecoin?: number; readonly other?: number };
  // The symbols that count as stablecoins, compared without case
  readonly stablecoins?: readonly string[];
  // Each call to 1Click. Default: 15000.
  readonly timeoutMs?: number;
  // The networks a client may send from. At least one when enabled.
  readonly networks?: readonly TopupNetworkDocument[];
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
  readonly callStream?: CallStreamDocument;
  readonly stats?: StatsDocument;
  readonly timeouts?: TimeoutsDocument;
  readonly sizeLimits?: SizeLimitsDocument;
  readonly signer?: SignerLimitsDocument;
  // Free Credits for each new account, so a visitor can try the hosted service without a wallet
  readonly freeCredits?: FreeCreditsDocument;
  // Top-ups: any token on any chain, swapped to USDC on NEAR by the 1Click API of NEAR Intents
  readonly topups?: TopupsDocument;
}
