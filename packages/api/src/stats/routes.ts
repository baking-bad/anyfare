import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd, type Clock } from '@anyfare/common';
import {
  buildEndpointAnswer, buildLiveAnswer, buildServicePage, composePlatformAnswer, createPaidWith, emptyTopAnswer, endpointDailyDays, endpointListEntry,
  endpointNumbersOf, lastUtcDays, minuteStart, periodBefore, periodStart, type EndpointAnswer, type LiveAnswer, type PlatformConfig,
  type ServiceAnswer, type StatsPeriod,
} from '@anyfare/core';
import {
  createStatsCounter, createStatsRepository, type CallScope, type CountMarks, type Database, type ServicesSort, type StoredEndpointRow,
} from '@anyfare/db';

import { errorSchema } from '../calls/schemas.js';
import { NotFoundError, StatsUnavailableError } from '../errors.js';
import { publicCors, publicReadMethods } from '../public/cors.js';
import { createKeyedCache, createLiveCache } from './live.js';
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
}

// The workers count again every few minutes: a minute in a cache adds little to that
const countedCache = 'public, max-age=60';
const liveCache = 'public, max-age=10';
// A host or an endpoint with no row of its own is read when asked for: its newest calls up to this cap, each
// statement giving up after the timeout, kept in the process for a minute, a few such reads at once
export const askedReadCap = 10_000;
export const askedReadTimeoutMs = 2_000;
const askedCacheMs = 60_000;
const askedCacheEntries = 500;
const askedReadsAtOnce = 4;
// The live numbers' read of the calls since the frequent count gives up after this
const liveReadTimeoutMs = 2_000;
const dayMs = 86_400_000;
const minuteMs = 60_000;

const errors = { 400: errorSchema, 404: errorSchema, 429: errorSchema, 503: errorSchema } as const;
// Hosts are kept lowercase, as routing writes them
const lowercase = (host: string): string => host.toLowerCase();
const iso = (time: Date | undefined): string | null => time?.toISOString() ?? null;
const later = (a: Date, b: Date | undefined): Date => (b !== undefined && b.getTime() > a.getTime() ? b : a);
const earliest = (times: readonly Date[]): Date => new Date(Math.min(...times.map(time => time.getTime())));
const kindOf = (period: StatsPeriod) => (period === 'all' ? 'all' : 'recent') as 'all' | 'recent';

/** When a stored row's numbers are true: its own time, or its kind's last complete count, which left it in place. */
const verified = (countedAt: Date, period: StatsPeriod, marks: CountMarks): Date => later(countedAt, marks[kindOf(period)]);

// A bounded read that couldn't finish answers 503, never a number it didn't count
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
 * Credits buyer.
 */
