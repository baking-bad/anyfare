import { Counter, type Registry } from '@prometheus-io/client';
import type { FastifyRequest } from 'fastify';

import type { Clock, MicroUsd } from '@anyfare/common';
import { rateLimitClient, utcDay, type PlatformConfig, type RateLimit, type RateLimiter } from '@anyfare/core';

/** What a sign-up's gift came to while the gift is on. */
export const freeCreditsResults = ['given', 'ip_limit', 'day_limit', 'unavailable'] as const;
export type FreeCreditsResult = typeof freeCreditsResults[number];

export interface FreeCreditsOptions {
  readonly config: PlatformConfig['freeCredits'];
  readonly limiter: RateLimiter;
  // The UTC day the daily cap counts on
  readonly clock: Clock;
  // Each decision while the gift is on. Default: none.
  readonly record?: (result: FreeCreditsResult) => void;
}

/** What one sign-up gives the new account: the gift's amount, or 0. It never throws. */
export type FreeCreditsDecider = (request: Pick<FastifyRequest, 'ip' | 'log'>) => Promise<MicroUsd>;

// The daily cap's window. Its key carries the UTC day, so each day counts on its own.
const daySeconds = 86_400;

/**
 * Decides the sign-up gift with fixed windows: one per client IP, under
 * `rl:api:free-credits:<client>`, and with a daily cap, one across all IPs, under
 * `rl:api:free-credits-day:<YYYY-MM-DD>`, which counts only clients still under their own limit.
 * While the gift is off it calls nothing. When the limiter fails, such as while Redis is down, the
 * account gets nothing and the sign-up goes on.
 */
export const createFreeCredits = ({ config, limiter, clock, record = () => undefined }: FreeCreditsOptions): FreeCreditsDecider => {
  const { enabled, amount, perIp, maxPerDay } = config;
  // As many gifts a day as the cap holds whole
  const perDay: RateLimit | undefined = maxPerDay === undefined ? undefined : { requests: Number(maxPerDay / amount), windowSeconds: daySeconds };

  const decide = async (ip: string): Promise<FreeCreditsResult> => {
    if (!(await limiter.hit(`api:free-credits:${rateLimitClient(ip)}`, perIp)).allowed)
      return 'ip_limit';
    if (perDay && !(await limiter.hit(`api:free-credits-day:${utcDay(clock.now())}`, perDay)).allowed)
      return 'day_limit';

    return 'given';
  };

  return async ({ ip, log }) => {
    if (!enabled)
      return 0n;

    let result: FreeCreditsResult;
    try {
      result = await decide(ip);
    }
    catch (error) {
      log.warn({ error }, 'The rate limiter failed, so the new account gets no free credits');
      result = 'unavailable';
    }
    record(result);

    return result === 'given' ? amount : 0n;
  };
};

/** Counts the gift's decisions as `api_free_credits_total`, by result. */
export const createFreeCreditsCounter = (registry: Registry): ((result: FreeCreditsResult) => void) => {
  const decisions = new Counter({
    name: 'api_free_credits_total',
    help: 'Sign-ups while free credits are on, by what the gift came to: given, ip_limit, day_limit, unavailable',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  return result => decisions.inc({ result });
};
