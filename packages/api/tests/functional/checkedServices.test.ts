import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import { buildServicePage, endpointNumbersOf, loadPlatformConfig, type PlatformConfig, type ServiceRow, type StoredEndpoint } from '@anyfare/core';
import { callDetails, createRoutingRepository, createStatsRepository, payments, routedEndpoints, type RoutingRepository } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, type FakeClock, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';
import { catalogCacheMs } from '../../src/catalog/routes.js';
import { listingCacheMs, servicesCacheMs } from '../../src/stats/routes.js';

// The services of both kinds through the real app: the paid ones the counts stored, and those a payable check
// listed, read now. A checked service shows with no numbers; a blocked host, or one of a blocked parent domain,
// leaves at read time.

const generous = { requests: 100_000, windowSeconds: 60 };
const noon = '2026-11-12T12:00:00.000Z';
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
const days = (count: number): string[] => Array.from({ length: count }, (_, index) => new Date(Date.parse('2026-11-12T00:00:00.000Z') - (count - 1 - index) * 86_400_000)
  .toISOString().slice(0, 10));
const minutesAfter = (minutes: number): Date => new Date(Date.parse(noon) - 3_600_000 + minutes * 60_000);

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let clock: FakeClock;
let routing: RoutingRepository;
let registered: FakeClock;
let server: ApiServer;
let url: string;

// Past every cache in the process, so the next read reads again
const fresh = (): void => {
  clock.advance(Math.max(servicesCacheMs, listingCacheMs, catalogCacheMs));
};

const get = async (path: string) => {
  const response = await fetch(`${url}${path}`);
  const text = await response.text();

  return { status: response.status, headers: response.headers, text, body: JSON.parse(text) as Record<string, unknown> };
};

