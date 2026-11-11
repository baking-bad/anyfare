import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { Secret } from '@anyfare/common';
import { createPaidWith, hashApiKey, loadPlatformConfig, type PaidWithWay, type PaymentStatus } from '@anyfare/core';
import { createTestDatabase, createTestPool, type TestDatabase } from '@anyfare/testing';

import { createAccountRepository, createPaymentKeyRepository } from '../../src/index.js';
import * as schema from '../../src/schema/index.js';
import { createStatsCounter } from '../../src/statsCounts.js';
import { createStatsRepository } from '../../src/statsRepository.js';

// The plans of the public numbers' statements on a database of some size: the platform's numbers read
// the finished calls of 30 days by an index on their time, a batch of services by the host index, one
// endpoint asked for by the path index, the credited top-ups by the ledger's operation index, the prices
// by the routed endpoints' key, the live numbers' tail by time; every public read of a stored answer by
// its key. None reads payments whole.

let database: TestDatabase;
let pool: pg.Pool;
let ways: readonly PaidWithWay[];
const queries: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
const dayMs = 86_400_000;
// 200 days of 100 calls a day, the last of them today
const now = new Date('2027-05-30T12:00:00.000Z');
const first = now.getTime() - 200 * dayMs;
const callCount = 20_000;
const statuses: readonly PaymentStatus[] = ['settled', 'settled', 'failed', 'cancelled', 'settling'];
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');

