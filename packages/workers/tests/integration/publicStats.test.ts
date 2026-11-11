import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { callDetails, createRoutingRepository, payments } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, fixtureTime, type FakeClock, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { seedBuyer, seedCall, seedTopup, statsApi, statsJobs, type SeededCall } from '../support/stats.js';

// Seeded calls on every way to pay over 30 UTC days and before, with free calls, calls in flight, and
// top-ups, give these exact numbers through the API. The counts run at noon on 2026-12-15, so today is
// 12-15, the 7 days start on 12-09, and the 30 days on 11-16.

const now = fixtureTime(1, 15, 12, 0, 0, 0);
const alpha = 'alpha.example.com';
const beta = 'beta.example.com';
const gamma = 'gamma.example.com';
// The same EVM payer, as two calls may name it
const evmPayer = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const nearPayer = 'scout.testnet';
const solanaPayer = 'SoLBuyer111111111111111111111111111111111111';
const tempoPayer = '0x1111111111111111111111111111111111111111';
const mainnetPayer = '0x5555555555555555555555555555555555555555';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let clock: FakeClock;
let api: ReturnType<typeof statsApi>;

const seed = (call: SeededCall) => seedCall(database.db, call);
const day = (date: string, time = '12:00:00.000'): string => `2026-${date}T${time}Z`;
const read = async <TBody = Record<string, unknown>>(path: string): Promise<TBody> => (await api.get<TBody>(path)).body;
const runCounts = async (): Promise<void> => {
  const jobs = statsJobs(database.db, config, clock);
  await jobs.recent();
  await jobs.all();
};