// As the internal API lists them: a check's endpoint, with its client counted for a new host, and a paid call's
const check = async (host: string, path: string, at: Date, price = 1_100n, method: 'GET' | 'POST' = 'GET') => {
  registered.set(at);

  return routing.registerEndpoint({ host, path, lastPrice: price, checked: { method, mayAddHost: true } });
};
const paidCall = async (host: string, path: string, at: Date, price = 1_100n) => {
  registered.set(at);

  return routing.registerEndpoint({ host, path, lastPrice: price });
};

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  const loaded = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
  config = { ...loaded, rateLimits: { ...loaded.rateLimits, publicReads: generous, documents: generous } };
  clock = createFakeClock(noon);
  registered = createFakeClock(noon);
  routing = createRoutingRepository({ db: database.db, clock: registered });
  server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock });
  url = `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;

  // Two services the count stored, the first with an endpoint a check listed too; and two hosts listed only by checks
  const stats = createStatsRepository({ db: database.db });
  const row = (host: string, changes: Partial<ServiceRow>): ServiceRow => ({
    hostHash: md5(host), host, paidEndpoints: 1, priceFrom: 2_000n, calls: 1, buyers: 1, volume: 1_000n, successRate: 1, p50Ms: 100, trend: [], ...changes,
  });
  await stats.putServices({
    // With when each first joined, as the count keeps it
    rows: [
      row('alpha.example.com', { calls: 10, buyers: 3, volume: 100_000n, paidEndpoints: 2, priceFrom: 5_000n, listedAt: minutesAfter(0) }),
      row('beta.example.org', { calls: 5, buyers: 4, volume: 20_000n, listedAt: minutesAfter(1) }),
    ],
    countedAt: new Date('2026-11-12T11:00:00.000Z'),
    timeoutMs: 5_000,
  });
  await stats.putAnswers({
    answers: [
      { key: 'services', answer: { services: 2, paidEndpoints: 3, calls30d: 15 } },
      {
        key: 'top:30d',
        answer: {
          services: [{ host: 'alpha.example.com', calls: 10 }, { host: 'beta.example.org', calls: 5 }],
          endpoints: [{ host: 'alpha.example.com', path: '/v1/paid', calls: 10 }, { host: 'beta.example.org', path: '/v1/b', calls: 5 }],
          paidWith: [], topupTokens: [],
        },
      },
    ],
    countedAt: new Date('2026-11-12T11:55:00.000Z'),
    timeoutMs: 5_000,
  });
  await stats.markComplete({ kind: 'recent', countedAt: new Date('2026-11-12T11:55:00.000Z'), timeoutMs: 5_000 });
  const numbers = endpointNumbersOf({ calls: 10, volume: 100_000n, buyers: 3, free: 0, p50Ms: 100, p95Ms: 100, ways: [{ paidWith: 'base', calls: 10 }] });
  const endpoint: StoredEndpoint = {
    hostHash: md5('alpha.example.com'), pathHash: md5('/v1/paid'), path: '/v1/paid', method: 'GET', price: 5_000n,
    recent: { today: numbers, '7d': numbers, '30d': numbers }, daily: Array.from({ length: 14 }, () => 0),
  };
  await stats.putEndpoints({ hostHashes: [md5('alpha.example.com')], endpoints: [endpoint], countedAt: new Date('2026-11-12T11:00:00.000Z'), timeoutMs: 5_000 });
  await stats.putServicePages({
    pages: ['alpha.example.com', 'beta.example.org'].map(host => ({
      hostHash: md5(host), period: '30d' as const, answer: buildServicePage({ host, period: '30d', callsBefore: 0, daily: [], now: new Date(noon), counts: undefined }),
    })),
    countedAt: new Date('2026-11-12T11:00:00.000Z'),
    timeoutMs: 5_000,
  });
  await paidCall('alpha.example.com', '/v1/paid', minutesAfter(0), 5_000n);
  await paidCall('beta.example.org', '/v1/b', minutesAfter(1), 2_000n);
  await check('alpha.example.com', '/v1/checked', minutesAfter(30), 900n, 'POST');
  // The paid endpoint confirmed by a check
  await check('alpha.example.com', '/v1/paid', minutesAfter(31), 5_500n);
  await check('aged.example.net', '/v1/one', minutesAfter(10), 3_000n);
  await check('newer.example.net', '/v1/two', minutesAfter(20), 1_100n);
  await check('newer.example.net', '/v1/three', minutesAfter(21), 1_000n);
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

type Listed = { host: string; status: string; [name: string]: unknown };
const hostsOf = async (query: string): Promise<{ hosts: string[]; total: unknown }> => {
  const answer = await get(`/v1/services${query}`);

  return { hosts: (answer.body['services'] as Listed[]).map(service => service.host), total: answer.body['total'] };
};

describe('GET /v1/services with both kinds', () => {
  it('lists paid services first, then the checked ones, the newest first, and a checked one with no numbers', async () => {
    const answer = await get('/v1/services');
    const services = answer.body['services'] as Listed[];

    expect(services.map(service => [service.host, service.status])).toEqual([
      ['alpha.example.com', 'paid'], ['beta.example.org', 'paid'], ['newer.example.net', 'checked'], ['aged.example.net', 'checked'],
    ]);
    expect(services[2]).toEqual({
      host: 'newer.example.net', status: 'checked', paidEndpoints: 2, priceFrom: '0.001', currency: 'USD', calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null,
      trend: days(30).map(() => 0), listedAt: minutesAfter(20).toISOString(), checkedAt: minutesAfter(21).toISOString(),
    });
    // A paid one's listed endpoints, its paid one and the one a check listed, each once, the lowest price among them, when
    // it first joined and when a check last confirmed it
    expect(services[0]).toMatchObject({
      paidEndpoints: 2, priceFrom: '0.0009', calls: 10, listedAt: minutesAfter(0).toISOString(), checkedAt: minutesAfter(31).toISOString(),
    });
    expect(services[1]).toMatchObject({ paidEndpoints: 1, listedAt: minutesAfter(1).toISOString(), checkedAt: null });
    // Every listed service; the paid ones; their listed endpoints, of paid calls and of checks, each once; the count's calls
    expect(answer.body['totals']).toEqual({ services: 4, paidServices: 2, paidEndpoints: 2 + 1 + 2 + 1, calls30d: 15 });
    expect(answer.body).toMatchObject({ total: 4, totalCapped: false, updatedAt: '2026-11-12T11:55:00.000Z' });
  });

  it('sorts both kinds by each order, the newest listed first with sort=newest, and pages them', async () => {
    expect((await hostsOf('?sort=newest')).hosts).toEqual(['newer.example.net', 'aged.example.net', 'beta.example.org', 'alpha.example.com']);
    expect((await hostsOf('?sort=buyers')).hosts).toEqual(['beta.example.org', 'alpha.example.com', 'aged.example.net', 'newer.example.net']);
    expect((await hostsOf('?sort=volume')).hosts).toEqual(['alpha.example.com', 'beta.example.org', 'aged.example.net', 'newer.example.net']);
    expect((await hostsOf('?sort=endpoints')).hosts).toEqual(['alpha.example.com', 'newer.example.net', 'aged.example.net', 'beta.example.org']);
    expect((await hostsOf('?sort=price')).hosts).toEqual(['alpha.example.com', 'newer.example.net', 'beta.example.org', 'aged.example.net']);
    expect(await hostsOf('?size=1&page=3')).toEqual({ hosts: ['newer.example.net'], total: 4 });
    expect(await hostsOf('?size=3&page=2')).toEqual({ hosts: ['aged.example.net'], total: 4 });
  });

  it('keeps a page of the list 5 s in the process, by its query without case, and reads it again after', async () => {
    const first = await hostsOf('?q=Kept&size=5');
    await check('kept.cache-test.io', '/v1/x', minutesAfter(42));
    const cached = await hostsOf('?q=kept&size=5');
    clock.advance(servicesCacheMs);
    const after = await hostsOf('?q=KEPT&size=5');

    expect([first.hosts, cached.hosts, after.hosts]).toEqual([[], [], ['kept.cache-test.io']]);
  });

  it('answers 503 when the list\'s or a page\'s read can\'t finish in its 2 s, never kept by a cache, and reads again at the next request', async () => {
    fresh();
    // Another session holds the tables the reads need: each waits until its statement gives up
    const stalled = await database.db.transaction(async tx => {
      await tx.execute(sql`lock table paid_hosts in access exclusive mode`);
      const started = performance.now();
      const answers = [await get('/v1/services'), await get('/v1/services/newer.example.net')];

      return { answers, tookMs: performance.now() - started };
    });
    const after = [await get('/v1/services'), await get('/v1/services/newer.example.net')];

    for (const answer of stalled.answers) {
      expect(answer).toMatchObject({ status: 503, body: { error: { code: 'stats_unavailable' } } });
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    expect(stalled.tookMs).toBeGreaterThanOrEqual(3_800);
    expect(stalled.tookMs).toBeLessThan(8_000);
    expect(after.map(answer => [answer.status, answer.headers.get('cache-control')])).toEqual([[200, 'public, max-age=55'], [200, 'public, max-age=3']]);
  });

  it('searches both kinds by a part of the host', async () => {
    expect(await hostsOf('?q=.NET')).toEqual({ hosts: ['newer.example.net', 'aged.example.net'], total: 2 });
    expect(await hostsOf('?q=example.org')).toEqual({ hosts: ['beta.example.org'], total: 1 });
    expect(await hostsOf('?q=nowhere')).toEqual({ hosts: [], total: 0 });
  });

  it('lists a host a check listed at the next read, and never one whose check isn\'t listed', async () => {
    await check('fresh.example.net', '/v1/new', minutesAfter(40));
    fresh();
    expect((await hostsOf('?q=fresh')).hosts).toEqual(['fresh.example.net']);
    // Its client wasn't counted for a new host: nothing listed
    registered.set(minutesAfter(41));
    expect(await routing.registerEndpoint({ host: 'uncounted.example.net', path: '/v1/x', checked: { method: 'GET', mayAddHost: false } })).toBe('limited');
    expect((await hostsOf('?q=uncounted')).hosts).toEqual([]);
  });
});

describe('GET /v1/services/{host} with both kinds', () => {
  it('answers a checked service with every endpoint a check listed, its price, link, method and time, and no numbers', async () => {
    const answer = await get('/v1/services/Newer.example.net?period=7d');

    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('public, max-age=3');
    expect(answer.body).toEqual({
      host: 'newer.example.net', period: '7d', updatedAt: clock.now().toISOString(), status: 'checked', listedAt: minutesAfter(20).toISOString(), checkedAt: minutesAfter(21).toISOString(),
      paidEndpoints: 2,
      stats: { calls: 0, callsBefore: 0, volume: '0', buyers: 0, returningShare: 0, successRate: null, failedCalls: 0, p50Ms: null, p95Ms: null },
      endpoints: [
        {
          path: '/v1/three', method: 'GET', priceNow: '0.001', calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null,
          link: 'https://pay.anyfare.test/newer.example.net/v1/three', status: 'checked', checkedAt: minutesAfter(21).toISOString(),
        },
        {
          path: '/v1/two', method: 'GET', priceNow: '0.0011', calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null,
          link: 'https://pay.anyfare.test/newer.example.net/v1/two', status: 'checked', checkedAt: minutesAfter(20).toISOString(),
        },
      ],
      daily: days(30).map(day => ({ day, calls: 0, volume: '0', buyers: 0 })),
      byPaidWith: [],
      topBuyers: { share: 0, buyers: [] },
      exact: true,
    });
    expect((await get('/v1/services/newer.example.net?period=all')).body).toMatchObject({ stats: { callsBefore: null }, status: 'checked' });
  });

  it('answers a paid service with its paid endpoints, then those listed only by a check, each with when a check last confirmed it', async () => {
    const answer = await get('/v1/services/alpha.example.com');

    // Its listed endpoints, as the list counts them
    expect(answer.body).toMatchObject({ host: 'alpha.example.com', status: 'paid', paidEndpoints: 2, listedAt: minutesAfter(0).toISOString(), checkedAt: minutesAfter(31).toISOString() });
    expect(answer.body['endpoints']).toEqual([
      expect.objectContaining({ path: '/v1/paid', status: 'paid', calls: 10, checkedAt: minutesAfter(31).toISOString() }),
      {
        path: '/v1/checked', method: 'POST', priceNow: '0.0009', calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null,
        link: 'https://pay.anyfare.test/alpha.example.com/v1/checked', status: 'checked', checkedAt: minutesAfter(30).toISOString(),
      },
    ]);
  });

  it('shows a newly checked link within seconds', async () => {
    expect(((await get('/v1/services/aged.example.net')).body['endpoints'] as unknown[])).toHaveLength(1);
    await check('aged.example.net', '/v1/later', minutesAfter(50));

    clock.advance(listingCacheMs);
    const answer = await get('/v1/services/aged.example.net');

    expect((answer.body['endpoints'] as { path: string }[]).map(endpoint => endpoint.path)).toEqual(['/v1/later', '/v1/one']);
    expect(answer.body).toMatchObject({ paidEndpoints: 2, checkedAt: minutesAfter(50).toISOString() });
  });

  it('keeps a paid service\'s endpoints within 100 and 24 KB of path text: a checked one past either is counted, not listed', async () => {
    const stats = createStatsRepository({ db: database.db });
    const numbers = endpointNumbersOf({ calls: 1, volume: 1_000n, buyers: 1, free: 0, p50Ms: 100, p95Ms: 100, ways: [{ paidWith: 'base', calls: 1 }] });
    // Stored endpoints whose paths leave room for a checked path of `room` characters, and no more
    const store = async (host: string, count: number, chars: number) => {
      const endpoints: StoredEndpoint[] = Array.from({ length: count }, (_, index) => {
        const path = `/${String(index).padStart(3, '0')}${'p'.repeat(chars - 4)}`;

        return { hostHash: md5(host), pathHash: md5(path), path, method: 'GET', price: 1_000n, recent: { today: numbers, '7d': numbers, '30d': numbers }, daily: [] };
      });
      await stats.putEndpoints({ hostHashes: [md5(host)], endpoints, countedAt: new Date(noon), timeoutMs: 5_000 });
      await stats.putServicePages({
        pages: [{ hostHash: md5(host), period: '30d', answer: buildServicePage({ host, period: '30d', callsBefore: 0, daily: [], now: new Date(noon), counts: undefined }) }],
        countedAt: new Date(noon),
        timeoutMs: 5_000,
      });
    };
    const listedOf = async (host: string) => ((await get(`/v1/services/${host}`)).body['endpoints'] as { path: string; status: string }[]);
    // 99 paths of 243 characters and a checked one of 512 are 24,569, just within 24,576; of 244, 24,668 are past it
    await store('fits.example.com', 99, 243);
    await store('tight.example.com', 99, 244);
    await store('full.example.com', 100, 10);
    for (const host of ['fits.example.com', 'tight.example.com', 'full.example.com'])
      await check(host, `/${'c'.repeat(511)}`, minutesAfter(55));
    fresh();

    const [fits, tight, full] = [await listedOf('fits.example.com'), await listedOf('tight.example.com'), await listedOf('full.example.com')];

    expect([fits.length, fits.at(-1)?.status]).toEqual([100, 'checked']);
    expect([tight.length, tight.every(endpoint => endpoint.status === 'paid')]).toEqual([99, true]);
    expect([full.length, full.every(endpoint => endpoint.status === 'paid')]).toEqual([100, true]);
    expect(fits.reduce((sum, endpoint) => sum + endpoint.path.length, 0)).toBeLessThanOrEqual(24_576);
    expect((await get('/v1/services/tight.example.com')).body['paidEndpoints']).toBe(1);
  });

  it('answers 404 for a host neither a paid call nor a check listed', async () => {
    expect(await get('/v1/services/never.example.net')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });
});

describe('the list, a service\'s page and a check\'s listing', () => {
  const dayMs = 86_400_000;
  let counter = 0;
  // A finished paid call, as the proxy and its rails write it
  const paidAt = async (host: string, path: string, at: Date): Promise<void> => {
    counter += 1;
    const id = `pay_checked_services_${counter}`;
    await database.db.insert(payments).values({
      id, requestId: `req-${id}`, rail: 'x402', buyerAccountId: null, keyId: null, targetHost: host, targetPath: path, network: 'eip155:84532', asset: 'base-usdc',
      atomicAmount: 1_100n, amount: 1_100n, fee: null, upstreamStatus: 200, upstreamLatencyMs: 100, status: 'settled', transactionHash: null, receipt: null,
      settlementRequest: null, needsReview: false, createdAt: at, updatedAt: at,
    });
    await database.db.insert(callDetails).values({ paymentId: id, method: 'GET', payer: '0x1111111111111111111111111111111111111111', arrivedAt: at });
  };
  // A check as the proxy lists it: nothing of a host the blocklist names, nor a new endpoint at a cap; its client
  // counted whenever the count doesn't store the host
  const listedByCheck = async (host: string, path: string): Promise<boolean> => {
    registered.set(clock.now());
    const state = await routing.endpointListing(host, path, { timeoutMs: 1_000 });
    if (state.blocked || (state.status === undefined && (state.checkedEndpoints >= 20 || state.paidCapped)))
      return false;
    const result = await routing.registerEndpoint({ host, path, lastPrice: 1_100n, checked: { method: 'GET', mayAddHost: !state.stored } });

    return result === 'created' || result === 'exists';
  };
  const listedRow = async (host: string): Promise<Listed | undefined> =>
    ((await get(`/v1/services?q=${host}`)).body['services'] as Listed[]).find(service => service.host === host);
  // As the count stores a service: its row, its page of 30 days and its endpoints with calls
  const counted = async (host: string, called: readonly { readonly path: string; readonly price: bigint }[]): Promise<void> => {
    const stats = createStatsRepository({ db: database.db });
    const numbers = endpointNumbersOf({ calls: 1, volume: 1_100n, buyers: 1, free: 0, p50Ms: 100, p95Ms: 100, ways: [{ paidWith: 'base', calls: 1 }] });
    await stats.putServices({
      rows: [{ hostHash: md5(host), host, paidEndpoints: called.length, priceFrom: 1_100n, calls: 1, buyers: 1, volume: 1_100n, successRate: 1, p50Ms: 100, trend: [] }],
      countedAt: clock.now(), timeoutMs: 5_000,
    });
    await stats.putServicePages({
      pages: [{ hostHash: md5(host), period: '30d', answer: { ...buildServicePage({ host, period: '30d', callsBefore: 0, daily: [], now: clock.now(), counts: undefined }), paidEndpoints: called.length } }],
      countedAt: clock.now(), timeoutMs: 5_000,
    });
    await stats.putEndpoints({
      hostHashes: [md5(host)], countedAt: clock.now(), timeoutMs: 5_000,
      endpoints: called.map(({ path, price }) => ({
        hostHash: md5(host), pathHash: md5(path), path, method: 'GET', price, recent: { today: numbers, '7d': numbers, '30d': numbers }, daily: [],
      })),
    });
  };

  it('agree for every kind of host: checked only, paid today, paid 40 days ago and checked now or never since, paid with checked endpoints, at the paid cap, and paid with an endpoint idle for 30 days', async () => {
    const now = clock.now();
    const before = new Date(now.getTime() - 40 * dayMs);
    // Paid today, and stored by the count
    await paidCall('today.agree.dev', '/v1/x', now);
    await paidAt('today.agree.dev', '/v1/x', now);
    await counted('today.agree.dev', [{ path: '/v1/x', price: 1_100n }]);
    // Paid 40 days ago, outside the count: the first checked now and the other never since
    for (const host of ['checked.old-paid.dev', 'unchecked.old-paid.dev']) {
      await paidCall(host, '/v1/x', before);
      await paidAt(host, '/v1/x', before);
    }
    // Paid 40 days ago at a higher price, and checked now on another path
    await paidCall('both.agree.dev', '/v1/paid', before, 2_000n);
    await paidAt('both.agree.dev', '/v1/paid', before);
    // At its 1,000 paid endpoints
    await database.db.insert(routedEndpoints).values(Array.from({ length: 999 }, (_, index) => ({
      host: 'capped.agree.dev', path: `/v1/item/${String(index).padStart(3, '0')}`, lastPrice: 1_000n, createdAt: new Date(before.getTime() - index * 1_000), status: 'paid' as const,
    })));
    await paidCall('capped.agree.dev', '/v1/item/999', before, 1_000n);
    await paidAt('capped.agree.dev', '/v1/item/999', before);
    // Stored by the count, with calls on one endpoint and none in 30 days on the other, which is cheaper
    await paidCall('idle.agree.dev', '/v1/idle', before, 500n);
    await paidAt('idle.agree.dev', '/v1/idle', before);
    await paidCall('idle.agree.dev', '/v1/called', now, 1_000n);
    await paidAt('idle.agree.dev', '/v1/called', now);
    await counted('idle.agree.dev', [{ path: '/v1/called', price: 1_000n }]);

    const checks: Readonly<Record<string, { readonly path: string; readonly listed: boolean }>> = {
      'only.agree.dev': { path: '/v1/x', listed: await listedByCheck('only.agree.dev', '/v1/x') },
      'today.agree.dev': { path: '/v1/x', listed: await listedByCheck('today.agree.dev', '/v1/x') },
      'checked.old-paid.dev': { path: '/v1/x', listed: await listedByCheck('checked.old-paid.dev', '/v1/x') },
      'both.agree.dev': { path: '/v1/checked', listed: await listedByCheck('both.agree.dev', '/v1/checked') },
      'capped.agree.dev': { path: '/v1/new', listed: await listedByCheck('capped.agree.dev', '/v1/new') },
      'idle.agree.dev': { path: '/v1/called', listed: await listedByCheck('idle.agree.dev', '/v1/called') },
    };
    fresh();

    // What each answer says: the check's `listed` (none: never checked), the list's row and the page
    const cases = [
      { host: 'only.agree.dev', listed: true, status: 'checked', paidEndpoints: 1, priceFrom: '0.0011', paths: ['/v1/x'] },
      { host: 'today.agree.dev', listed: true, status: 'paid', paidEndpoints: 1, priceFrom: '0.0011', paths: ['/v1/x'] },
      { host: 'checked.old-paid.dev', listed: true, status: 'paid', paidEndpoints: 1, priceFrom: '0.0011', paths: ['/v1/x'] },
      { host: 'unchecked.old-paid.dev', listed: undefined, status: 'paid', paidEndpoints: 1, priceFrom: '0.0011', paths: ['/v1/x'] },
      { host: 'both.agree.dev', listed: true, status: 'paid', paidEndpoints: 2, priceFrom: '0.0011', paths: ['/v1/paid', '/v1/checked'] },
      { host: 'capped.agree.dev', listed: false, status: 'paid', paidEndpoints: 1_000, priceFrom: '0.001', paths: 100 },
      { host: 'idle.agree.dev', listed: true, status: 'paid', paidEndpoints: 2, priceFrom: '0.0005', paths: ['/v1/called', '/v1/idle'] },
    ] as const;
    for (const expected of cases) {
      const { host } = expected;
      const row = await listedRow(host);
      const page = await get(`/v1/services/${host}`);
      const endpoints = (page.body['endpoints'] ?? []) as { path: string; priceNow: string | null; calls: number }[];
      const lowest = endpoints.map(endpoint => endpoint.priceNow).filter(price => price !== null).sort((a, b) => Number(a) - Number(b))[0];

      // Listed, and found
      expect([row?.host, page.status], host).toEqual([host, 200]);
      // The list and the page say the same: its kind, its listed endpoints each once, and the lowest price among them
      expect({ status: page.body['status'], paidEndpoints: page.body['paidEndpoints'], priceFrom: lowest }, host).toEqual({
        status: row?.status, paidEndpoints: row?.['paidEndpoints'], priceFrom: row?.['priceFrom'],
      });
      expect({ listed: checks[host]?.listed, status: row?.status, paidEndpoints: row?.['paidEndpoints'], priceFrom: row?.['priceFrom'] }, host).toEqual({
        listed: expected.listed, status: expected.status, paidEndpoints: expected.paidEndpoints, priceFrom: expected.priceFrom,
      });
      if (typeof expected.paths === 'number')
        expect(endpoints, host).toHaveLength(expected.paths);
      else
        expect(endpoints.map(endpoint => endpoint.path), host).toEqual(expected.paths);
      // What a check listed is on the page, and what it couldn't list is not
      const check = checks[host];
      if (check)
        expect(endpoints.some(endpoint => endpoint.path === check.path), host).toBe(check.listed);
    }
    // An endpoint with no call in 30 days is on its page with its pay link and no numbers
    expect(((await get('/v1/services/idle.agree.dev')).body['endpoints'] as Record<string, unknown>[])[1]).toEqual({
      path: '/v1/idle', method: null, priceNow: '0.0005', calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null,
      link: 'https://pay.anyfare.test/idle.agree.dev/v1/idle', status: 'paid', checkedAt: null,
    });
  });

  it('hold each endpoint once on a page: a checked endpoint a paid call reached without becoming paid shows as paid, counted once', async () => {
    const stats = createStatsRepository({ db: database.db });
    const numbers = endpointNumbersOf({ calls: 2, volume: 2_000n, buyers: 1, free: 0, p50Ms: 100, p95Ms: 100, ways: [{ paidWith: 'base', calls: 2 }] });
    await stats.putEndpoints({
      hostHashes: [md5('once.agree.dev')], countedAt: clock.now(), timeoutMs: 5_000,
      endpoints: [{ hostHash: md5('once.agree.dev'), pathHash: md5('/v1/both'), path: '/v1/both', method: 'GET', price: 1_000n, recent: { today: numbers, '7d': numbers, '30d': numbers }, daily: [] }],
    });
    await stats.putServicePages({
      pages: [{
        hostHash: md5('once.agree.dev'), period: '30d',
        answer: { ...buildServicePage({ host: 'once.agree.dev', period: '30d', callsBefore: 0, daily: [], now: clock.now(), counts: undefined }), paidEndpoints: 1 },
      }],
      countedAt: clock.now(), timeoutMs: 5_000,
    });
    // As a registration that never arrived leaves it: still checked, beside one checked only
    await check('once.agree.dev', '/v1/only-checked', clock.now());
    await database.db.insert(routedEndpoints).values({ host: 'once.agree.dev', path: '/v1/both', createdAt: clock.now(), status: 'checked', checkedAt: clock.now() });
    fresh();

    const page = await get('/v1/services/once.agree.dev');

    expect((page.body['endpoints'] as { path: string; status: string }[]).map(endpoint => [endpoint.path, endpoint.status])).toEqual([
      ['/v1/both', 'paid'], ['/v1/only-checked', 'checked'],
    ]);
    expect(page.body['paidEndpoints']).toBe(2);
  });
});

describe('a host on the blocklist', () => {
  it('leaves the services, its page and the catalog at read time, a stored paid one too, and the subdomains of a blocked parent', async () => {
    await check('blocked.example.net', '/v1/x', minutesAfter(45));
    await check('a.evil-parent.net', '/v1/x', minutesAfter(46));
    await check('b.a.evil-parent.net', '/v1/x', minutesAfter(47));
    fresh();
    expect((await hostsOf('?q=blocked')).hosts).toEqual(['blocked.example.net']);
    expect((await hostsOf('?q=evil-parent')).hosts).toEqual(['b.a.evil-parent.net', 'a.evil-parent.net']);
    const before = (await get('/v1/services')).body['totals'] as Record<string, number>;

    await routing.block({ host: 'blocked.example.net', reason: 'abuse' });
    await routing.block({ host: 'beta.example.org', reason: 'abuse' });
    await routing.block({ host: 'evil-parent.net', reason: 'abuse' });
    fresh();

    expect((await hostsOf('?q=blocked')).hosts).toEqual([]);
    expect((await hostsOf('?q=evil-parent')).hosts).toEqual([]);
    expect((await hostsOf('')).hosts).not.toContain('beta.example.org');
    for (const host of ['blocked.example.net', 'beta.example.org', 'a.evil-parent.net', 'b.a.evil-parent.net'])
      expect(await get(`/v1/services/${host}`), host).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    const catalog = (await get('/v1/catalog?q=e&limit=100')).body['endpoints'] as { host: string }[];
    for (const host of ['blocked.example.net', 'beta.example.org', 'a.evil-parent.net', 'b.a.evil-parent.net'])
      expect(catalog.map(entry => entry.host), host).not.toContain(host);
    // The count's totals without the stored one blocked
    expect((await get('/v1/services')).body['totals']).toEqual({
      services: before['services']! - 4, paidServices: before['paidServices']! - 1, paidEndpoints: before['paidEndpoints']! - 4, calls30d: 10,
    });
    // Nor does an endpoint's numbers show it, nor the top lists
    for (const [host, path] of [['beta.example.org', '/v1/b'], ['b.a.evil-parent.net', '/v1/x']])
      expect(await get(`/v1/endpoints/stats?host=${host}&path=${path}`), host).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    expect((await get('/v1/endpoints/stats?host=alpha.example.com&path=/v1/paid')).status).toBe(200);
    const top = (await get('/v1/stats/top?period=30d')).body;
    expect([top['services'], top['endpoints']]).toEqual([
      [{ host: 'alpha.example.com', calls: 10 }], [{ host: 'alpha.example.com', path: '/v1/paid', calls: 10 }],
    ]);
    for (const host of ['blocked.example.net', 'beta.example.org', 'evil-parent.net'])
      await routing.unblock(host);
  });
});