beforeAll(async () => {
  database = await createTestDatabase();
  const { db } = database;
  ways = createPaidWith(await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } })).ways;
  await createAccountRepository({ db }).create({ id: 'acc_plans', createdAt: new Date(first) });
  await createPaymentKeyRepository({ db }).insert({
    id: 'key_plans', accountId: 'acc_plans', keyHash: hashApiKey(Secret.from('af_test_stats_plans')), label: undefined, createdAt: new Date(first),
    allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
  const rows = Array.from({ length: callCount }, (_, index) => {
    const createdAt = new Date(first + index * (200 * dayMs / callCount));
    const credits = index % 3 === 0;
    const inFlight = index % 20 === 0;
    const status: PaymentStatus = credits ? (inFlight ? 'held' : 'captured') : inFlight ? 'verified' : statuses[index % statuses.length]!;

    return {
      id: `pay_${String(index).padStart(6, '0')}`, rail: credits ? 'credits' as const : 'x402' as const, buyerAccountId: credits ? 'acc_plans' : null,
      keyId: credits ? 'key_plans' : null, targetHost: `api-${index % 40}.example.com`, targetPath: `/v1/endpoint/${index % 300}`, network: credits ? null : 'eip155:84532',
      asset: credits ? null : 'base-usdc', amount: 1_100n, status, upstreamStatus: 200, upstreamLatencyMs: 100 + index % 50, needsReview: false, createdAt,
      updatedAt: new Date(createdAt.getTime() + 700),
    };
  });
  // A path every host has, and a host with few calls
  rows.push(...Array.from({ length: 6_000 }, (_, index) => ({
    ...rows[callCount - 1 - index]!, id: `pay_common_${index}`, targetPath: '/', targetHost: index < 3 ? 'rare.example.com' : `api-${index % 40}.example.com`,
  })));
  for (let index = 0; index < rows.length; index += 1_000) {
    const batch = rows.slice(index, index + 1_000);
    await db.insert(schema.payments).values(batch);
    await db.insert(schema.callDetails).values(batch.map((row, offset) => ({
      paymentId: row.id, method: 'GET', payer: row.rail === 'credits' ? null : `0x${String((index + offset) % 500).padStart(40, '0')}`, arrivedAt: row.createdAt,
    })));
    // The ledger's other transactions far outnumber top-ups
    await db.insert(schema.ledgerTransactions).values(batch.map(row => ({ id: `ltx_${row.id}`, operation: 'hold', reference: row.id, requestId: null, createdAt: row.createdAt })));
  }
  // 20,000 top-ups, one in 40 credited
  const topups = Array.from({ length: 20_000 }, (_, index) => ({ index, credited: index % 40 === 0, createdAt: new Date(first + index * (200 * dayMs / 20_000)) }));
  await db.insert(schema.ledgerTransactions).values(topups.filter(topup => topup.credited)
    .map(topup => ({ id: `ltx_top_${topup.index}`, operation: 'top_up', reference: `deposit-${topup.index}`, requestId: null, createdAt: topup.createdAt })));
  for (let index = 0; index < topups.length; index += 1_000) {
    await db.insert(schema.topups).values(topups.slice(index, index + 1_000).map(topup => ({
      id: `top_${topup.index}`, accountId: 'acc_plans', requestId: null, status: topup.credited ? 'credited' as const : 'expired' as const, network: 'base', blockchain: 'base',
      tokenSymbol: 'USDC', originAsset: 'asset-usdc', tokenDecimals: 6, amount: 1_000_000n, destinationAsset: 'near-usdc', recipient: 'treasury.anyfare.testnet',
      refundTo: 'treasury.anyfare.testnet', payBy: topup.createdAt, quoteRequest: {}, depositAddress: `deposit-${topup.index}`,
      creditedAmount: topup.credited ? 1_000_000n : null, ledgerTransactionId: topup.credited ? `ltx_top_${topup.index}` : null, originTxHashes: [], needsReview: false,
      createdAt: topup.createdAt, updatedAt: topup.createdAt,
    })));
  }
  // Routed endpoints: each of the calls' 600 endpoints, and many of other hosts
  await db.insert(schema.routedEndpoints).values(Array.from({ length: 4_000 }, (_, index) => ({
    host: index < 600 ? `api-${index % 40}.example.com` : `other-${index}.example.com`, path: index < 600 ? `/v1/endpoint/${index % 300}` : '/v1/other',
    lastPrice: 1_000n, createdAt: new Date(first),
  })));
  pool = createTestPool(database);
  // The counts' tables, as full as 1,000 services make them, the 40 with calls with 100 endpoints each
  const numbers = { calls: 1, buyers: 1, volume: '0.01', successRate: 1, p50Ms: 100, byPaidWith: [] };
  await db.insert(schema.statsAnswers).values(['platform', 'platform:all', 'services', 'top:today', 'top:7d', 'top:30d', 'top:all', 'live', 'run:recent', 'run:all']
    .map(key => ({ key, answer: {}, countedAt: now })));
  for (let host = 0; host < 1_000; host += 1) {
    const hostHash = md5(`api-${host}.example.com`);
    await db.insert(schema.statsServices).values({
      hostHash, host: `api-${host}.example.com`, paidEndpoints: 100, priceFrom: 1_000n, calls: 10, buyers: 1, volume: 10_000n, successRate: 1, p50Ms: 100, trend: [],
      countedAt: now,
    });
    await db.insert(schema.statsServicePages).values(['today', '7d', '30d', 'all'].map(period => ({
      hostHash, period: period as 'today', answer: {} as never, countedAt: now,
    })));
    if (host < 40) {
      await db.insert(schema.statsEndpoints).values(Array.from({ length: 100 }, (_, path) => ({
        hostHash, pathHash: md5(`/v1/endpoint/${path}`), path: `/v1/endpoint/${path}`, method: 'GET', price: 1_000n,
        recent: { today: numbers, '7d': numbers, '30d': numbers }, daily: [], countedAt: now, all: numbers, allCountedAt: now,
      })));
    }
  }
  await pool.query('analyze');
// Seeding takes longer than the default hook limit on a busy machine
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

// A database that records every statement it sends
const recording = () => {
  queries.length = 0;

  return drizzle({ client: pool, schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } });
};

const plan = async (query: { readonly sql: string; readonly params: readonly unknown[] }): Promise<string> => {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(`explain (costs off) ${query.sql}`, [...query.params]);

  return rows.map(row => row['QUERY PLAN']).join('\n');
};

// The statements sent: no begin, set or commit
const statements = () => queries.filter(query => /^\s*(with|select|insert|update|delete)\b/i.test(query.sql));
const plans = async () => Promise.all(statements().map(plan));
// The finished calls by an index on their time, whichever the planner takes
const byTime = /(?:Index|Index Only|Bitmap Index) Scan(?: Backward)? (?:using|on) payments_\w+_idx(?: on payments)?\n\s+Index Cond: [^\n]*created_at >= /;
const hostHashes = Array.from({ length: 5 }, (_, host) => md5(`api-${host}.example.com`));
const dayAgo = (days: number) => new Date(now.getTime() - days * dayMs);

describe('the plans of the public numbers', () => {
  it('read the platform\'s calls of 30 days, the minutes of 48 hours, the ranking and the top lists by an index on time', async () => {
    const counter = createStatsCounter({ db: recording(), ways });
    const periods = [{ period: 'today' as const, from: dayAgo(0.5) }, { period: '30d' as const, from: dayAgo(30) }];
    await counter.platform({ periods, to: now, timeoutMs: 30_000 });
    await counter.platformDays({ from: dayAgo(30), to: now, timeoutMs: 30_000 });
    await counter.minutes({ from: dayAgo(2), to: now, timeoutMs: 30_000 });
    await counter.top({ periods, to: now, timeoutMs: 30_000 });
    await counter.ranking({ from: dayAgo(30), to: now, limit: 1_000, timeoutMs: 30_000 });
    await counter.keepBuyers({ day: now.toISOString().slice(0, 10), from: dayAgo(0.5), to: now, cap: 100_000, timeoutMs: 30_000 });

    const texts = await plans();
    expect(texts.length).toBeGreaterThanOrEqual(7);
    for (const text of texts.filter(each => /on payments\b/.test(each))) {
      expect(text, text).toMatch(byTime);
      expect(text, text).not.toMatch(/Seq Scan on payments/);
    }
  });

  it('read a batch of services by the host index, and their prices by the host index and the routed endpoints\' key', async () => {
    const counter = createStatsCounter({ db: recording(), ways });
    const scope = { hostHashes, to: now };
    const periods = [{ period: '30d' as const, from: dayAgo(30) }];
    await counter.services({ scope, periods, timeoutMs: 30_000 });
    await counter.endpoints({ scope, periods, rankBy: '30d', dailyFrom: dayAgo(14), timeoutMs: 30_000 });
    await counter.serviceDays({ scope: { ...scope, from: dayAgo(30) }, timeoutMs: 30_000 });
    await counter.callsIn({ scope, windows: [{ period: '30d', from: dayAgo(60), to: dayAgo(30) }], timeoutMs: 30_000 });
    const batchPlans = await plans();
    await counter.priceFrom({ hostHashes: [md5('api-1.example.com'), md5('api-2.example.com')], from: dayAgo(30), to: now, timeoutMs: 30_000 });
    const [prices] = (await plans()).slice(-1);

    for (const text of batchPlans) {
      expect(text, text).toContain('payments_calls_host_idx');
      expect(text, text).not.toMatch(/Seq Scan on payments/);
    }
    expect(prices, prices).toContain('payments_calls_host_idx');
    expect(prices, prices).toContain('routed_endpoints_pkey');
    expect(prices, prices).not.toMatch(/Seq Scan on (?:payments|routed_endpoints)/);
  });

  it('read one endpoint asked for by the narrower of its host\'s and its path\'s index, as their counts up to the cap tell, and not at all with no call', async () => {
    const counter = createStatsCounter({ db: recording(), ways });
    const periods = [{ period: '30d' as const, from: dayAgo(30) }];
    const ask = async (host: string, path: string) => {
      const scope = await counter.endpointScope({ host, path, from: dayAgo(30), cap: 10_000, timeoutMs: 30_000 });
      if (!scope)
        throw new Error(`no scope for ${host}${path}`);
      await counter.endpoints({ scope, periods, rankBy: '30d', withFree: true, dailyFrom: dayAgo(14), maxPathLength: 2_048, timeoutMs: 30_000 });

      return { scope, plans: (await plans()).slice(-2) };
    };

    // A path every host has, on a host with few calls; then a path of few calls on a host with many
    const common = await ask('rare.example.com', '/');
    const narrow = await ask('api-1.example.com', '/v1/endpoint/1');

    expect([common.scope, narrow.scope]).toEqual([
      { endpoint: { host: 'rare.example.com', path: '/', by: 'host' }, from: dayAgo(30), cap: 10_000 },
      { endpoint: { host: 'api-1.example.com', path: '/v1/endpoint/1', by: 'path' }, from: dayAgo(30), cap: 10_000 },
    ]);
    // A host with no call, and a path no host has: nothing to read
    expect(await counter.endpointScope({ host: 'never.example.com', path: '/', from: dayAgo(30), cap: 10_000, timeoutMs: 30_000 })).toBeUndefined();
    expect(await counter.endpointScope({ host: 'api-1.example.com', path: '/v1/never', from: dayAgo(30), cap: 10_000, timeoutMs: 30_000 })).toBeUndefined();
    const [commonReach, commonRead] = common.plans;
    const [, narrowRead] = narrow.plans;
    expect(commonReach, commonReach).toContain('payments_calls_host_idx');
    expect(commonReach, commonReach).toContain('payments_calls_path_idx');
    expect(commonRead, commonRead).toContain('payments_calls_host_idx');
    expect(narrowRead, narrowRead).toContain('payments_calls_path_idx');
    for (const text of [...common.plans, ...narrow.plans])
      expect(text, text).not.toMatch(/Seq Scan on payments/);
  });

  it('read one endpoint asked for by the path index, up to its cap, and a host by the host index', async () => {
    const counter = createStatsCounter({ db: recording(), ways });
    const periods = [{ period: '30d' as const, from: dayAgo(30) }];
    await counter.endpoints({ scope: { endpoint: { host: 'api-7.example.com', path: '/v1/endpoint/7', by: 'path' }, from: dayAgo(30), cap: 10_000 }, periods, rankBy: '30d', withFree: true, dailyFrom: dayAgo(14), timeoutMs: 30_000 });
    await counter.isCapped({ scope: { endpoint: { host: 'api-7.example.com', path: '/v1/endpoint/7', by: 'path' }, from: dayAgo(30), cap: 10_000 }, timeoutMs: 30_000 });
    const endpointPlans = await plans();
    await counter.hasPaidCall({ host: 'api-7.example.com', timeoutMs: 30_000 });
    await counter.services({ scope: { host: 'api-7.example.com', from: dayAgo(30), cap: 10_000 }, periods, timeoutMs: 30_000 });
    const hostPlans = (await plans()).slice(endpointPlans.length);

    for (const text of endpointPlans) {
      expect(text, text).toContain('payments_calls_path_idx');
      expect(text, text).not.toMatch(/Seq Scan on payments/);
    }
    for (const text of hostPlans) {
      expect(text, text).toContain('payments_calls_host_idx');
      expect(text, text).not.toMatch(/Seq Scan on payments/);
    }
  });

  it('read credited top-ups by the ledger\'s operation index and each top-up by its deposit address', async () => {
    const counter = createStatsCounter({ db: recording(), ways });
    await counter.topups({ periods: [{ period: '30d', from: dayAgo(30) }, { period: 'all', from: undefined }], to: now, timeoutMs: 30_000 });
    const [text] = await plans();

    expect(text, text).toContain('ledger_transactions_operation_reference_idx');
    expect(text, text).toContain('topups_deposit_address_idx');
    expect(text, text).not.toMatch(/Seq Scan on (?:ledger_transactions|topups)/);
  });

  it('read the live numbers\' tail once, by an index on time', async () => {
    const counter = createStatsCounter({ db: recording(), ways });
    await counter.liveTail({ from: new Date(now.getTime() - 10 * 60_000), at: now, minutesFrom: new Date(now.getTime() - 30 * 60_000), timeoutMs: 30_000 });
    const texts = await plans();

    expect(texts).toHaveLength(1);
    expect(texts[0], texts[0]).toMatch(byTime);
    expect(texts[0], texts[0]).not.toMatch(/Seq Scan on payments/);
  });

  it('read each stored answer in one statement, a service\'s page and an endpoint by their keys', async () => {
    const store = createStatsRepository({ db: recording() });
    await store.platform();
    await store.top('30d');
    await store.live();
    await store.servicePage('api-1.example.com', '30d', { timeoutMs: 2_000, maxPaid: 1_000 });
    await store.endpoint('api-1.example.com', '/v1/endpoint/1');
    const sent = statements();

    expect(sent).toHaveLength(5);
    // Only the page's, a public read of what checks listed, in a transaction of its own for its timeout
    expect(queries.filter(query => /^\s*(begin|commit)/i.test(query.sql)).map(query => query.sql.trim())).toEqual(['begin', 'commit']);
    expect(queries.filter(query => /statement_timeout/.test(query.sql)).map(query => query.sql)).toEqual(['set local statement_timeout = 2000']);
    // The platform's answers are a table of at most 11 rows: a page and an endpoint go by their keys
    const [, , , page, endpoint] = await plans();
    expect(page, page).toContain('stats_service_pages_pkey');
    expect(page, page).toContain('stats_endpoints_pkey');
    expect(endpoint, endpoint).toContain('stats_endpoints_pkey');
    for (const text of [page!, endpoint!])
      expect(text, text).not.toMatch(/Seq Scan on stats_(?:service_pages|endpoints)/);
  });
});
