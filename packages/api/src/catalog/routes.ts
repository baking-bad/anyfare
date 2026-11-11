import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';

import { formatUsd, parseUsd, usdAmountPattern, type Clock, type MicroUsd } from '@anyfare/common';
import { listedStatuses, paymentMethodsFor, type PlatformConfig } from '@anyfare/core';
import { createCatalogRepository, type Database } from '@anyfare/db';

import { InvalidRequestError } from '../errors.js';
import { publicCors, publicReadMethods } from '../public/cors.js';
import { boolean, list, object, string, time, usdString } from '../schemas.js';
import { createKeyedCache } from '../stats/live.js';

const defaultLimit = 20;
// A page read is kept this long in the process, by its normalized query: a page of 100 endpoints is at most
// about 800 KB, so a few MB hold the pages asked for most
export const catalogCacheMs = 10_000;
const catalogCacheBytes = 4 * 1024 * 1024;
const catalogCacheEntryBytes = 1024 * 1024;
const catalogReadsAtOnce = 4;

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

// An endpoint as `read` makes it
const catalogSchema = object({
  endpoints: list(object({
    id: string,
    host: string,
    path: string,
    title: string,
    summary: string,
    priceFrom: { ...usdString, description: 'The last price seen, in USD: "0" when none' },
    currency: { type: 'string', enum: ['USD'] },
    methods: { ...list(string), description: 'How a buyer may pay for a call at this price' },
    verified: { ...boolean, description: 'Always false: the API\'s owner hasn\'t registered it' },
    status: { type: 'string', enum: [...listedStatuses], description: '`paid`: a paid call reached it. `checked`: only a payable check listed it' },
    updatedAt: time,
    link: { type: 'string', description: 'The link to call through the pay host' },
  })),
  next: { type: ['string', 'null'], description: 'The next page\'s `cursor`. Null: the last page' },
});

interface CatalogPage {
  readonly endpoints: readonly Record<string, unknown>[];
  readonly next: string | null;
}

interface ListQuery {
  readonly q?: string;
  readonly maxPrice?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * `GET /v1/catalog`: the routed endpoints, oldest first, without a key, limited per client IP, and
 * readable from any origin. They are unverified: their owners haven't registered them. `status` says
 * whether a paid call reached each, or only a payable check listed it. A host the blocklist names, or names
 * a parent domain of, is never listed. Pages reach 10,000 endpoints deep, and are kept 10 s in the process.
 */
export const registerCatalogRoutes = (app: FastifyInstance, { db, config, limit, clock }: {
  readonly db: Database;
  readonly config: PlatformConfig;
  readonly limit: onRequestHookHandler;
  readonly clock: Clock;
}): void => {
  const catalog = createCatalogRepository({ db });
  const pay = config.urls.pay.replace(/\/+$/, '');
  const pages = createKeyedCache<CatalogPage>({
    clock, ttlMs: catalogCacheMs, maxBytes: catalogCacheBytes, maxEntryBytes: catalogCacheEntryBytes, maxReading: catalogReadsAtOnce,
    sizeOf: page => JSON.stringify(page).length,
  });

  const read = async (query: { readonly q?: string; readonly maxPrice?: MicroUsd; readonly pageSize: number; readonly offset: number }): Promise<CatalogPage> => {
    const { q, maxPrice, pageSize, offset } = query;
    const routed = await catalog.routed({ ...q ? { q } : {}, ...maxPrice === undefined ? {} : { maxPrice }, limit: pageSize, offset });
    const endpoints = routed.entries.map(entry => {
      const price = entry.lastPrice ?? 0n;

      return {
        id: `routed:${entry.host}${entry.path}`,
        host: entry.host,
        path: entry.path,
        title: `${entry.host}${entry.path}`,
        summary: entry.status === 'checked'
          ? 'A paid API a check found payable, that Anyfare routes payments to. No paid call has reached it yet. Unverified: its owner hasn\'t registered it.'
          : 'A paid API that Anyfare routes payments to. Unverified: its owner hasn\'t registered it.',
        priceFrom: formatUsd(price),
        currency: 'USD',
        methods: paymentMethodsFor(price, config),
        verified: false,
        status: entry.status,
        updatedAt: entry.createdAt.toISOString(),
        link: `${pay}/${entry.host}${entry.path}`,
      };
    });

    return { endpoints, next: routed.more ? String(offset + endpoints.length) : null };
  };

  const list = async (request: FastifyRequest<{ Querystring: ListQuery }>, reply: FastifyReply) => {
    const { q, limit: pageSize = defaultLimit } = request.query;
    let maxPrice: MicroUsd | undefined;
    try {
      maxPrice = request.query.maxPrice === undefined ? undefined : parseUsd(request.query.maxPrice);
    }
    catch {
      throw new InvalidRequestError('maxPrice is too large');
    }
    const offset = Number(request.query.cursor ?? '0');
    // A search without case is one query whatever its case
    const search = q ? q.toLowerCase() : undefined;
    const key = JSON.stringify([search ?? '', maxPrice?.toString() ?? '', pageSize, offset]);
    const page = await pages.get(key, () => read({ ...search === undefined ? {} : { q: search }, ...maxPrice === undefined ? {} : { maxPrice }, pageSize, offset }));
    reply.header('cache-control', 'public, max-age=60');

    return page;
  };
  // Any origin may read it
  app.route<{ Querystring: ListQuery }>({
    method: [...publicReadMethods],
    url: '/v1/catalog',
    onRequest: [publicCors, limit],
    schema: {
      summary: 'The paid APIs Anyfare routes payments to, oldest first',
      description: 'No key. Limited per address. The endpoints are unverified: their owners haven\'t registered them.',
      tags: ['catalog'],
      errors: ['rate_limited', 'invalid_request'],
      querystring: listQuerySchema,
      response: { 200: catalogSchema },
    },
    handler: list,
  });
};
