import type { Logger } from '@anyfare/common';
import { rateLimitClient, RateLimitedError, type PlatformConfig, type RateLimiter } from '@anyfare/core';

import type { ProxyMetrics } from '../metrics.js';

export type LimitName = 'paymentKey' | 'unpaidIp' | 'probeIp';

/** Rate limits in Redis, shared by every replica. Each throws RateLimitedError over its limit. */
export interface ProxyLimits {
  /** A request that gets only the `402` or a quote, per client IP. */
  unpaid(ip: string): Promise<void>;
  /** A request with a payment key, per key: by its hash, before any lookup. */
  paymentKey(keyHash: string): Promise<void>;
  /** A request whose quote isn't cached, paid or not, per client IP: before its opt-out fetch and probe. */
  probe(ip: string): Promise<void>;
}

export interface ProxyLimitsOptions {
  readonly limiter: RateLimiter;
  readonly limits: Pick<PlatformConfig['rateLimits'], LimitName>;
  readonly logger: Logger;
  readonly metrics: Pick<ProxyMetrics, 'rateLimited' | 'rateLimiterError'>;
}

/**
 * The proxy's limits, as fixed windows under `rl:proxy:<limit>:<key>`. While Redis fails, a limit lets
 * the request through and logs it: paid calls keep working, and the ledger still guards the money.
 */
export const createProxyLimits = ({ limiter, limits, logger, metrics }: ProxyLimitsOptions): ProxyLimits => {
  const hit = async (name: LimitName, key: string): Promise<void> => {
    let allowed: boolean;
    let retryAfterSeconds: number;
    try {
      ({ allowed, retryAfterSeconds } = await limiter.hit(`proxy:${name}:${key}`, limits[name]));
    }
    catch (error) {
      metrics.rateLimiterError();
      logger.warn({ error, limit: name }, 'The rate limiter failed, so the request goes through');
      return;
    }
    if (allowed)
      return;

    metrics.rateLimited(name);
    throw new RateLimitedError(retryAfterSeconds);
  };

  return {
    unpaid: ip => hit('unpaidIp', rateLimitClient(ip)),
    paymentKey: keyHash => hit('paymentKey', keyHash),
    probe: ip => hit('probeIp', rateLimitClient(ip)),
  };
};
