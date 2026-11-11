import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';

import type { Clock } from '@anyfare/common';
import {
  buildEndpointAnswer, buildLiveAnswer, buildServicePage, composePlatformAnswer, createPaidWith, emptyTopAnswer, endpointDailyDays, endpointListEntry,
  endpointNumbersOf, lastUtcDays, maxEndpointReadPathLength, minuteStart, periodBefore, periodStart, type EndpointAnswer, type LiveAnswer, type PlatformConfig,
  type ServiceAnswer, type StatsPeriod,
} from '@anyfare/core';
import {
  createStatsCounter, createStatsRepository, type CallScope, type CountMarks, type Database, type HostListing, type ServicesSort, type StoredEndpointRow,
} from '@anyfare/db';

import { errorSchema } from '../calls/schemas.js';
import { NotFoundError, StatsUnavailableError } from '../errors.js';
import { createBlocklistCache, type BlocklistCache } from '../public/blocklist.js';
import { publicCors, publicReadMethods } from '../public/cors.js';
import { createShownServices, isUnlisted, listedPage, servicesPage, topWithoutBlocked } from './listed.js';
import { createKeyedCache, createLiveCache, createSnapshotCache } from './live.js';
import {
  endpointQuerySchema, endpointSchema, liveSchema, noQuerySchema, periodQuerySchema, platformSchema, serviceParamsSchema, serviceSchema, servicesQuerySchema,
  servicesSchema, topSchema,
} from './schemas.js';

export interface StatsRoutesOptions {
  readonly db: Database;
  readonly config: PlatformConfig;
  // The `publicReads` limit per client IP
  readonly limit: onRequestHookHandler;
  readonly clock: Clock;
  // The calls a read when asked for counts at most. Default: 10,000.
  readonly readCap?: number;
  // The blocklist as the public reads match it. Default: one read from `db`.
  readonly blocklist?: BlocklistCache;
}

// The workers count again every few minutes: a minute in a cache adds little to that
const countedCache = 'public, max-age=60';
const liveCache = 'public, max-age=10';
// A host or an endpoint with no row of its own is read when asked for: its newest calls up to this cap, each
// statement giving up after the timeout, kept in the process for a minute in a few MB, a few such reads at once
export const askedReadCap = 10_000;
export const askedReadTimeoutMs = 2_000;
const askedCacheMs = 60_000;
export const askedCacheBytes = 4 * 1024 * 1024;
// A served service answer stays under about 100 KB: a larger one isn't kept
export const askedCacheEntryBytes = 128 * 1024;
const askedReadsAtOnce = 2;
// What checks listed of a host, read when its page is asked for: a newly checked link shows within 5 seconds,
// 2 here and 3 in a cache in front. One read is at most 20 checked endpoints and 100 check times, about 20 KB.
export const listingCacheMs = 2_000;
const listingCacheBytes = 1024 * 1024;
const listingCacheEntryBytes = 64 * 1024;
const listingReadsAtOnce = 4;
const listedCache = 'public, max-age=3';
// Every service the list may show, read in one statement giving up after 2 s, kept 5 s in the process, and each page
// of it 55 s in a cache in front: a newly checked host shows within a minute. Each page is sorted and searched in
// the process, from at most stats.maxServices stored services, as many paid ones not stored, and the pool's 1,000.
export const servicesCacheMs = 5_000;
const servicesCache = 'public, max-age=55';
// Every public read of the listed services, their pages and what checks listed gives up after this
export const publicReadTimeoutMs = 2_000;
const unlisted = 'No paid call or payable check has listed this host';

// The live numbers' read of the calls since the frequent count gives up after this
const liveReadTimeoutMs = 2_000;
const dayMs = 86_400_000;
const minuteMs = 60_000;