export const registerStatsRoutes = (app: FastifyInstance, { db, config, limit, clock, readCap = askedReadCap }: StatsRoutesOptions): void => {
  const store = createStatsRepository({ db });
  const counter = createStatsCounter({ db, ways: createPaidWith(config).ways });
  const payUrl = config.urls.pay;
  // The calls since the frequent count the live numbers read: about two of its intervals at most
  const tailMs = 2 * config.stats.intervalSeconds * 1_000;
  const live = createLiveCache<LiveAnswer>({
    read: async now => {
      const base = await store.live();
      const at = base ? new Date(Math.min(now.getTime(), base.countedAt.getTime() + tailMs)) : now;
      const from = base?.countedAt ?? new Date(at.getTime() - tailMs);
      const tail = await counter.liveTail({ from, at, minutesFrom: new Date(minuteStart(at).getTime() - 29 * minuteMs), timeoutMs: liveReadTimeoutMs });

      return buildLiveAnswer(base?.answer, tail);
    },
    clock,
  });
  // What a read when asked for found, and when
  const services = createKeyedCache<{ readonly answer: ServiceAnswer | undefined; readonly at: Date }>({
    clock, ttlMs: askedCacheMs, maxEntries: askedCacheEntries, maxReading: askedReadsAtOnce,
  });
  const endpoints = createKeyedCache<{ readonly answer: EndpointAnswer; readonly at: Date }>({
    clock, ttlMs: askedCacheMs, maxEntries: askedCacheEntries, maxReading: askedReadsAtOnce,
  });
  const read = { method: [...publicReadMethods], onRequest: [publicCors, limit] };

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
    const scope: CallScope = { endpoint: { host, path }, from: from === undefined ? undefined : earliest([from, dailyFrom]), cap: readCap };
    const periods = [{ period, from }];
    const capped = await counter.isCapped({ scope, timeoutMs: askedReadTimeoutMs });
    const [found] = await counter.endpoints({ scope, periods, rankBy: period, withFree: true, dailyFrom, timeoutMs: askedReadTimeoutMs });
    const days = new Map((found?.daily ?? []).map(day => [day.day, day.calls]));

    return buildEndpointAnswer({
      host, path, period, numbers: endpointNumbersOf(found?.periods[period]), daily: lastUtcDays(now, endpointDailyDays).map(day => days.get(day) ?? 0),
      dailyTo: now, exact: !capped,
    });
  };

  app.route({
    ...read,
    url: '/v1/stats',
    schema: { querystring: noQuerySchema, response: { 200: platformSchema, ...errors } },
    handler: async (_request, reply) => {
      const { recent, all } = await store.platform();
      reply.header('cache-control', countedCache);

      return { updatedAt: iso(recent?.countedAt), allUpdatedAt: iso(all?.countedAt), ...composePlatformAnswer(recent?.answer, all?.answer, clock.now()) };
    },
  });

  app.route({
    ...read,
    url: '/v1/stats/live',
    schema: { querystring: noQuerySchema, response: { 200: liveSchema, ...errors } },
    handler: async (_request, reply) => {
      const answer = await live.get();
      reply.header('cache-control', liveCache);

      return answer;
    },
  });

  app.route<{ Querystring: { readonly period: StatsPeriod } }>({
    ...read,
    url: '/v1/stats/top',
    schema: { querystring: periodQuerySchema, response: { 200: topSchema, ...errors } },
    handler: async (request, reply) => {
      const { period } = request.query;
      const stored = await store.top(period);
      reply.header('cache-control', countedCache);

      return { period, updatedAt: iso(stored?.countedAt), ...stored?.answer ?? emptyTopAnswer };
    },
  });

  app.route<{ Querystring: { readonly q?: string; readonly sort: ServicesSort; readonly page: number; readonly size: number } }>({
    ...read,
    url: '/v1/services',
    schema: { querystring: servicesQuerySchema, response: { 200: servicesSchema, ...errors } },
    handler: async (request, reply) => {
      const { sort, page, size } = request.query;
      // An empty search is none
      const q = request.query.q === '' ? undefined : request.query.q;
      const found = await store.services({ ...q === undefined ? {} : { q }, sort, offset: (page - 1) * size, limit: size });
      const totals = found.totals?.answer ?? { services: 0, paidEndpoints: 0, calls30d: 0 };
      // The oldest time of what the page shows
      const times = [...found.totals ? [found.totals.countedAt] : [], ...found.rows.map(row => verified(row.countedAt, '30d', found.marks))];
      reply.header('cache-control', countedCache);

      return {
        services: found.rows.map(row => ({
          host: row.host,
          paidEndpoints: row.paidEndpoints,
          priceFrom: row.priceFrom === undefined ? null : formatUsd(row.priceFrom),
          currency: 'USD',
          calls: row.calls,
          buyers: row.buyers,
          volume: formatUsd(row.volume),
          successRate: row.successRate,
          p50Ms: row.p50Ms,
          trend: row.trend,
        })),
        page,
        size,
        total: found.total,
        totalCapped: totals.services > found.stored,
        totals,
        updatedAt: times.length === 0 ? null : earliest(times).toISOString(),
      };
    },
  });

  // `/v1/services/{host}`, the host as the rest of the path: a host may be longer than the router lets a
  // parameter be. The schema takes a host name only, so no other path reaches the handler.
  app.route<{ Params: { readonly '*': string }; Querystring: { readonly period: StatsPeriod } }>({
    ...read,
    url: '/v1/services/*',
    schema: { params: serviceParamsSchema, querystring: periodQuerySchema, response: { 200: serviceSchema, ...errors } },
    handler: async (request, reply) => {
      const host = lowercase(request.params['*']);
      const { period } = request.query;
      const stored = await store.servicePage(host, period);
      const numbersOf = (row: StoredEndpointRow) => (period === 'all' ? row.all : row.recent[period]);
      if (stored) {
        const times = [
          verified(stored.page.countedAt, period, stored.marks),
          ...stored.endpoints.map(row => verified(period === 'all' ? row.allCountedAt ?? row.countedAt : row.countedAt, period, stored.marks)),
        ];
        reply.header('cache-control', countedCache);

        return {
          ...stored.page.answer,
          endpoints: stored.endpoints.flatMap(row => {
            const numbers = numbersOf(row);

            return numbers === undefined ? [] : [endpointListEntry({ host, path: row.path, method: row.method, price: row.price, numbers, payUrl })];
          }),
          exact: true,
          updatedAt: earliest(times).toISOString(),
        };
      }

      const now = clock.now();
      const asked = await bounded(() => services.get(`${host} ${period}`, async () => ({ answer: await askService(host, period, now), at: now })));
      if (!asked.answer)
        throw new NotFoundError('No paid call has reached this host');
      reply.header('cache-control', countedCache);

      return { ...asked.answer, updatedAt: asked.at.toISOString() };
    },
  });

  app.route<{ Querystring: { readonly host: string; readonly path: string; readonly period: StatsPeriod } }>({
    ...read,
    url: '/v1/endpoints/stats',
    schema: { querystring: endpointQuerySchema, response: { 200: endpointSchema, ...errors } },
    handler: async (request, reply) => {
      const { path, period } = request.query;
      const host = lowercase(request.query.host);
      const stored = await store.endpoint(host, path);
      const numbers = stored === undefined ? undefined : period === 'all' ? stored.row.all : stored.row.recent[period];
      reply.header('cache-control', countedCache);
      if (stored && numbers) {
        const countedAt = period === 'all' ? stored.row.allCountedAt ?? stored.row.countedAt : stored.row.countedAt;

        return {
          ...buildEndpointAnswer({ host, path, period, numbers, daily: stored.row.daily, dailyTo: stored.row.countedAt, exact: true }),
          updatedAt: verified(countedAt, period, stored.marks).toISOString(),
        };
      }

      const now = clock.now();
      const asked = await bounded(() => endpoints.get(`${host} ${period} ${path}`, async () => ({ answer: await askEndpoint(host, path, period, now), at: now })));

      return { ...asked.answer, updatedAt: asked.at.toISOString() };
    },
  });
};
