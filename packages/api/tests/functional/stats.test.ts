import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@anyfare/common';
import {
  buildEndpointAnswer, buildServicePage, endpointNumbersOf, hashApiKey, loadPlatformConfig, type LiveBase, type PaymentStatus, type PlatformConfig, type ServiceRow,
  type StoredEndpoint,
} from '@anyfare/core';
import { callDetails, createAccountRepository, createPaymentKeyRepository, createPostgres, createStatsRepository, payments } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, type FakeClock, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';

// The public numbers through the real app: what the counts stored, read in one statement each; a host or
// an endpoint with no row of its own, read from its calls when asked for, bounded; and the live numbers,
// the frequent count's base and the calls since.

const generous = { requests: 100_000, windowSeconds: 60 };
const noon = '2026-12-15T12:00:00.000Z';
const accountId = 'acc_stats_api_4f1c';
const keyId = 'key_stats_api_9d2e';
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
const ways = {
  credits: { rail: 'credits', network: null },
  base: { rail: 'x402', network: 'eip155:84532' },
  near: { rail: 'x402', network: 'near:testnet' },
} as const;

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let clock: FakeClock;
let url: string;
const servers: ApiServer[] = [];
const redises: TestRedis[] = [];
let counter = 0;

const start = async (platform: PlatformConfig, options: { readonly redis?: TestRedis; readonly statsReadCap?: number } = {}): Promise<string> => {
  const server = createApp({
    config: platform, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis: options.redis ?? redis, clock,
    ...options.statsReadCap === undefined ? {} : { statsReadCap: options.statsReadCap },
  });
  servers.push(server);
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return `http://127.0.0.1:${port}`;
};

interface SeededCall {
  readonly at: string;
  readonly host: string;
  readonly path: string;
  readonly way: keyof typeof ways;
  readonly status: PaymentStatus;
  readonly amount?: bigint;
  readonly ms?: number;
  readonly payer?: string;
  // Columns no answer may show
  readonly requestId?: string;
  readonly receipt?: string;
  readonly settlementRequest?: Record<string, string>;
}

/** Finished calls as the proxy and the rails write them, with their details. */
const seed = async (...calls: readonly SeededCall[]): Promise<void> => {
  const rows = calls.map(call => {
    counter += 1;
    const credits = ways[call.way].rail === 'credits';

    return { call, id: `pay_stats_api_${counter}`, credits, at: new Date(call.at) };
  });
  for (let index = 0; index < rows.length; index += 500) {
    const batch = rows.slice(index, index + 500);
    await database.db.insert(payments).values(batch.map(({ call, id, credits, at }) => ({
      id, requestId: call.requestId ?? `req-${id}`, rail: ways[call.way].rail, buyerAccountId: credits ? accountId : null, keyId: credits ? keyId : null,
      targetHost: call.host, targetPath: call.path, network: ways[call.way].network, asset: credits ? null : 'base-usdc', atomicAmount: credits ? null : call.amount ?? 10_000n,
      amount: call.amount ?? 10_000n, fee: null, upstreamStatus: call.ms === undefined ? null : 200, upstreamLatencyMs: call.ms ?? null, status: call.status,
      transactionHash: null, receipt: call.receipt ?? null, settlementRequest: call.settlementRequest ?? null, needsReview: false, createdAt: at, updatedAt: at,
    })));
    await database.db.insert(callDetails).values(batch.map(({ call, id, credits, at }) => ({ paymentId: id, method: 'GET', payer: credits ? null : call.payer ?? null, arrivedAt: at })));
  }
};

const get = async (path: string, init: RequestInit = {}, at = url) => {
  const response = await fetch(`${at}${path}`, init);
  const text = await response.text();

  return { status: response.status, headers: response.headers, text, body: text === '' ? undefined : JSON.parse(text) as Record<string, unknown> };
};

const errorCode = (answer: Awaited<ReturnType<typeof get>>): unknown => (answer.body?.['error'] as { code?: unknown } | undefined)?.code;

// The last `count` UTC days to 2026-12-15, oldest first
const daysTo15 = (days: number): string[] => Array.from({ length: days }, (_, index) => new Date(Date.parse('2026-12-15T00:00:00.000Z') - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10));

const everyPath = ['/v1/stats', '/v1/stats/live', '/v1/stats/top', '/v1/services', '/v1/services/asked.example.com', '/v1/endpoints/stats?host=one.example.com&path=/v1/one'];