beforeAll(async () => {
  [database, redis, config] = await Promise.all([createTestDatabase(), createTestRedis(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } })]);
  clock = createFakeClock(now);
  api = statsApi(database.postgres, redis, config, clock);
  await Promise.all(['acc_stats_k1', 'acc_stats_k2'].map(account => seedBuyer(database.db, account, new Date(now))));
  const k1 = { account: 'acc_stats_k1' };
  const k2 = { account: 'acc_stats_k2' };
  const quote = { host: alpha, path: '/v1/quote' };
  const pools = { host: alpha, path: '/v1/pools' };
  const data = { host: beta, path: '/v2/data' };

  // Today
  await seed({ ...quote, at: day('12-15', '10:00:00.000'), way: 'credits', status: 'captured', ms: 100, ...k1, method: 'GET' });
  await seed({ ...quote, at: day('12-15', '10:01:00.000'), way: 'base', status: 'settled', ms: 200, payer: evmPayer, method: 'GET' });
  // Still settling, so paid; the same payer without case
  await seed({ ...quote, at: day('12-15', '10:02:00.000'), way: 'base', status: 'settling', ms: 300, payer: evmPayer.toLowerCase(), method: 'POST' });
  await seed({ ...pools, at: day('12-15', '10:03:00.000'), way: 'near', status: 'settled', amount: 5_000n, ms: 400, payer: nearPayer, method: 'GET' });
  // Free: a settlement that failed, and a Credits hold released
  await seed({ ...quote, at: day('12-15', '10:04:00.000'), way: 'base', status: 'failed', ms: 900, payer: evmPayer, method: 'GET' });
  await seed({ ...quote, at: day('12-15', '10:05:00.000'), way: 'credits', status: 'released', ms: 50, ...k2, method: 'GET' });
  // In flight: never counted
  await seed({ ...quote, at: day('12-15', '10:06:00.000'), way: 'base', status: 'verified', ms: 10, payer: evmPayer, method: 'GET' });
  await seed({ ...quote, at: day('12-15', '10:07:00.000'), way: 'credits', status: 'held', ms: 10, ...k1, method: 'GET' });
  // A millisecond either side of midnight
  await seed({ ...quote, at: day('12-14', '23:59:59.999'), way: 'credits', status: 'captured', ms: 100, ...k1, method: 'GET' });
  await seed({ ...quote, at: day('12-15', '00:00:00.000'), way: 'solana', status: 'settled', ms: 150, payer: solanaPayer, method: 'GET' });
  await seed({ ...pools, at: day('12-14'), way: 'tempo', status: 'settled', amount: 5_000n, ms: 250, payer: tempoPayer, method: 'GET' });
  // Before the payer was kept: one unknown buyer on Base
  await seed({ ...quote, at: day('12-09', '09:00:00.000'), way: 'base', status: 'settled', ms: 120 });
  await seed({ ...quote, at: day('12-09', '09:30:00.000'), way: 'base', status: 'settled', ms: 130 });
  // Outside the 7 days, inside the 30
  await seed({ ...quote, at: day('12-08', '08:00:00.000'), way: 'near', status: 'settled', ms: 180, payer: nearPayer, method: 'GET' });
  // The first millisecond of the 30 days, and the last one before them
  await seed({ ...pools, at: day('11-16', '00:00:00.000'), way: 'credits', status: 'captured', ms: 110, ...k2, method: 'GET' });
  await seed({ ...pools, at: day('11-15', '23:59:59.999'), way: 'credits', status: 'captured', ms: 105, ...k2, method: 'GET' });
  await seed({ ...quote, at: day('11-12', '10:00:00.000'), way: 'base', status: 'settled', ms: 200, payer: evmPayer, method: 'GET' });
  // A second service
  await seed({ ...data, at: day('12-15', '11:00:00.000'), way: 'credits', status: 'captured', amount: 20_000n, ms: 500, ...k1, method: 'GET' });
  await seed({ ...data, at: day('12-14', '11:00:00.000'), way: 'base', status: 'cancelled', amount: 20_000n, payer: evmPayer, method: 'GET' });
  await seed({ ...data, at: day('12-12', '11:00:00.000'), way: 'near', status: 'settled', amount: 20_000n, ms: 600, payer: nearPayer, method: 'GET' });
  await seed({ ...data, at: day('12-15', '08:00:00.000'), way: 'mainnet', status: 'settled', ms: 550, payer: mainnetPayer, method: 'GET' });
  // A host with free calls only is no service
  await seed({ host: gamma, path: '/x', at: day('12-15', '09:00:00.000'), way: 'base', status: 'failed', ms: 700, payer: evmPayer, method: 'GET' });

  // The routed endpoints' last quotes: one endpoint was never paid, so its price is no service's
  const routing = createRoutingRepository({ db: database.db, clock });
  for (const [host, path, lastPrice] of [[alpha, '/v1/quote', 10_000n], [alpha, '/v1/pools', 5_000n], [alpha, '/v1/unused', 1_000n], [beta, '/v2/data', 20_000n]] as const)
    await routing.registerEndpoint({ host, path, lastPrice });

  const topup = (input: Omit<Parameters<typeof seedTopup>[2], 'account'>) => seedTopup(database.db, clock, { account: 'acc_stats_k1', ...input });
  await topup({ network: 'base', token: 'USDC', credits: 5_000_000n, end: { credited: day('12-15', '09:00:00.000') } });
  await topup({ network: 'base', token: 'USDC', credits: 2_500_000n, end: { credited: day('12-01') } });
  await topup({ network: 'arbitrum', token: 'USDT', credits: 10_000_000n, end: { credited: day('11-13') } });
  await topup({ network: 'solana', token: 'SOL', credits: 3_000_000n, end: 'refunded' });
  await topup({ network: 'base', token: 'USDC', credits: 4_000_000n, end: 'waiting' });

  clock.set(now);
  await runCounts();
}, 60_000);

afterAll(async () => {
  await api?.server.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// The last 30 UTC days with these days' values, zeros elsewhere
const thirtyDays = <TValue>(values: Readonly<Record<string, TValue>>, zero: TValue): { day: string; value: TValue }[] =>
  Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.parse('2026-11-16T00:00:00.000Z') + index * 86_400_000).toISOString().slice(0, 10);

    return { day: date, value: values[date.slice(5)] ?? zero };
  });

