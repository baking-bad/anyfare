import { Registry } from '@prometheus-io/client';
import { describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import { RateLimitedError, type RateLimit, type RateLimiter } from '@anyfare/core';

import { createProxyMetrics } from '../../src/metrics.js';
import { createProxyLimits } from '../../src/payments/limits.js';

const limits = {
  paymentKey: { requests: 2, windowSeconds: 60 },
  unpaidIp: { requests: 1, windowSeconds: 30 },
  probeIp: { requests: 2, windowSeconds: 60 },
};

// Counts in memory, like the Redis limiter: the first hit opens the window
const createCountingLimiter = (): RateLimiter & { readonly hits: string[] } => {
  const counts = new Map<string, number>();
  const hits: string[] = [];

  return {
    hits,
    hit: async (key: string, { requests, windowSeconds }: RateLimit) => {
      hits.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);

      return { allowed: count <= requests, retryAfterSeconds: windowSeconds };
    },
  };
};

const setup = (limiter: RateLimiter = createCountingLimiter()) => {
  const registry = new Registry();
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

  return { proxyLimits: createProxyLimits({ limiter, limits, logger, metrics: createProxyMetrics(registry) }), registry, lines };
};

describe('the proxy\'s rate limits', () => {
  it('counts per payment key, per unpaid IP, and per probing IP, each under its own key and limit', async () => {
    const limiter = createCountingLimiter();
    const { proxyLimits } = setup(limiter);

    await proxyLimits.paymentKey('hash-1');
    await proxyLimits.unpaid('203.0.113.7');
    await proxyLimits.probe('203.0.113.7');
    await proxyLimits.probe('203.0.113.7');

    expect(limiter.hits).toEqual(['proxy:paymentKey:hash-1', 'proxy:unpaidIp:203.0.113.7', 'proxy:probeIp:203.0.113.7', 'proxy:probeIp:203.0.113.7']);
    await expect(proxyLimits.probe('203.0.113.7')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('refuses over a limit with rate_limited and the window\'s Retry-After, and counts it', async () => {
    const { proxyLimits, registry } = setup();
    await proxyLimits.paymentKey('hash-1');
    await proxyLimits.paymentKey('hash-1');

    const error = await proxyLimits.paymentKey('hash-1').catch((thrown: unknown) => thrown);
    await proxyLimits.paymentKey('hash-2');

    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 60 });
    expect(await registry.metrics()).toContain('proxy_rate_limited_total{limit="paymentKey"} 1');
  });

  it('counts an IPv6 client by its /64, and an IPv4-mapped one as IPv4', async () => {
    const limiter = createCountingLimiter();
    const { proxyLimits } = setup(limiter);

    await proxyLimits.unpaid('2001:db8:1:2::7');
    await expect(proxyLimits.unpaid('2001:db8:1:2:ffff::1')).rejects.toBeInstanceOf(RateLimitedError);
    await proxyLimits.unpaid('::ffff:198.51.100.4');

    expect(limiter.hits).toEqual(['proxy:unpaidIp:2001:db8:1:2::/64', 'proxy:unpaidIp:2001:db8:1:2::/64', 'proxy:unpaidIp:198.51.100.4']);
  });

  it('lets the request through when the limiter fails, and logs and counts it', async () => {
    const { proxyLimits, registry, lines } = setup({ hit: async () => Promise.reject(new Error('Redis is down')) });

    await expect(proxyLimits.unpaid('203.0.113.7')).resolves.toBeUndefined();

    expect(lines).toContainEqual(expect.objectContaining({ limit: 'unpaidIp', msg: 'The rate limiter failed, so the request goes through' }));
    expect(await registry.metrics()).toContain('proxy_rate_limiter_errors_total 1');
  });
});
