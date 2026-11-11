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

export interface ApiKeyAuth {
  readonly type: 'api-key';
  // Its value is sent in the X-API-Key header
  readonly apiKey: SecretName;
}

export interface Facilitator {
  readonly name: string;
  readonly url: string;
  readonly networks: readonly NetworkId[];
  readonly auth: CdpAuth | ApiKeyAuth | undefined;
  // A disabled facilitator isn't checked at startup or for readiness, and its networks aren't offered
  readonly enabled: boolean;
}

export interface RateLimit {
  readonly requests: number;
  readonly windowSeconds: number;
}

export interface TopupNetwork {
  // What a client sends
  readonly name: string;
  // 1Click's name for the network
  readonly blockchain: string;
  // The least a top-up on it must be worth
  readonly minimum: MicroUsd;
}

export interface RebalancingTarget {
  // A registry asset on Base or Solana, held by the Signer's hot wallet on its chain
  readonly asset: Asset;
  // 1Click's name for the asset's network
  readonly blockchain: string;
  // Below this, the hot wallet is refilled
  readonly floor: MicroUsd;
  // What a refill brings it up to
  readonly target: MicroUsd;
}

export interface PlatformConfig {
  readonly version: 1;
  readonly environment: Environment;
  readonly logger: { readonly level: LoggerLevel };
  readonly urls: {
    readonly website: string;
    readonly api: string;
    readonly pay: string;
    // The console's origin, which the routes behind the master key answer CORS for. Undefined: no browser page may
    // call them.
    readonly console?: string;
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
    // Top-ups each account may ask for
    readonly topups: RateLimit;
    // Public reads per client IP, such as calls and their receipts. A stream counts once, when it opens.
    readonly publicReads: RateLimit;
  };
  // Open streams of calls on each API process. Over a cap, a new stream gets 429.
  readonly callStream: {
    readonly maxPerIp: number;
    readonly maxTotal: number;
  };
  // The public numbers the workers count from the calls and top-ups
  readonly stats: {
    // The pause between one count of today, 7 and 30 days and the next
    readonly intervalSeconds: number;
    // The pause between one count of all time and the next: it reads every call
    readonly allIntervalSeconds: number;
    // The services with pages of their own, by paid calls over 30 days. Others are read when asked for.
    readonly maxServices: number;
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
    // The hot wallets' public addresses, by chain, for the balance monitor. Undefined: not watched. NEAR's
    // is an account ID, and the Signer won't start with another account in SIGNER_NEAR_ACCOUNT.
    readonly wallets: {
      readonly base: string | undefined;
      readonly tempo: string | undefined;
      readonly solana: string | undefined;
      readonly near: string | undefined;
    };
  };
  // Free Credits for each new account, so a visitor can try the hosted service without a wallet
  readonly freeCredits: {
    readonly enabled: boolean;
    // What each new account gets
    readonly amount: MicroUsd;
    // New accounts per client IP that get the gift. Later ones in the window are created with none.
    readonly perIp: RateLimit;
    // The most given across all IPs in one UTC day. Undefined: no daily cap.
    readonly maxPerDay: MicroUsd | undefined;
  };
  // Top-ups through the 1Click API of NEAR Intents. When enabled, asset, recipient and refundTo are set
  // and there is at least one network.
  readonly topups: {
    readonly enabled: boolean;
    readonly url: string;
    // Its value is sent in the X-API-Key header. Undefined: 1Click is called without a key.
    readonly apiKey: SecretName | undefined;
    // The registry asset 1Click delivers, on a NEAR network
    readonly asset: Asset | undefined;
    // The NEAR account that receives the asset
    readonly recipient: string | undefined;
    // The account inside intents.near that receives refunds
    readonly refundTo: string | undefined;
    readonly slippageBps: number;
    readonly deadlineMinutes: { readonly stablecoin: number; readonly other: number };
    // Symbols, compared without case
    readonly stablecoins: readonly string[];
    readonly timeoutMs: number;
    readonly networks: readonly TopupNetwork[];
  };
  // Refills of the Signer's hot wallets on Base and Solana, paid from its NEAR hot wallet through 1Click
  // at topups.url. When enabled, source is set, there is at least one target, and the platform config
  // names the Signer's wallet on NEAR and on each target's chain.
  readonly rebalancing: {
    // Off: the Signer refuses every refill, and the workers' job does nothing
    readonly enabled: boolean;
    // The registry asset refills are paid with, on a NEAR network
    readonly source: Asset | undefined;
    readonly leastPerRefill: MicroUsd;
    readonly mostPerRefill: MicroUsd;
    // Per target asset per UTC day, counting what leaves the NEAR hot wallet
    readonly mostPerAssetPerDay: MicroUsd;
    // 1Click's cost, amountIn minus amountOut, at most this share of the amount, in basis points
    readonly maxFeeBps: number;
    // The slippage tolerance sent to 1Click, in basis points
    readonly slippageBps: number;
    // How long 1Click has before it refunds an unfinished swap
    readonly deadlineMinutes: number;
    // How often the workers' job runs
    readonly intervalSeconds: number;
    // Each asset once
    readonly targets: readonly RebalancingTarget[];
  };
}
