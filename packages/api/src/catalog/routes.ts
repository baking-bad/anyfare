import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';

import { parseUsd, usdAmountPattern, type Clock, type MicroUsd } from '@anyfare/common';
import { listedStatuses, type PlatformConfig } from '@anyfare/core';
import { catalogScanBudget, createCatalogRepository, type CatalogCursor, type Database } from '@anyfare/db';

import { InvalidRequestError, StatsUnavailableError } from '../errors.js';
import { createBlocklistCache, type BlocklistCache } from '../public/blocklist.js';
import { publicCors, publicReadMethods } from '../public/cors.js';
import { boolean, list, object, string, time, usdString } from '../schemas.js';
import { createKeyedCache } from '../stats/live.js';
import { catalogEntryOf, decodeCursor, encodeCursor, maxCursorLength } from './entries.js';

const defaultLimit = 20;
// A page read is kept this long in the process, by its normalized query: a page of 100 endpoints is at most
// about 800 KB, so a few MB hold the pages asked for most
export const catalogCacheMs = 10_000;
const catalogCacheBytes = 4 * 1024 * 1024;
const catalogCacheEntryBytes = 1024 * 1024;
const catalogReadsAtOnce = 4;
// Each statement of a page gives up after this: an expired read answers 503, and is never kept
export const catalogReadTimeoutMs = 2_000;

const listQuerySchema = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 200 },
    maxPrice: { type: 'string', pattern: usdAmountPattern, maxLength: 26 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    // As the previous page's `next` gave it
    cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', maxLength: maxCursorLength },
  },
  additionalProperties: false,
} as const;

// An endpoint as `catalogEntryOf` makes it
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
  next: { type: ['string', 'null'], description: 'The next page\'s `cursor`, opaque. Null: the last page' },
  partial: {
    ...boolean,
    description: `True: the search read its ${catalogScanBudget.toLocaleString('en-US')} endpoints for this page before the end, and \`next\` goes on from there. `
      + 'A page of a search may so hold fewer endpoints than `limit`, or none, before the last',
  },
});

interface CatalogPage {
  readonly endpoints: readonly Record<string, unknown>[];
  readonly next: string | null;
  readonly partial: boolean;
}

interface ListQuery {
  readonly q?: string;
  readonly maxPrice?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * `GET /v1/catalog`: the routed endpoints, oldest first, without a key, limited per client IP, and readable from
 * any origin. They are unverified: their owners haven't registered them. `status` says whether a paid call reached
 * each, or only a payable check listed it. A host the blocklist names, or names a parent domain of, is never listed.
 * Pages go on to the end by a keyset cursor on the catalog's index; a search reads at most `catalogScanBudget`
 * endpoints a page. Each statement gives up after 2 s on the public reads' pool, and a page is kept 10 s in the process.
 */
export const registerCatalogRoutes = (app: FastifyInstance, { db, config, limit, clock, blocklist = createBlocklistCache({ db, clock }) }: {
  readonly db: Database;
  readonly config: PlatformConfig;
  readonly limit: onRequestHookHandler;
  readonly clock: Clock;
  readonly blocklist?: BlocklistCache;
}): void => {
  const catalog = createCatalogRepository({ db });
  const payUrl = config.urls.pay;
  const pages = createKeyedCache<CatalogPage>({
    clock, ttlMs: catalogCacheMs, maxBytes: catalogCacheBytes, maxEntryBytes: catalogCacheEntryBytes, maxReading: catalogReadsAtOnce,
    sizeOf: page => JSON.stringify(page).length,
  });

  const read = async (query: { readonly q?: string; readonly maxPrice?: MicroUsd; readonly pageSize: number; readonly after?: CatalogCursor }): Promise<CatalogPage> => {
    const { q, maxPrice, pageSize, after } = query;
    const isBlocked = await blocklist.get();
    const routed = await catalog.routed({
      ...q ? { q } : {}, ...maxPrice === undefined ? {} : { maxPrice }, ...after === undefined ? {} : { after }, limit: pageSize, isBlocked,
      timeoutMs: catalogReadTimeoutMs,
    });

    return {
      endpoints: routed.entries.map(entry => catalogEntryOf(entry, { payUrl, config })),
      next: routed.next === undefined ? null : encodeCursor(routed.next),
      partial: routed.partial,
    };
  };

  const listEndpoints = async (request: FastifyRequest<{ Querystring: ListQuery }>, reply: FastifyReply) => {
    const { q, limit: pageSize = defaultLimit, cursor } = request.query;
    let maxPrice: MicroUsd | undefined;
    try {
      maxPrice = request.query.maxPrice === undefined ? undefined : parseUsd(request.query.maxPrice);
    }
    catch {
      throw new InvalidRequestError('maxPrice is too large');
    }
    // Only a cursor a page gave: an offset, as pages gave before, is refused
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    if (cursor !== undefined && after === undefined)
      throw new InvalidRequestError('cursor is not one a page of the catalog gave: start from the first page');
    // A search without case is one query whatever its case
    const search = q ? q.toLowerCase() : undefined;
    const key = JSON.stringify([search ?? '', maxPrice?.toString() ?? '', pageSize, cursor ?? '']);
    let page: CatalogPage;
    try {
      page = await pages.get(key, () => read({
        ...search === undefined ? {} : { q: search }, ...maxPrice === undefined ? {} : { maxPrice }, ...after === undefined ? {} : { after }, pageSize,
      }));
    }
    catch (error) {
      // A read that couldn't finish in its bounds, or a pool with no connection free in time
      if (error instanceof StatsUnavailableError)
        throw error;
      throw new StatsUnavailableError('The catalog can\'t be read right now: try again shortly', { cause: error });
    }
    reply.header('cache-control', 'public, max-age=60');

    return page;
  };
  // Every answer is no-store until it succeeds: an error, a 503 above all, is never kept by a cache
  const noStore = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header('cache-control', 'no-store');
  };
  // Any origin may read it
  app.route<{ Querystring: ListQuery }>({
    method: [...publicReadMethods],
    url: '/v1/catalog',
    onRequest: [publicCors, noStore, limit],
    schema: {
      summary: 'The paid APIs Anyfare routes payments to, oldest first',
      description: 'No key. Limited per address. The endpoints are unverified: their owners haven\'t registered them. Pages go on to the end: '
        + `\`next\` is the next page's cursor. A search reads at most ${catalogScanBudget.toLocaleString('en-US')} endpoints a page, and \`partial\` `
        + 'says when it stopped there. A cursor no page gave answers 400.',
      tags: ['catalog'],
      errors: ['rate_limited', 'invalid_request', 'stats_unavailable'],
      querystring: listQuerySchema,
      response: { 200: catalogSchema },
    },
    handler: listEndpoints,
  });
};
