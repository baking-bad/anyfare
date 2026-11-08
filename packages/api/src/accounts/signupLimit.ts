import type { FastifyReply, FastifyRequest } from 'fastify';

import { RateLimitedError, rateLimitClient, type RateLimit, type RateLimiter } from '@anyfare/core';

export interface SignupLimitOptions {
  readonly limiter: RateLimiter;
  readonly limit: RateLimit;
}

/**
 * An `onRequest` hook for an endpoint that needs no key: a fixed window per client IP, under
 * `rl:api:<name>:<ip>`. Over the limit: `429 rate_limited` with `Retry-After`.
 */
export const createIpLimit = ({ limiter, limit, name }: SignupLimitOptions & { readonly name: string }) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { allowed, retryAfterSeconds } = await limiter.hit(`api:${name}:${rateLimitClient(request.ip)}`, limit);
    if (allowed)
      return;

    reply.header('retry-after', String(retryAfterSeconds));
    throw new RateLimitedError(retryAfterSeconds);
  };

/** The `onRequest` hook for `POST /v1/accounts`, under `rl:api:signup:<ip>`. */
export const createSignupLimit = (options: SignupLimitOptions) => createIpLimit({ ...options, name: 'signup' });