interface Service {
  readonly stats: Record<string, unknown>;
  readonly endpoints: Record<string, unknown>[];
  readonly byPaidWith: Record<string, unknown>[];
  readonly topBuyers: { readonly share: number; readonly buyers: { payer: string | null; paidWith: string; calls: number; spent: string; lastCallAt: string }[] };
  readonly daily: unknown[];
  readonly [field: string]: unknown;
}

describe('the public numbers\' counts', () => {
  it('count the platform\'s paid calls, volume, buyers and services per period, by way to pay, with credited top-ups and 30 days', async () => {
    expect(await read('/v1/stats')).toEqual({
      updatedAt: now,
      allUpdatedAt: now,
      calls: { today: 7, '7d': 12, '30d': 14, all: 16 },
      volume: { today: '0.075', '7d': '0.13', '30d': '0.15', all: '0.17', currency: 'USD' },
      // The unknown Base payer is one buyer; the EVM payer is one with or without case
      buyers: { today: 5, '7d': 7, '30d': 8, all: 8 },
      services: { today: 2, '7d': 2, '30d': 2, all: 2 },
      byPaidWith: {
        today: [
          { paidWith: 'base', calls: 2, volume: '0.02' }, { paidWith: 'credits', calls: 2, volume: '0.03' }, { paidWith: 'eip155:8453', calls: 1, volume: '0.01' },
          { paidWith: 'near', calls: 1, volume: '0.005' }, { paidWith: 'solana', calls: 1, volume: '0.01' },
        ],
        '7d': [
          { paidWith: 'base', calls: 4, volume: '0.04' }, { paidWith: 'credits', calls: 3, volume: '0.04' }, { paidWith: 'near', calls: 2, volume: '0.025' },
          { paidWith: 'eip155:8453', calls: 1, volume: '0.01' }, { paidWith: 'solana', calls: 1, volume: '0.01' }, { paidWith: 'tempo', calls: 1, volume: '0.005' },
        ],
        '30d': [
          { paidWith: 'base', calls: 4, volume: '0.04' }, { paidWith: 'credits', calls: 4, volume: '0.05' }, { paidWith: 'near', calls: 3, volume: '0.035' },
          { paidWith: 'eip155:8453', calls: 1, volume: '0.01' }, { paidWith: 'solana', calls: 1, volume: '0.01' }, { paidWith: 'tempo', calls: 1, volume: '0.005' },
        ],
        all: [
          { paidWith: 'base', calls: 5, volume: '0.05' }, { paidWith: 'credits', calls: 5, volume: '0.06' }, { paidWith: 'near', calls: 3, volume: '0.035' },
          { paidWith: 'eip155:8453', calls: 1, volume: '0.01' }, { paidWith: 'solana', calls: 1, volume: '0.01' }, { paidWith: 'tempo', calls: 1, volume: '0.005' },
        ],
      },
      // Credited ones only: not the refunded one, nor the one still waiting
      topups: { '30d': { count: 2, usd: '7.5' }, all: { count: 3, usd: '17.5' } },
      daily: thirtyDays({ '11-16': [1, '0.01'], '12-08': [1, '0.01'], '12-09': [2, '0.02'], '12-12': [1, '0.02'], '12-14': [2, '0.015'], '12-15': [7, '0.075'] }, [0, '0'])
        .map(({ day: date, value: [calls, volume] }) => ({ day: date, calls, volume })),
    });
  });

  it('put a call a millisecond before a UTC midnight on the day before, and one at midnight on its own day', async () => {
    const days = new Map((await read<{ daily: { day: string; calls: number }[] }>('/v1/stats')).daily.map(entry => [entry.day, entry.calls]));
    const quote = await read<{ daily: { day: string; calls: number }[] }>(`/v1/endpoints/stats?host=${alpha}&path=/v1/quote`);

    // 23:59:59.999 on 12-14 with the tempo call that day; 00:00 on 12-15 with today's
    expect([days.get('2026-12-14'), days.get('2026-12-15')]).toEqual([2, 7]);
    expect(quote.daily.filter(entry => entry.day >= '2026-12-14')).toEqual([{ day: '2026-12-14', calls: 1 }, { day: '2026-12-15', calls: 4 }]);
    // 00:00 on 11-16 is the first of the 30 days; 23:59:59.999 on 11-15 is before them
    expect(days.get('2026-11-16')).toBe(1);
    expect(days.has('2026-11-15')).toBe(false);
    expect((await read<Service>(`/v1/services/${alpha}?period=30d`)).stats['callsBefore']).toBe(2);
  });

  it('keep the top services, endpoints, ways to pay and top-up tokens of each period', async () => {
    expect(await read('/v1/stats/top?period=today')).toEqual({
      period: 'today',
      updatedAt: now,
      services: [{ host: alpha, calls: 5 }, { host: beta, calls: 2 }],
      endpoints: [{ host: alpha, path: '/v1/quote', calls: 4 }, { host: beta, path: '/v2/data', calls: 2 }, { host: alpha, path: '/v1/pools', calls: 1 }],
      paidWith: [{ paidWith: 'base', calls: 2 }, { paidWith: 'credits', calls: 2 }, { paidWith: 'eip155:8453', calls: 1 }, { paidWith: 'near', calls: 1 }, { paidWith: 'solana', calls: 1 }],
      topupTokens: [{ network: 'base', token: 'USDC', count: 1 }],
    });
    expect(await read('/v1/stats/top?period=30d')).toMatchObject({
      services: [{ host: alpha, calls: 11 }, { host: beta, calls: 3 }],
      endpoints: [{ host: alpha, path: '/v1/quote', calls: 8 }, { host: alpha, path: '/v1/pools', calls: 3 }, { host: beta, path: '/v2/data', calls: 3 }],
      topupTokens: [{ network: 'base', token: 'USDC', count: 2 }],
    });
    expect(await read('/v1/stats/top?period=all')).toMatchObject({
      updatedAt: now,
      services: [{ host: alpha, calls: 13 }, { host: beta, calls: 3 }],
      topupTokens: [{ network: 'base', token: 'USDC', count: 2 }, { network: 'arbitrum', token: 'USDT', count: 1 }],
    });
  });

  it('count a service per period: calls and the period before, buyers and the returning share, success, p50 and p95, ways to pay and top buyers', async () => {
    const [today, week, month, all] = await Promise.all(['today', '7d', '30d', 'all'].map(period => read<Service>(`/v1/services/${alpha}?period=${period}`))) as [
      Service, Service, Service, Service,
    ];

    // The unknown Base payer is a buyer, but none who could return
    expect([today.stats, week.stats, month.stats, all.stats]).toEqual([
      { calls: 5, callsBefore: 2, volume: '0.045', buyers: 4, returningShare: 0, successRate: 0.7143, failedCalls: 2, p50Ms: 200, p95Ms: 750 },
      { calls: 9, callsBefore: 1, volume: '0.08', buyers: 6, returningShare: 0.2, successRate: 0.8182, failedCalls: 2, p50Ms: 150, p95Ms: 650 },
      { calls: 11, callsBefore: 2, volume: '0.1', buyers: 7, returningShare: 0.3333, successRate: 0.8462, failedCalls: 2, p50Ms: 150, p95Ms: 600 },
      { calls: 13, callsBefore: null, volume: '0.12', buyers: 7, returningShare: 0.6667, successRate: 0.8667, failedCalls: 2, p50Ms: 150, p95Ms: 550 },
    ]);
    expect([today.exact, all.exact, today.updatedAt, all.updatedAt]).toEqual([true, true, now, now]);
    expect(month.byPaidWith).toEqual([
      { paidWith: 'base', calls: 4, share: 0.3636, buyers: 2, volume: '0.04' },
      { paidWith: 'credits', calls: 3, share: 0.2727, buyers: 2, volume: '0.03' },
      { paidWith: 'near', calls: 2, share: 0.1818, buyers: 1, volume: '0.015' },
      { paidWith: 'solana', calls: 1, share: 0.0909, buyers: 1, volume: '0.01' },
      { paidWith: 'tempo', calls: 1, share: 0.0909, buyers: 1, volume: '0.005' },
    ]);
    // A Credits buyer has no payer, and the unknown Base payer is never a top buyer
    expect(today.topBuyers).toEqual({
      share: 1,
      buyers: [
        { payer: evmPayer.toLowerCase(), paidWith: 'base', calls: 2, spent: '0.02', lastCallAt: day('12-15', '10:02:00.000') },
        { payer: null, paidWith: 'credits', calls: 1, spent: '0.01', lastCallAt: day('12-15', '10:00:00.000') },
        { payer: solanaPayer, paidWith: 'solana', calls: 1, spent: '0.01', lastCallAt: day('12-15', '00:00:00.000') },
        { payer: nearPayer, paidWith: 'near', calls: 1, spent: '0.005', lastCallAt: day('12-15', '10:03:00.000') },
      ],
    });
    expect(month.topBuyers.share).toBe(0.7273);
    expect(month.topBuyers.buyers.map(entry => [entry.payer, entry.paidWith, entry.calls, entry.spent])).toEqual([
      [evmPayer.toLowerCase(), 'base', 2, '0.02'], [null, 'credits', 2, '0.02'], [nearPayer, 'near', 2, '0.015'], [solanaPayer, 'solana', 1, '0.01'], [null, 'credits', 1, '0.01'],
    ]);
    expect(all.topBuyers.buyers.map(entry => [entry.payer, entry.calls, entry.spent])).toEqual([
      [evmPayer.toLowerCase(), 3, '0.03'], [null, 2, '0.02'], [null, 2, '0.02'], [nearPayer, 2, '0.015'], [solanaPayer, 1, '0.01'],
    ]);
    expect(week.topBuyers.share).toBe(0.7778);
  });

  it('list a service\'s endpoints with each period\'s numbers, current price and link, and 30 days of calls, volume and buyers', async () => {
    const month = await read<Service>(`/v1/services/${alpha}?period=30d`);
    const today = await read<Service>(`/v1/services/${alpha}?period=today`);

    expect(month).toMatchObject({ host: alpha, period: '30d', paidEndpoints: 2 });
    expect(month.endpoints).toEqual([
      {
        path: '/v1/quote', method: 'GET', priceNow: '0.01', calls: 8, buyers: 5, volume: '0.08', successRate: 0.8, p50Ms: 140,
        link: 'https://pay.anyfare.test/alpha.example.com/v1/quote',
      },
      {
        path: '/v1/pools', method: 'GET', priceNow: '0.005', calls: 3, buyers: 3, volume: '0.02', successRate: 1, p50Ms: 250,
        link: 'https://pay.anyfare.test/alpha.example.com/v1/pools',
      },
    ]);
    expect(today.endpoints.map(endpoint => [endpoint['path'], endpoint['calls']])).toEqual([['/v1/quote', 4], ['/v1/pools', 1]]);
    expect(month.daily).toEqual(thirtyDays({ '11-16': [1, '0.01', 1], '12-08': [1, '0.01', 1], '12-09': [2, '0.02', 1], '12-14': [2, '0.015', 2], '12-15': [5, '0.045', 4] }, [0, '0', 0])
      .map(({ day: date, value: [calls, volume, buyers] }) => ({ day: date, calls, volume, buyers })));
  });

  it('count an endpoint per period, with 14 days and its ways to pay, and one every call of which failed at a success rate of 0', async () => {
    expect(await read(`/v1/endpoints/stats?host=${alpha}&path=/v1/quote`)).toEqual({
      host: alpha,
      path: '/v1/quote',
      period: '30d',
      updatedAt: now,
      stats: { calls: 8, buyers: 5, volume: '0.08', successRate: 0.8, p50Ms: 140 },
      daily: thirtyDays({ '12-08': 1, '12-09': 2, '12-14': 1, '12-15': 4 }, 0).slice(-14).map(({ day: date, value }) => ({ day: date, calls: value })),
      byPaidWith: [{ paidWith: 'base', calls: 4 }, { paidWith: 'credits', calls: 2 }, { paidWith: 'near', calls: 1 }, { paidWith: 'solana', calls: 1 }],
      exact: true,
    });
    expect((await read<Service>(`/v1/endpoints/stats?host=${alpha}&path=/v1/pools&period=today`)).stats).toEqual({ calls: 1, buyers: 1, volume: '0.005', successRate: 1, p50Ms: 400 });
    // Read when asked for: no call at all, and only failed ones
    expect((await read<Service>(`/v1/endpoints/stats?host=${alpha}&path=/v1/unused`)).stats).toEqual({ calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null });
    expect(await read(`/v1/endpoints/stats?host=${gamma}&path=/x&period=today`)).toMatchObject({
      stats: { calls: 0, buyers: 0, volume: '0', successRate: 0, p50Ms: 700 }, exact: true,
    });
  });

  it('keep one row per service with a paid call in 30 days, with its numbers, cheapest paid endpoint and trend, and the totals', async () => {
    const found = await read<{ services: Record<string, unknown>[]; total: number; totalCapped: boolean; totals: unknown }>('/v1/services');
    const trend = (values: Readonly<Record<string, number>>) => thirtyDays(values, 0).map(({ value }) => value);

    expect([found.total, found.totalCapped, found.totals]).toEqual([2, false, { services: 2, paidEndpoints: 3, calls30d: 14 }]);
    expect(found.services).toEqual([
      {
        host: alpha, paidEndpoints: 2, priceFrom: '0.005', currency: 'USD', calls: 11, buyers: 7, volume: '0.1', successRate: 0.8462, p50Ms: 150,
        trend: trend({ '11-16': 1, '12-08': 1, '12-09': 2, '12-14': 2, '12-15': 5 }),
      },
      {
        host: beta, paidEndpoints: 1, priceFrom: '0.02', currency: 'USD', calls: 3, buyers: 3, volume: '0.05', successRate: 0.75, p50Ms: 550,
        trend: trend({ '12-12': 1, '12-15': 2 }),
      },
    ]);
    // Free calls only: no service
    expect((await api.get(`/v1/services/${gamma}`)).status).toBe(404);
  });

  it('count again from the rows each run, writing only the rows whose numbers changed: a new call shows, and one gone is gone', async () => {
    const xminOf = async (host: string) => (await database.db.execute<{ xmin: string }>(sql`select xmin::text from stats_services where host = ${host}`)).rows[0]?.xmin;
    const before = await read('/v1/stats');
    const alphaRow = await xminOf(alpha);
    clock.set(fixtureTime(1, 15, 12, 5, 0, 0));

    const unchanged = await statsJobs(database.db, config, clock).recent();
    expect(unchanged).toMatchObject({ written: 0, deleted: 0 });
    // Vouched for by the complete count, not written again
    expect((await read<Service>(`/v1/services/${alpha}`)).updatedAt).toBe(fixtureTime(1, 15, 12, 5, 0, 0));
    expect(await xminOf(alpha)).toBe(alphaRow);

    const id = await seed({ host: beta, path: '/v2/data', at: fixtureTime(1, 15, 12, 1, 0, 0), way: 'near', status: 'settled', ms: 300, payer: 'new.testnet', method: 'GET' });
    const changed = await statsJobs(database.db, config, clock).recent();
    expect(changed.written).toBeGreaterThan(0);
    expect(await xminOf(alpha)).toBe(alphaRow);
    expect(await read('/v1/stats')).toMatchObject({ calls: { today: 8, '30d': 15 }, buyers: { today: 6 } });

    await database.db.delete(callDetails).where(eq(callDetails.paymentId, id));
    await database.db.delete(payments).where(eq(payments.id, id));
    await statsJobs(database.db, config, clock).recent();
    expect({ ...await read('/v1/stats'), updatedAt: now }).toEqual(before);
  });
});