// The error answers of a public number: a query it can't take, over the limit, or a read that couldn't finish. A route
// without a query takes any, and only a service's page can be not found.
const errors = { 400: errorSchema, 429: errorSchema, 503: errorSchema } as const;
const noQueryErrors = { 429: errorSchema, 503: errorSchema } as const;
const serviceErrors = { ...errors, 404: errorSchema } as const;
// What a public number may answer beside it: over the limit per address, or a read that couldn't finish in its bounds
const readErrors = ['rate_limited', 'stats_unavailable'] as const;
// Hosts are kept lowercase, as routing writes them
const lowercase = (host: string): string => host.toLowerCase();
const iso = (time: Date | undefined): string | null => time?.toISOString() ?? null;
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
const unlistedHost = 'This host isn\'t listed';
const later = (a: Date, b: Date | undefined): Date => (b !== undefined && b.getTime() > a.getTime() ? b : a);
const earliest = (times: readonly Date[]): Date => new Date(Math.min(...times.map(time => time.getTime())));
const kindOf = (period: StatsPeriod) => (period === 'all' ? 'all' : 'recent') as 'all' | 'recent';

/** When a stored row's numbers are true: its own time, or its kind's last complete count, which left it in place. */
const verified = (countedAt: Date, period: StatsPeriod, marks: CountMarks): Date => later(countedAt, marks[kindOf(period)]);

// Every answer is no-store until it succeeds: an error, a 503 above all, is never kept by a cache
const noStore = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  reply.header('cache-control', 'no-store');
};
// The size of an answer kept in the process, as the characters of its JSON
const sizeOf = (value: unknown): number => JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? String(item) : item))?.length ?? 0;

// A read that couldn't finish, or a pool with no connection free in time, answers 503, never a number it didn't count
const bounded = async <TValue>(read: () => Promise<TValue>): Promise<TValue> => {
  try {
    return await read();
  }
  catch (error) {
    if (error instanceof StatsUnavailableError)
      throw error;
    throw new StatsUnavailableError('These numbers can\'t be read right now: try again shortly', { cause: error });
  }
};

/**
 * The public numbers, without a key, limited per client IP, readable from any origin: `GET /v1/stats`,
 * `/v1/stats/live`, `/v1/stats/top`, `/v1/services`, `/v1/services/{host}` and `/v1/endpoints/stats`.
 * Each reads what the workers' counts wrote, in one statement. A host or an endpoint they keep no row
 * for is read from its calls when asked for, bounded, and says whether its numbers are exact. The live
 * numbers add the calls since the last count, at most once per process every 10 seconds. None names a
 * Credits buyer. The services and a service's page add the paid hosts the count doesn't store and what payable
 * checks listed, read when asked for by the routed endpoints', the paid and the checked hosts' indexes, with no
 * numbers of their own. None of them, nor the top lists or an endpoint's numbers, shows a host the blocklist names
 * or names a parent domain of.
 */
