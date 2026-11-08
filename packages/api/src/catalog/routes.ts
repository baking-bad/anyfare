import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd, parseUsd, usdAmountPattern, type MicroUsd } from '@anyfare/common';
import { paymentMethodsFor, type PlatformConfig } from '@anyfare/core';
import { createCatalogRepository, type Database } from '@anyfare/db';

import { InvalidRequestError } from '../errors.js';

const defaultLimit = 20;

const listQuerySchema = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 200 },
    maxPrice: { type: 'string', pattern: usdAmountPattern, maxLength: 26 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    // An offset, as the previous page's `next` gave it
    cursor: { type: 'string', pattern: '^[0-9]{1,9}$' },
  },
  additionalProperties: false,
} as const;

interface ListQuery {
  readonly q?: string;
  readonly maxPrice?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * `GET /v1/catalog`: the routed endpoints, oldest first, without a key and limited per client IP.
 * They are unverified: their owners haven't registered them.
 */
export const registerCatalogRoutes = (app: FastifyInstance, { db, config, limit }: {
  readonly db: Database;
  readonly config: PlatformConfig;
  readonly limit: onRequestHookHandler;
}): void => {
  const catalog = createCatalogRepository({ db });
  const pay = config.urls.pay.replace(/\/+$/, '');

  app.get<{ Querystring: ListQuery }>('/v1/catalog', { onRequest: limit, schema: { querystring: listQuerySchema } }, async (request, reply) => {
    const { q, limit: pageSize = defaultLimit } = request.query;
    let maxPrice: MicroUsd | undefined;
    try {
      maxPrice = request.query.maxPrice === undefined ? undefined : parseUsd(request.query.maxPrice);
    }
    catch {
      throw new InvalidRequestError('maxPrice is too large');
    }
    const offset = Number(request.query.cursor ?? '0');
    const routed = await catalog.routed({ ...q ? { q } : {}, ...maxPrice === undefined ? {} : { maxPrice }, limit: pageSize, offset });
    const endpoints = routed.entries.map(entry => {
      const price = entry.lastPrice ?? 0n;

      return {
        id: `routed:${entry.host}${entry.path}`,
        host: entry.host,
        path: entry.path,
        title: `${entry.host}${entry.path}`,
        summary: 'A paid API that Anyfare routes payments to. Unverified: its owner hasn\'t registered it.',
        priceFrom: formatUsd(price),
        currency: 'USD',
        methods: paymentMethodsFor(price, config),
        verified: false,
        updatedAt: entry.createdAt.toISOString(),
        link: `${pay}/${entry.host}${entry.path}`,
      };
    });
    reply.header('cache-control', 'public, max-age=60');

    return { endpoints, next: endpoints.length > 0 && offset + endpoints.length < routed.total ? String(offset + endpoints.length) : null };
  });
};