const store = () => createStatsRepository({ db: database.db });

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  const loaded = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
  config = { ...loaded, rateLimits: { ...loaded.rateLimits, publicReads: generous, documents: generous } };
  clock = createFakeClock(noon);
  url = await start(config);
  await createAccountRepository({ db: database.db }).create({ id: accountId, createdAt: new Date(noon) });
  await createPaymentKeyRepository({ db: database.db }).insert({
    id: keyId, accountId, keyHash: hashApiKey(Secret.from(`af_test_${keyId}`)), label: undefined, createdAt: new Date(noon), allowance: undefined,
    dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await Promise.all([database?.drop(), redis?.cleanup(), ...redises.map(each => each.cleanup())]);
});

describe('the public numbers before any count', () => {
  it('answer 200 with zeros, empty lists and zero-filled days, and no time; a host with no paid call answers 404, and the live numbers 503', async () => {
    const zeros = { today: 0, '7d': 0, '30d': 0, all: 0 };

    expect((await get('/v1/stats')).body).toEqual({
      updatedAt: null, allUpdatedAt: null, calls: zeros, volume: { today: '0', '7d': '0', '30d': '0', all: '0', currency: 'USD' }, buyers: zeros, services: zeros,
      byPaidWith: { today: [], '7d': [], '30d': [], all: [] }, topups: { '30d': { count: 0, usd: '0' }, all: { count: 0, usd: '0' } },
      daily: daysTo15(30).map(day => ({ day, calls: 0, volume: '0' })),
    });
    expect((await get('/v1/stats/top')).body).toEqual({ period: '30d', updatedAt: null, services: [], endpoints: [], paidWith: [], topupTokens: [] });
    expect((await get('/v1/services')).body).toEqual({
      services: [], page: 1, size: 20, total: 0, totalCapped: false, totals: { services: 0, paidServices: 0, paidEndpoints: 0, calls30d: 0 }, updatedAt: null,
    });
    expect((await get('/v1/endpoints/stats?host=one.example.com&path=/v1/one&period=7d')).body).toEqual({
      host: 'one.example.com', path: '/v1/one', period: '7d', updatedAt: noon, stats: { calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null },
      daily: daysTo15(14).map(day => ({ day, calls: 0 })), byPaidWith: [], exact: true,
    });
    expect(await get('/v1/services/one.example.com')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    // No count yet: no base to add the last minutes to, so no number at all, and nothing to keep
    const live = await get('/v1/stats/live');
    expect(live).toMatchObject({ status: 503, body: { error: { code: 'stats_unavailable' } } });
    expect(live.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the stored public numbers', () => {
  const row = (host: string, changes: Partial<ServiceRow>): ServiceRow => ({
    hostHash: md5(host), host, paidEndpoints: 1, priceFrom: undefined, calls: 1, buyers: 1, volume: 1_000n, successRate: 1, p50Ms: 100, trend: [], ...changes,
  });
  const marked = new Date('2026-12-15T11:55:00.000Z');
  const counted = new Date('2026-12-15T11:00:00.000Z');

  beforeAll(async () => {
    // A server of its own: the list read before any count is kept in the other's process for a few seconds
    url = await start(config);
    const stats = store();
    // Written by an earlier count, and vouched for by the last complete one
    await stats.putServices({
      rows: [
        row('one.example.com', { calls: 4, buyers: 1, volume: 40_000n, paidEndpoints: 1, priceFrom: 10_000n }),
        row('three.example.org', { calls: 3, buyers: 1, volume: 150_000n, paidEndpoints: 3, priceFrom: 50_000n }),
        row('two.example.com', { calls: 2, buyers: 2, volume: 10_000n, paidEndpoints: 1, priceFrom: 5_000n }),
        row('four.example.net', { calls: 1, buyers: 1, volume: 1_000n, paidEndpoints: 1 }),
      ],
      countedAt: counted,
      timeoutMs: 5_000,
    });
    await stats.putAnswers({ answers: [{ key: 'services', answer: { services: 5, paidEndpoints: 7, calls30d: 11 } }], countedAt: marked, timeoutMs: 5_000 });
    await stats.markComplete({ kind: 'recent', countedAt: marked, timeoutMs: 5_000 });
    const now = new Date(noon);
    await stats.putServicePages({
      pages: [{
        hostHash: md5('one.example.com'),
        period: 'today',
        answer: buildServicePage({
          host: 'one.example.com', period: 'today', callsBefore: 0, daily: [{ day: '2026-12-15', calls: 4, volume: 40_000n, buyers: 1 }], now,
          counts: {
            calls: 4, volume: 40_000n, buyers: 1, free: 0, p50Ms: 250, p95Ms: 385, paidEndpoints: 2, ways: [{ paidWith: 'credits', calls: 4, volume: 40_000n, buyers: 1 }],
            knownBuyers: 1, returning: 0, topBuyers: [{ payer: undefined, paidWith: 'credits', calls: 4, spent: 40_000n, lastCallAt: new Date('2026-12-15T09:03:00.000Z') }],
          },
        }),
      }],
      countedAt: counted,
      timeoutMs: 5_000,
    });
    const numbers = (calls: number) => endpointNumbersOf({ calls, volume: BigInt(calls) * 10_000n, buyers: 1, free: 0, p50Ms: 100, p95Ms: 100, ways: [{ paidWith: 'credits', calls }] });
    const endpoint = (path: string, calls: number): StoredEndpoint => ({
      hostHash: md5('one.example.com'), pathHash: md5(path), path, method: 'GET', price: 10_000n,
      recent: { today: numbers(calls), '7d': numbers(calls), '30d': numbers(calls) }, daily: [...Array.from({ length: 13 }, () => 0), calls],
    });
    await stats.putEndpoints({ hostHashes: [md5('one.example.com')], endpoints: [endpoint('/v1/two', 1), endpoint('/v1/one', 3)], countedAt: counted, timeoutMs: 5_000 });
  });

  it('list the stored services, sorted by calls, buyers, volume, endpoints and price, cheapest first, searched by a part of the host, in pages', async () => {
    const hosts = async (query: string) => {
      const answer = await get(`/v1/services${query}`);

      return { hosts: (answer.body?.['services'] as { host: string }[]).map(service => service.host), total: answer.body?.['total'] };
    };

    const answer = await get('/v1/services');
    // A newly checked host shows within a minute: 5 s in the process, 55 in a cache in front
    expect(answer.headers.get('cache-control')).toBe('public, max-age=55');
    // Five services had a paid call in 30 days and four are kept: a search may miss one
    expect(answer.body).toMatchObject({
      page: 1, size: 20, total: 4, totalCapped: true, totals: { services: 5, paidServices: 5, paidEndpoints: 7, calls30d: 11 }, updatedAt: marked.toISOString(),
    });
    expect((answer.body?.['services'] as unknown[])[0]).toEqual({
      host: 'one.example.com', status: 'paid', paidEndpoints: 1, priceFrom: '0.01', currency: 'USD', calls: 4, buyers: 1, volume: '0.04', successRate: 1, p50Ms: 100,
      trend: [], listedAt: null, checkedAt: null,
    });
    expect((await hosts('')).hosts).toEqual(['one.example.com', 'three.example.org', 'two.example.com', 'four.example.net']);
    expect((await hosts('?sort=buyers')).hosts).toEqual(['two.example.com', 'four.example.net', 'one.example.com', 'three.example.org']);
    expect((await hosts('?sort=volume')).hosts).toEqual(['three.example.org', 'one.example.com', 'two.example.com', 'four.example.net']);
    expect((await hosts('?sort=endpoints')).hosts).toEqual(['three.example.org', 'four.example.net', 'one.example.com', 'two.example.com']);
    // No quote: last
    expect((await hosts('?sort=price')).hosts).toEqual(['two.example.com', 'one.example.com', 'three.example.org', 'four.example.net']);
    expect(await hosts('?q=EXAMPLE.COM')).toEqual({ hosts: ['one.example.com', 'two.example.com'], total: 2 });
    // LIKE's own characters match themselves
    expect(await hosts('?q=%25')).toEqual({ hosts: [], total: 0 });
    expect((await hosts('?q=')).hosts).toHaveLength(4);
    expect(await hosts('?size=2&page=2')).toEqual({ hosts: ['two.example.com', 'four.example.net'], total: 4 });
    expect(await hosts('?size=2&page=3')).toEqual({ hosts: [], total: 4 });
    for (const query of ['?sort=name', '?size=0', '?size=101', '?page=0', `?q=${'a'.repeat(101)}`, '?q=a%00b'])
      expect(errorCode(await get(`/v1/services${query}`)), query).toBe('invalid_request');
  });

  it('answer a stored service\'s page with its stored endpoints by the period\'s calls, links made at the time, any case of the host', async () => {
    const answer = await get('/v1/services/ONE.Example.com?period=today');

    // What checks list of it shows within seconds
    expect(answer.headers.get('cache-control')).toBe('public, max-age=3');
    expect(answer.body).toEqual({
      host: 'one.example.com', period: 'today', paidEndpoints: 2, exact: true, status: 'paid', listedAt: null, checkedAt: null,
      // Its rows were written at 11:00 and vouched for by the count completed at 11:55
      updatedAt: marked.toISOString(),
      stats: { calls: 4, callsBefore: 0, volume: '0.04', buyers: 1, returningShare: 0, successRate: 1, failedCalls: 0, p50Ms: 250, p95Ms: 385 },
      endpoints: [
        {
          path: '/v1/one', method: 'GET', priceNow: '0.01', calls: 3, buyers: 1, volume: '0.03', successRate: 1, p50Ms: 100, link: 'https://pay.anyfare.test/one.example.com/v1/one',
          status: 'paid', checkedAt: null,
        },
        {
          path: '/v1/two', method: 'GET', priceNow: '0.01', calls: 1, buyers: 1, volume: '0.01', successRate: 1, p50Ms: 100, link: 'https://pay.anyfare.test/one.example.com/v1/two',
          status: 'paid', checkedAt: null,
        },
      ],
      daily: daysTo15(30).map(day => (day === '2026-12-15' ? { day, calls: 4, volume: '0.04', buyers: 1 } : { day, calls: 0, volume: '0', buyers: 0 })),
      byPaidWith: [{ paidWith: 'credits', calls: 4, share: 1, buyers: 1, volume: '0.04' }],
      topBuyers: { share: 1, buyers: [{ payer: null, paidWith: 'credits', calls: 4, spent: '0.04', lastCallAt: '2026-12-15T09:03:00.000Z' }] },
    });
  });

  it('label a stored endpoint\'s 14 days from when the last complete count found them so, not when they were last written', async () => {
    const numbers = endpointNumbersOf({ calls: 2, volume: 20_000n, buyers: 1, free: 0, p50Ms: 100, p95Ms: 100, ways: [{ paidWith: 'credits', calls: 2 }] });
    // Written the day before, left in place by the count completed at 11:55 today: today is its last day
    await store().putEndpoints({
      hostHashes: [md5('labels.example.com')], countedAt: new Date('2026-12-14T23:00:00.000Z'), timeoutMs: 5_000,
      endpoints: [{
        hostHash: md5('labels.example.com'), pathHash: md5('/v1/x'), path: '/v1/x', method: 'GET', price: undefined,
        recent: { today: numbers, '7d': numbers, '30d': numbers }, daily: [...Array.from({ length: 13 }, () => 0), 2],
      }],
    });

    const answer = await get('/v1/endpoints/stats?host=labels.example.com&path=/v1/x&period=7d');

    expect((answer.body?.['daily'] as { day: string; calls: number }[]).at(-1)).toEqual({ day: '2026-12-15', calls: 2 });
    expect(answer.body?.['updatedAt']).toBe(marked.toISOString());
  });

  it('answer a stored endpoint from its row, its 14 days to its count\'s day', async () => {
    const answer = await get('/v1/endpoints/stats?host=One.Example.com&path=/v1/one&period=today');

    expect(answer.body).toEqual({
      ...buildEndpointAnswer({
        host: 'one.example.com', path: '/v1/one', period: 'today', exact: true, dailyTo: counted, daily: [...Array.from({ length: 13 }, () => 0), 3],
        numbers: endpointNumbersOf({ calls: 3, volume: 30_000n, buyers: 1, free: 0, p50Ms: 100, p95Ms: 100, ways: [{ paidWith: 'credits', calls: 3 }] }),
      }),
      updatedAt: marked.toISOString(),
    });
  });
});

describe('the public numbers of a host or an endpoint with no row, read when asked for', () => {
  beforeAll(async () => {
    await seed(
      ...[100, 200, 300, 400].map((ms, index) => ({
        host: 'asked.example.com', path: '/v1/a', at: `2026-12-15T09:0${index}:00.000Z`, way: 'credits' as const, status: 'captured' as const, ms,
        requestId: `${accountId} ${keyId}`, receipt: `account="${accountId}", key="${keyId}"`,
      })),
      {
        host: 'asked.example.com', path: '/v1/b', at: '2026-12-15T10:00:00.000Z', way: 'base', status: 'settled', ms: 150, payer: '0x7777777777777777777777777777777777777777',
        requestId: 'secret-in-header', receipt: 'token=secret-in-query secret-in-body',
        settlementRequest: { resource: 'https://asked.example.com/v1/b?token=secret-in-query', body: 'secret-in-body', header: 'secret-in-header' },
      },
      { host: 'asked.example.com', path: '/v1/b', at: '2026-12-14T10:00:00.000Z', way: 'near', status: 'settled', ms: 250, payer: 'scout.testnet' },
      // Every call failed
      { host: 'asked.example.com', path: '/v1/broken', at: '2026-12-15T10:30:00.000Z', way: 'base', status: 'failed', ms: 50, payer: '0x1111111111111111111111111111111111111111' },
      { host: 'free.example.com', path: '/x', at: '2026-12-15T11:30:00.000Z', way: 'base', status: 'failed', ms: 50, payer: '0x1111111111111111111111111111111111111111' },
    );
  });

  it('count a service from its calls, exactly when they fit the cap', async () => {
    const answer = await get('/v1/services/asked.example.com?period=7d');

    expect(answer.body).toMatchObject({
      host: 'asked.example.com', period: '7d', paidEndpoints: 2, exact: true, updatedAt: noon,
      stats: { calls: 6, callsBefore: 0, volume: '0.06', buyers: 3, returningShare: 0, successRate: 0.8571, failedCalls: 1, p50Ms: 200 },
      byPaidWith: [{ paidWith: 'credits', calls: 4 }, { paidWith: 'base', calls: 1 }, { paidWith: 'near', calls: 1 }],
    });
    expect((answer.body?.['endpoints'] as { path: string; calls: number }[]).map(endpoint => [endpoint.path, endpoint.calls])).toEqual([['/v1/a', 4], ['/v1/b', 2]]);
    expect((await get('/v1/services/asked.example.com?period=all')).body).toMatchObject({ stats: { calls: 6, callsBefore: null } });
    // Free calls only, or none: no service
    for (const host of ['free.example.com', 'nothing.example.com'])
      expect(await get(`/v1/services/${host}`), host).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });

  it('count an endpoint from its calls, one every call of which failed at a success rate of 0', async () => {
    expect((await get('/v1/endpoints/stats?host=asked.example.com&path=/v1/b&period=7d')).body).toMatchObject({
      stats: { calls: 2, buyers: 2, volume: '0.02', successRate: 1, p50Ms: 200 }, byPaidWith: [{ paidWith: 'base', calls: 1 }, { paidWith: 'near', calls: 1 }], exact: true,
    });
    expect((await get('/v1/endpoints/stats?host=asked.example.com&path=/v1/broken&period=today')).body).toMatchObject({
      stats: { calls: 0, buyers: 0, volume: '0', successRate: 0, p50Ms: 50 }, exact: true,
    });
  });

  it('say the numbers aren\'t exact past the cap: they cover the newest calls only', async () => {
    const capped = await start(config, { statsReadCap: 3 });

    // The newest 3 finished calls: the failed one, and two paid
    expect((await get('/v1/services/asked.example.com?period=7d', {}, capped)).body).toMatchObject({ exact: false, stats: { calls: 2, failedCalls: 1 } });
    expect((await get('/v1/endpoints/stats?host=asked.example.com&path=/v1/a&period=7d', {}, capped)).body).toMatchObject({ exact: false, stats: { calls: 3 } });
  });

  it('keep what it read for a minute in the process', async () => {
    const fresh = await start(config);
    const read = async () => ((await get('/v1/services/cached.example.com?period=today', {}, fresh)).body?.['stats'] as { calls: number } | undefined)?.calls;
    await seed({ host: 'cached.example.com', path: '/v1/x', at: '2026-12-15T11:00:00.000Z', way: 'base', status: 'settled', ms: 10, payer: '0x1111111111111111111111111111111111111111' });

    expect(await read()).toBe(1);
    await seed({ host: 'cached.example.com', path: '/v1/x', at: '2026-12-15T11:01:00.000Z', way: 'base', status: 'settled', ms: 10, payer: '0x1111111111111111111111111111111111111111' });
    clock.set('2026-12-15T12:00:59.000Z');
    expect(await read()).toBe(1);
    clock.set('2026-12-15T12:01:00.000Z');
    expect(await read()).toBe(2);
    clock.set(noon);
  });

  it('answers 503 stats_unavailable when a read can\'t finish within its timeout, never a number it didn\'t count', async () => {
    const blocker = new pg.Client({ connectionString: database.url.expose() });
    await blocker.connect();
    try {
      await blocker.query('begin');
      await blocker.query('lock table payments in access exclusive mode');

      for (const path of ['/v1/services/blocked.example.com', '/v1/endpoints/stats?host=blocked.example.com&path=/v1/x']) {
        const answer = await get(path);
        expect(answer, path).toMatchObject({ status: 503, body: { error: { code: 'stats_unavailable' } } });
        // Never kept by a cache
        expect(answer.headers.get('cache-control'), path).toBe('no-store');
      }
    }
    finally {
      await blocker.query('rollback');
      await blocker.end();
    }
  });

  it('never shows a Credits buyer\'s account ID, key ID or their md5, nor a routed call\'s query string, body or headers', async () => {
    for (const path of ['/v1/services/asked.example.com', '/v1/services/asked.example.com?period=all', '/v1/endpoints/stats?host=asked.example.com&path=/v1/a', '/v1/endpoints/stats?host=asked.example.com&path=/v1/b']) {
      const answer = await get(path);
      expect(answer.status, path).toBe(200);
      // The account's md5, and the form the kept buyers hold
      for (const secret of [accountId, keyId, md5(accountId), md5(keyId), md5(`account:${md5(accountId)}`), 'secret-in-query', 'secret-in-body', 'secret-in-header', 'token='])
        expect(answer.text, `${path} ${secret}`).not.toContain(secret);
    }
    const service = (await get('/v1/services/asked.example.com')).body as { topBuyers: { buyers: { payer: unknown; paidWith: string }[] } };
    expect(service.topBuyers.buyers.find(buyer => buyer.paidWith === 'credits')?.payer).toBeNull();
  });
});

describe('the public numbers\' queries', () => {
  it('take a host name, any case and with a port, and a path only: never a query string or a NUL', async () => {
    const longest = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}:65535`;

    for (const host of ['localhost', 'not a host', 'a..example.com', '-a.example.com', 'a.example.com:123456', 'a.example.com/x', `${longest}5`, '127.0.0.1', 'a\u0000.example.com']) {
      expect(errorCode(await get(`/v1/services/${encodeURIComponent(host)}`)), host).toBe('invalid_request');
      expect(errorCode(await get(`/v1/endpoints/stats?host=${encodeURIComponent(host)}&path=/v1/one`)), host).toBe('invalid_request');
    }
    // The route itself answers, not the router: no paid call reached it
    expect(await get(`/v1/services/${longest}`)).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'No paid call or payable check has listed this host' } } });
    expect(errorCode(await get('/v1/services/'))).toBe('invalid_request');
    expect((await get(`/v1/endpoints/stats?host=${longest}&path=/v1/one`)).status).toBe(200);
    for (const query of [
      'host=one.example.com&path=%2Fv1%2Fone%3Ftoken%3D1', 'host=one.example.com&path=v1/one', 'host=one.example.com', 'path=/v1/one',
      `host=one.example.com&path=/${'a'.repeat(2_048)}`, 'host=one.example.com&path=/v1/a%00b',
    ])
      expect(errorCode(await get(`/v1/endpoints/stats?${query}`)), query).toBe('invalid_request');
    expect(errorCode(await get('/v1/stats/top?period=90d'))).toBe('invalid_request');
  });

  it('take no NUL in the calls\' filters either', async () => {
    for (const query of ['service=a%00b', 'host=a%00b', 'endpoint=/a%00b']) {
      expect(errorCode(await get(`/v1/calls?${query}`)), query).toBe('invalid_request');
      expect(errorCode(await get(`/v1/calls/stream?${query}`)), query).toBe('invalid_request');
    }
  });
});

describe('GET /v1/stats/live', () => {
  const at = '2027-01-20T12:00:30.000Z';
  const ago = (ms: number): string => new Date(Date.parse(at) - ms).toISOString();
  const minute = 60_000;
  const hour = 60 * minute;

  it('adds the calls since the frequent count to its base, counts today\'s buyers once, and reads the last 30 minutes, cached for 10 seconds', async () => {
    const fresh = await start(config);
    clock.set(at);
    const countedAt = new Date(Date.parse(at) - 2 * minute);
    // The base: today's calls to the count, and its minutes over 48 hours
    const base: LiveBase = {
      day: '2027-01-20', today: { calls: 5, volume: '50000', nearCalls: 1, buyers: 2 }, buyersKept: 2,
      minutes: [[Date.parse(ago(13 * hour)) - Date.parse(ago(13 * hour)) % minute, 3, '30000'], [Date.parse(ago(30 * hour)) - Date.parse(ago(30 * hour)) % minute, 1, '7000']],
    };
    await store().putAnswers({ answers: [{ key: 'live', answer: base }], countedAt, timeoutMs: 5_000 });
    await database.db.execute(`insert into stats_buyers (day, buyer_hash) values ('2027-01-20', md5('payer:live.testnet')), ('2027-01-20', md5('payer:other.testnet'))` as never);
    // After the count: a returning buyer on NEAR, a new one, and a free call
    await seed(
      { host: 'live.example.com', path: '/v1/live', at: ago(30_000), way: 'near', status: 'settled', amount: 10_000n, ms: 100, payer: 'live.testnet' },
      { host: 'live.example.com', path: '/v1/live', at: ago(60_000), way: 'base', status: 'settled', amount: 20_000n, ms: 100, payer: '0x2222222222222222222222222222222222222222' },
      { host: 'live.example.com', path: '/v1/live', at: ago(70_000), way: 'base', status: 'failed', amount: 10_000n, ms: 100, payer: '0x2222222222222222222222222222222222222222' },
      // Before the count, so in its base already: never counted twice
      { host: 'live.example.com', path: '/v1/live', at: ago(3 * minute), way: 'base', status: 'settled', amount: 10_000n, ms: 100, payer: '0x2222222222222222222222222222222222222222' },
    );

    const answer = await get('/v1/stats/live', {}, fresh);

    expect(answer.headers.get('cache-control')).toBe('public, max-age=10');
    expect(answer.body).toMatchObject({
      at,
      today: { calls: 7, volume: '0.08', buyers: 3, nearShare: 0.2857 },
      last24h: { calls: 5, volume: '0.06', volumeBefore: '0.007' },
    });
    const perMinute = answer.body?.['perMinute'] as { minute: string; calls: number }[];
    expect(perMinute).toHaveLength(30);
    expect(perMinute.filter(entry => entry.calls > 0)).toEqual([
      { minute: '2027-01-20T11:57:00.000Z', calls: 1 }, { minute: '2027-01-20T11:59:00.000Z', calls: 1 }, { minute: '2027-01-20T12:00:00.000Z', calls: 1 },
    ]);

    // A burst of readers within 10 seconds costs one read: a new call shows only after
    await seed({ host: 'live.example.com', path: '/v1/live', at: ago(1_000), way: 'near', status: 'settled', amount: 10_000n, ms: 100, payer: 'live.testnet' });
    clock.set(new Date(Date.parse(at) + 9_000));
    const burst = await Promise.all(Array.from({ length: 5 }, () => get('/v1/stats/live', {}, fresh)));
    expect(burst.map(each => (each.body?.['today'] as { calls: number }).calls)).toEqual([7, 7, 7, 7, 7]);
    clock.set(new Date(Date.parse(at) + 10_000));
    expect((await get('/v1/stats/live', {}, fresh)).body).toMatchObject({ at: '2027-01-20T12:00:40.000Z', today: { calls: 8, buyers: 3 } });
  });

  it('reads no more than two intervals after a late count: its numbers are as of then, and say so', async () => {
    const fresh = await start(config);
    clock.set('2027-02-10T12:00:00.000Z');
    const countedAt = new Date('2027-02-10T11:00:00.000Z');
    await store().putAnswers({ answers: [{ key: 'live', answer: { day: '2027-02-10', today: { calls: 1, volume: '1000', nearCalls: 0, buyers: 1 }, buyersKept: 1, minutes: [] } }], countedAt, timeoutMs: 5_000 });
    await seed(
      { host: 'late.example.com', path: '/v1/x', at: '2027-02-10T11:05:00.000Z', way: 'base', status: 'settled', amount: 1_000n, ms: 10, payer: '0x2222222222222222222222222222222222222222' },
      // Past the 10 minutes after the count the read may cover
      { host: 'late.example.com', path: '/v1/x', at: '2027-02-10T11:30:00.000Z', way: 'base', status: 'settled', amount: 1_000n, ms: 10, payer: '0x2222222222222222222222222222222222222222' },
    );

    expect((await get('/v1/stats/live', {}, fresh)).body).toMatchObject({ at: '2027-02-10T11:10:00.000Z', today: { calls: 2 }, last24h: { calls: 1 } });
  });

  it('serves its last good numbers, with their own time, while a read fails, and tries again only after a pause', async () => {
    const fresh = await start(config);
    clock.set('2027-03-01T12:00:00.000Z');
    await store().putAnswers({ answers: [{ key: 'live', answer: { day: '2027-03-01', today: { calls: 0, volume: '0', nearCalls: 0, buyers: 0 }, buyersKept: 0, minutes: [] } }], countedAt: new Date('2027-03-01T11:59:00.000Z'), timeoutMs: 5_000 });
    const first = await get('/v1/stats/live', {}, fresh);
    const blocker = new pg.Client({ connectionString: database.url.expose() });
    await blocker.connect();
    try {
      await blocker.query('begin');
      await blocker.query('lock table payments in access exclusive mode');
      clock.set('2027-03-01T12:00:11.000Z');
      const started = performance.now();
      const during = await get('/v1/stats/live', {}, fresh);
      const tookMs = performance.now() - started;
      // Within the pause: the last good value at once, no other read
      clock.set('2027-03-01T12:00:14.000Z');
      const quick = performance.now();
      const again = await get('/v1/stats/live', {}, fresh);

      expect([during.status, during.body?.['at'], again.status, again.body?.['at']]).toEqual([200, first.body?.['at'], 200, first.body?.['at']]);
      expect(tookMs).toBeGreaterThan(1_000);
      expect(performance.now() - quick).toBeLessThan(500);
    }
    finally {
      await blocker.query('rollback');
      await blocker.end();
    }
    clock.set('2027-03-01T12:00:20.000Z');
    expect((await get('/v1/stats/live', {}, fresh)).body).toMatchObject({ at: '2027-03-01T12:00:20.000Z' });
  });

  it('answers 503 stats_unavailable only with no numbers at all', async () => {
    const fresh = await start(config);
    const blocker = new pg.Client({ connectionString: database.url.expose() });
    await blocker.connect();
    try {
      await blocker.query('begin');
      await blocker.query('lock table payments in access exclusive mode');

      expect(await get('/v1/stats/live', {}, fresh)).toMatchObject({ status: 503, body: { error: { code: 'stats_unavailable' } } });
    }
    finally {
      await blocker.query('rollback');
      await blocker.end();
    }
    clock.set(noon);
  });
});

describe('the public numbers\' own pool', () => {
  let elsewhere: TestDatabase;

  beforeAll(async () => {
    elsewhere = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await elsewhere?.drop();
  });

  it('reads the public numbers on a pool of their own, and only there', async () => {
    const server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: elsewhere.postgres, statsPostgres: database.postgres, redis, clock });
    servers.push(server);
    const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

    // The rows are where the stats pool is, none where the others' is
    expect((await get('/v1/services', {}, `http://127.0.0.1:${port}`)).body).toMatchObject({ total: 4 });
  });

  it('answers 503, never kept, when its pool has no connection, while the other routes go on', async () => {
    const down = createPostgres({ url: Secret.from('postgres://anyfare:anyfare@127.0.0.1:9/anyfare'), logger: createLogger({ level: 'silent' }), connectTimeoutMs: 500 });
    const server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, statsPostgres: down, redis, clock });
    servers.push(server);
    const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
    try {
      for (const path of ['/v1/stats', '/v1/services', '/v1/services/asked.example.com', '/v1/endpoints/stats?host=asked.example.com&path=/v1/a']) {
        const answer = await get(path, {}, `http://127.0.0.1:${port}`);
        expect([answer.status, errorCode(answer), answer.headers.get('cache-control')], path).toEqual([503, 'stats_unavailable', 'no-store']);
      }
      expect((await get('/v1/calls', {}, `http://127.0.0.1:${port}`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/_/ready`)).status).toBe(200);
    }
    finally {
      await down.close();
    }
  });
});

describe('the shared parts of the public numbers', () => {
  it('are kept by a cache only when they succeed: an error is no-store', async () => {
    for (const path of ['/v1/services/nothing.example.com', '/v1/stats/top?period=90d', '/v1/endpoints/stats?host=a..b&path=/x'])
      expect((await get(path)).headers.get('cache-control'), path).toBe('no-store');
    for (const path of ['/v1/stats', '/v1/stats/top', '/v1/endpoints/stats?host=asked.example.com&path=/v1/a'])
      expect((await get(path)).headers.get('cache-control'), path).toBe('public, max-age=60');
    expect((await get('/v1/services')).headers.get('cache-control')).toBe('public, max-age=55');
    // A service's page shows a newly checked link within seconds
    expect((await get('/v1/services/asked.example.com')).headers.get('cache-control')).toBe('public, max-age=3');
  });

  it('answer any origin, on errors too, and the preflight', async () => {
    const preflight = { method: 'OPTIONS', headers: { origin: 'https://site.example', 'access-control-request-method': 'GET' } };

    for (const path of [...everyPath, '/v1/services/nothing.example.com', '/v1/stats/top?period=90d']) {
      const answer = await get(path, preflight);
      expect([answer.status, answer.headers.get('access-control-allow-origin'), answer.headers.get('access-control-allow-methods')], path).toEqual([204, '*', 'GET, OPTIONS']);
      expect((await get(path)).headers.get('access-control-allow-origin'), path).toBe('*');
    }
  });

  it('share the publicReads limit per client IP with the calls, and never count a preflight', async () => {
    const own = await createTestRedis();
    redises.push(own);
    const limited = await start({ ...config, rateLimits: { ...config.rateLimits, publicReads: { requests: everyPath.length, windowSeconds: 60 } } }, { redis: own });
    const preflight = { method: 'OPTIONS', headers: { origin: 'https://site.example', 'access-control-request-method': 'GET' } };

    for (const path of everyPath)
      expect((await get(path, preflight, limited)).status, path).toBe(204);
    for (const path of everyPath)
      expect((await get(path, {}, limited)).status, path).toBe(200);
    for (const path of [...everyPath, '/v1/calls']) {
      const over = await get(path, {}, limited);
      expect(over, path).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
      expect([over.headers.get('access-control-allow-origin'), over.headers.get('retry-after')], path).toEqual(['*', expect.stringMatching(/^\d+$/)]);
    }
  });
});