export const registerStatsRoutes = (app: FastifyInstance, {
  db, config, limit, clock, readCap = askedReadCap, blocklist = createBlocklistCache({ db, clock }),
}: StatsRoutesOptions): void => {
  const store = createStatsRepository({ db });
  const counter = createStatsCounter({ db, ways: createPaidWith(config).ways });
  const payUrl = config.urls.pay;
  // The calls since the frequent count the live numbers read: about two of its intervals at most
  const tailMs = 2 * config.stats.intervalSeconds * 1_000;
  const live = createLiveCache<LiveAnswer>({
    read: async now => {
      const base = await store.live();
      // Before a first count there are no numbers to add the calls since to
      if (!base)
        throw new StatsUnavailableError('The live numbers haven\'t been counted yet: try again shortly');
      const at = new Date(Math.min(now.getTime(), base.countedAt.getTime() + tailMs));
      const tail = await counter.liveTail({ from: base.countedAt, at, minutesFrom: new Date(minuteStart(at).getTime() - 29 * minuteMs), timeoutMs: liveReadTimeoutMs });

      return buildLiveAnswer(base.answer, tail);
    },
    clock,
  });
  // What a read when asked for found, and when
  const services = createKeyedCache<{ readonly answer: ServiceAnswer | undefined; readonly at: Date }>({
    clock, ttlMs: askedCacheMs, maxBytes: askedCacheBytes / 2, maxEntryBytes: askedCacheEntryBytes, maxReading: askedReadsAtOnce, sizeOf,
  });
  const endpoints = createKeyedCache<{ readonly answer: EndpointAnswer; readonly at: Date }>({
    clock, ttlMs: askedCacheMs, maxBytes: askedCacheBytes / 2, maxEntryBytes: askedCacheEntryBytes, maxReading: askedReadsAtOnce, sizeOf,
  });
  const maxPaid = config.stats.maxServices;
  const shown = createSnapshotCache({
    clock,
    ttlMs: servicesCacheMs,
    read: async () => {
      const isBlocked = await blocklist.get();

      return createShownServices(await store.listedServices({ maxPaid, timeoutMs: publicReadTimeoutMs }), isBlocked);
    },
  });
  const listings = createKeyedCache<HostListing>({
    clock, ttlMs: listingCacheMs, maxBytes: listingCacheBytes, maxEntryBytes: listingCacheEntryBytes, maxReading: listingReadsAtOnce,
    sizeOf: listing => sizeOf({ ...listing, checkedTimes: [...listing.checkedTimes] }),
  });
  const read = { method: [...publicReadMethods], onRequest: [publicCors, noStore, limit] };

  /** A service with no page of its own: its newest calls, up to the cap, from what the page needs. Undefined: no paid call, ever. */
  const askService = async (host: string, period: StatsPeriod, now: Date): Promise<ServiceAnswer | undefined> => {
    if (!await counter.hasPaidCall({ host, timeoutMs: askedReadTimeoutMs }))
      return undefined;
    const from = periodStart(period, now);
    const before = period === 'all' ? undefined : periodBefore(period, now);
    const monthFrom = periodStart('30d', now)!;
    const scope: CallScope = { host, from: from === undefined ? undefined : earliest([from, monthFrom, before!.from]), cap: readCap };
    const periods = [{ period, from }];
    const counted = await counter.services({ scope, periods, timeoutMs: askedReadTimeoutMs });
    const listed = await counter.endpoints({ scope, periods, rankBy: period, dailyFrom: now, timeoutMs: askedReadTimeoutMs });
    const days = await counter.serviceDays({ scope, timeoutMs: askedReadTimeoutMs });
    const callsBefore = before === undefined ? undefined : await counter.callsIn({ scope, windows: [{ period, ...before }], timeoutMs: askedReadTimeoutMs });
    const page = buildServicePage({
      host, period, counts: counted.counts[0], callsBefore: callsBefore?.[0]?.calls ?? (before === undefined ? undefined : 0), daily: days, now,
    });

    return {
      ...page,
      endpoints: listed.map(endpoint => endpointListEntry({
        host, path: endpoint.path, method: endpoint.method ?? null, price: endpoint.price, numbers: endpointNumbersOf(endpoint.periods[period]), payUrl,
      })).sort((a, b) => b.calls - a.calls || (a.path < b.path ? -1 : 1)),
      exact: !counted.capped,
    };
  };

  /** An endpoint with no row of its own: its newest calls, up to the cap. */
  const askEndpoint = async (host: string, path: string, period: StatsPeriod, now: Date): Promise<EndpointAnswer> => {
    const from = periodStart(period, now);
    const dailyFrom = new Date(periodStart('today', now)!.getTime() - (endpointDailyDays - 1) * dayMs);
    const since = from === undefined ? undefined : earliest([from, dailyFrom]);
    const periods = [{ period, from }];
    const daily = lastUtcDays(now, endpointDailyDays);
    // The narrower way to its calls: the host's, or the path's on every host. A host with no call has no endpoint, nor a path with none.
    const scope = await counter.endpointScope({ host, path, from: since, cap: readCap, timeoutMs: askedReadTimeoutMs });
    if (!scope)
      return buildEndpointAnswer({ host, path, period, numbers: undefined, daily: daily.map(() => 0), dailyTo: now, exact: true });
    const capped = await counter.isCapped({ scope, timeoutMs: askedReadTimeoutMs });
    const [found] = await counter.endpoints({
      scope, periods, rankBy: period, withFree: true, dailyFrom, maxPathLength: maxEndpointReadPathLength, timeoutMs: askedReadTimeoutMs,
    });
    const days = new Map((found?.daily ?? []).map(day => [day.day, day.calls]));

    return buildEndpointAnswer({
      host, path, period, numbers: endpointNumbersOf(found?.periods[period]), daily: daily.map(day => days.get(day) ?? 0), dailyTo: now, exact: !capped,
    });
  };

  app.route({
    ...read,
    url: '/v1/stats',
    schema: {
      summary: 'The platform\'s numbers: calls, volume, buyers and services, today, over 7 and 30 days, and all time',
      tags: ['stats'],
      errors: readErrors,
      querystring: noQuerySchema,
      response: { 200: platformSchema, ...noQueryErrors },
    },
    handler: async (_request, reply) => {
      const { recent, all } = await bounded(() => store.platform());
      reply.header('cache-control', countedCache);

      return { updatedAt: iso(recent?.countedAt), allUpdatedAt: iso(all?.countedAt), ...composePlatformAnswer(recent?.answer, all?.answer, clock.now()) };
    },
  });

  app.route({
    ...read,
    url: '/v1/stats/live',
    schema: {
      summary: 'Today\'s numbers and the last 24 hours\', with the calls of the last minutes',
      tags: ['stats'],
      errors: readErrors,
      querystring: noQuerySchema,
      response: { 200: liveSchema, ...noQueryErrors },
    },
    handler: async (_request, reply) => {
      const answer = await bounded(() => live.get());
      reply.header('cache-control', liveCache);

      return answer;
    },
  });

  app.route<{ Querystring: { readonly period: StatsPeriod } }>({
    ...read,
    url: '/v1/stats/top',
    schema: {
      summary: 'The most called services and endpoints, the ways calls were paid, and the tokens of top-ups, over a period',
      tags: ['stats'],
      errors: readErrors,
      querystring: periodQuerySchema,
      response: { 200: topSchema, ...errors },
    },
    handler: async (request, reply) => {
      const { period } = request.query;
      const stored = await bounded(() => store.top(period));
      const isBlocked = await bounded(() => blocklist.get());
      reply.header('cache-control', countedCache);

      return { period, updatedAt: iso(stored?.countedAt), ...topWithoutBlocked(stored?.answer ?? emptyTopAnswer, isBlocked) };
    },
  });

  app.route<{ Querystring: { readonly q?: string; readonly sort: ServicesSort; readonly page: number; readonly size: number } }>({
    ...read,
    url: '/v1/services',
    schema: {
      summary: 'The listed services, a page at a time, with their numbers over 30 days and the totals',
      description: 'No key. Limited per address. A service is listed once a paid call reached it or a payable check found it. A paid one the count '
        + 'keeps no numbers of shows with none, the most recently registered first. The totals count what the list shows, each service once.',
      tags: ['stats'],
      errors: readErrors,
      querystring: servicesQuerySchema,
      response: { 200: servicesSchema, ...errors },
    },
    handler: async (request, reply) => {
      const { sort, page, size } = request.query;
      // An empty search is none, and a search is without case
      const q = request.query.q === '' || request.query.q === undefined ? undefined : request.query.q.toLowerCase();
      const services = await bounded(() => shown.get());
      reply.header('cache-control', servicesCache);

      return servicesPage({ services, q, sort, page, size, now: clock.now() });
    },
  });

  // `/v1/services/{host}`, the host as the rest of the path: a host may be longer than the router lets a
  // parameter be. The schema takes a host name only, so no other path reaches the handler. A paid service's
  // numbers are the count's, or a bounded read's; what checks listed of it is read now, so a newly checked
  // link shows within seconds.
  app.route<{ Params: { readonly '*': string }; Querystring: { readonly period: StatsPeriod } }>({
    ...read,
    url: '/v1/services/*',
    schema: {
      summary: 'A service\'s page: its numbers over a period, and its endpoints',
      description: 'No key. Limited per address. A host the list doesn\'t show answers 404: no paid call or payable check listed it, or the blocklist '
        + 'names it or a parent domain of it. Its endpoints are every listed one, paid first by calls, then those only a check listed, at most 100.',
      tags: ['stats'],
      errors: [...readErrors, 'not_found'],
      wildcard: 'host',
      params: serviceParamsSchema,
      querystring: periodQuerySchema,
      response: { 200: serviceSchema, ...serviceErrors },
    },
    handler: async (request, reply) => {
      const host = lowercase(request.params['*']);
      const { period } = request.query;
      const stored = await bounded(() => store.servicePage(host, period, { timeoutMs: publicReadTimeoutMs, maxPaid }));
      const numbersOf = (row: StoredEndpointRow) => (period === 'all' ? row.all : row.recent[period]);
      if (stored) {
        if (isUnlisted(stored.listing, true, true))
          throw new NotFoundError(unlisted);
        const times = [
          verified(stored.page.countedAt, period, stored.marks),
          ...stored.endpoints.map(row => verified(period === 'all' ? row.allCountedAt ?? row.countedAt : row.countedAt, period, stored.marks)),
        ];
        const ranked = stored.endpoints.flatMap(row => {
          const numbers = numbersOf(row);

          return numbers === undefined ? [] : [endpointListEntry({ host, path: row.path, method: row.method, price: row.price, numbers, payUrl })];
        });
        reply.header('cache-control', listedCache);

        return {
          ...stored.page.answer,
          ...listedPage({ host, payUrl, ranked, countedEndpoints: stored.page.answer.paidEndpoints, listing: stored.listing, status: 'paid' }),
          exact: true,
          updatedAt: earliest(times).toISOString(),
        };
      }

      const now = clock.now();
      const ask = (key: string) => bounded(() => services.get(key, async () => ({ answer: await askService(host, period, now), at: now })));
      const listingOf = (paths: readonly string[]) => bounded(() => listings.get(
        `${host} ${md5(paths.join('\n'))}`, () => store.hostListing(host, paths, { timeoutMs: publicReadTimeoutMs, maxPaid }),
      ));
      let asked = await ask(`${host} ${period}`);
      let listing = await listingOf(asked.answer?.endpoints.map(endpoint => endpoint.path) ?? []);
      // A paid call reached a checked host since it was asked: asked again, under a key of its own
      if (!asked.answer && listing.paid && !listing.blocked) {
        asked = await ask(`${host} ${period} paid`);
        if (asked.answer)
          listing = await listingOf(asked.answer.endpoints.map(endpoint => endpoint.path));
      }
      if (isUnlisted(listing, false, asked.answer !== undefined))
        throw new NotFoundError(unlisted);
      reply.header('cache-control', listedCache);
      if (asked.answer) {
        const { answer } = asked;

        return {
          ...answer, ...listedPage({ host, payUrl, ranked: answer.endpoints, countedEndpoints: answer.paidEndpoints, listing, status: 'paid' }), updatedAt: asked.at.toISOString(),
        };
      }
      // Listed by checks, or reached by a paid call not finished yet: no numbers
      const empty = buildServicePage({ host, period, counts: undefined, callsBefore: period === 'all' ? undefined : 0, daily: [], now });

      return {
        ...empty, ...listedPage({ host, payUrl, ranked: [], countedEndpoints: 0, listing, status: listing.paid ? 'paid' : 'checked' }), exact: true,
        updatedAt: now.toISOString(),
      };
    },
  });

  app.route<{ Querystring: { readonly host: string; readonly path: string; readonly period: StatsPeriod } }>({
    ...read,
    url: '/v1/endpoints/stats',
    schema: {
      summary: 'An endpoint\'s numbers over a period, and its calls of the last 14 days',
      description: 'No key. Limited per address. A host the blocklist names, or names a parent domain of, answers 404.',
      tags: ['stats'],
      errors: [...readErrors, 'not_found'],
      querystring: endpointQuerySchema,
      response: { 200: endpointSchema, ...serviceErrors },
    },
    handler: async (request, reply) => {
      const { path, period } = request.query;
      const host = lowercase(request.query.host);
      if ((await bounded(() => blocklist.get()))(host))
        throw new NotFoundError(unlistedHost);
      const stored = await bounded(() => store.endpoint(host, path, { timeoutMs: publicReadTimeoutMs }));
      const numbers = stored === undefined ? undefined : period === 'all' ? stored.row.all : stored.row.recent[period];
      if (stored && numbers) {
        const countedAt = period === 'all' ? stored.row.allCountedAt ?? stored.row.countedAt : stored.row.countedAt;
        reply.header('cache-control', countedCache);

        // Its 14 days end on the day the frequent count last found them so, written or not
        return {
          ...buildEndpointAnswer({ host, path, period, numbers, daily: stored.row.daily, dailyTo: verified(stored.row.countedAt, 'today', stored.marks), exact: true }),
          updatedAt: verified(countedAt, period, stored.marks).toISOString(),
        };
      }

      const now = clock.now();
      const asked = await bounded(() => endpoints.get(`${host} ${period} ${path}`, async () => ({ answer: await askEndpoint(host, path, period, now), at: now })));
      reply.header('cache-control', countedCache);

      return { ...asked.answer, updatedAt: asked.at.toISOString() };
    },
  });
};
