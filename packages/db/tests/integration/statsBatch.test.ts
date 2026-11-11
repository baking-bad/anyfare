import { createHash } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@anyfare/common';
import { createPaidWith, hashApiKey, loadPlatformConfig, type PaidWithWay } from '@anyfare/core';
import { createTestDatabase, type TestDatabase } from '@anyfare/testing';

import { createAccountRepository, createPaymentKeyRepository } from '../../src/index.js';
import * as schema from '../../src/schema/index.js';
import { createStatsCounter, type CountedPeriod } from '../../src/statsCounts.js';

// One batch of the frequent count: 20 services with 101 paths each. Each statement reads its calls once
// and joins nothing but by an index or a hash: its time grows with the calls, not with their square.

let database: TestDatabase;
let pool: pg.Pool;
let ways: readonly PaidWithWay[];
const queries: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
const now = new Date('2026-12-20T12:00:00.000Z');
const dayMs = 86_400_000;
const hosts = Array.from({ length: 20 }, (_, index) => `batch-${index}.example.com`);
const pathsPerHost = 101;
const periods: readonly CountedPeriod[] = [
  { period: 'today', from: new Date('2026-12-20T00:00:00.000Z') }, { period: '7d', from: new Date('2026-12-14T00:00:00.000Z') },
  { period: '30d', from: new Date('2026-11-21T00:00:00.000Z') },
];

beforeAll(async () => {
  database = await createTestDatabase();
  const { db } = database;
  ways = createPaidWith(await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } })).ways;
  await createAccountRepository({ db }).create({ id: 'acc_batch', createdAt: now });
  await createPaymentKeyRepository({ db }).insert({
    id: 'key_batch', accountId: 'acc_batch', keyHash: hashApiKey(Secret.from('af_test_batch')), label: undefined, createdAt: now,
    allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
  const rows = hosts.flatMap((host, hostIndex) => Array.from({ length: pathsPerHost }, (_, pathIndex) => {
    const index = hostIndex * pathsPerHost + pathIndex;
    const createdAt = new Date(now.getTime() - 60_000 - (index % 25) * dayMs);
    const credits = index % 3 === 0;

    return {
      id: `pay_batch_${index}`, rail: credits ? 'credits' as const : 'x402' as const, buyerAccountId: credits ? 'acc_batch' : null, keyId: credits ? 'key_batch' : null,
      targetHost: host, targetPath: `/v1/item/${pathIndex}`, network: credits ? null : 'eip155:84532', asset: credits ? null : 'base-usdc', amount: 1_000n,
      status: credits ? 'captured' as const : 'settled' as const, upstreamStatus: 200, upstreamLatencyMs: 50 + index % 70, needsReview: false,
      createdAt, updatedAt: createdAt,
    };
  }));
  await db.insert(schema.payments).values(rows);
  await db.insert(schema.callDetails).values(rows.map((row, index) => ({
    paymentId: row.id, method: 'GET', payer: row.rail === 'credits' ? null : `0x${String(index % 300).padStart(40, '0')}`, arrivedAt: row.createdAt,
  })));
  await db.insert(schema.routedEndpoints).values(hosts.map(host => ({ host, path: '/v1/item/1', lastPrice: 1_000n, createdAt: now })));
  pool = new pg.Pool({ connectionString: database.url.expose() });
  await pool.query('analyze');
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

// A counter on a connection that records every statement it sends
const recording = () => {
  queries.length = 0;

  return createStatsCounter({ db: drizzle({ client: pool, schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } }), ways });
};

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Join Filter'?: string;
  readonly Plans?: readonly PlanNode[];
}

const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

/** Every nested loop of each statement sent that filters the pairs it joins, rather than probing an index. */
const nestedLoopFilters = async (): Promise<string[]> => {
  const sent = queries.filter(query => /^\s*(with|select|insert|update|delete)\b/i.test(query.sql));
  const found: string[] = [];
  for (const query of sent) {
    const { rows } = await pool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`explain (format json) ${query.sql}`, [...query.params]);
    for (const node of nodesOf(rows[0]!['QUERY PLAN'][0]!.Plan)) {
      if (node['Node Type'] === 'Nested Loop' && node['Join Filter'] !== undefined)
        found.push(`${node['Join Filter']} in ${query.sql.slice(0, 120)}`);
    }
  }

  return found;
};

describe('a batch of the frequent count', () => {
  it('counts the top 100 endpoints of each of 20 services with 101 paths in well under a second or two, joining nothing by a filter', async () => {
    const counter = recording();
    const hostHashes = hosts.map(md5);
    const started = performance.now();

    const endpoints = await counter.endpoints({
      scope: { hostHashes, to: now }, periods, rankBy: '30d', dailyFrom: new Date(now.getTime() - 13 * dayMs), timeoutMs: 30_000,
    });
    const tookMs = performance.now() - started;

    expect(endpoints).toHaveLength(20 * 100);
    expect(new Set(endpoints.map(endpoint => endpoint.hostHash)).size).toBe(20);
    expect(endpoints.find(endpoint => endpoint.path === '/v1/item/1' && endpoint.hostHash === md5('batch-0.example.com'))).toMatchObject({ price: 1_000n, method: 'GET' });
    expect(tookMs).toBeLessThan(3_000);
    expect(await nestedLoopFilters()).toEqual([]);
  }, 60_000);

  it('keeps today\'s buyers to its cap however many runs add lower ones', async () => {
    const counter = recording();
    const day = '2026-12-20';
    const [first, second] = [
      await counter.keepBuyers({ day, from: new Date('2026-12-15T00:00:00.000Z'), to: now, cap: 20, timeoutMs: 30_000 }),
      // A wider window: more buyers, some of them lower by hash than those kept
      await counter.keepBuyers({ day, from: new Date('2026-11-25T00:00:00.000Z'), to: now, cap: 20, timeoutMs: 30_000 }),
    ];
    const { rows } = await pool.query<{ count: number }>('select count(*)::int as count from stats_buyers where day = $1', [day]);

    expect([first, second, rows[0]!.count]).toEqual([20, 20, 20]);
  });

  it('joins nothing by a filter in any other statement of either count, a batch\'s or the platform\'s', async () => {
    const counter = recording();
    const scope = { hostHashes: hosts.map(md5), to: now };
    const all: readonly CountedPeriod[] = [{ period: 'all', from: undefined }];
    await counter.platform({ periods, to: now, timeoutMs: 30_000 });
    await counter.platform({ periods: all, to: now, timeoutMs: 30_000 });
    await counter.platformDays({ from: periods[2]!.from!, to: now, timeoutMs: 30_000 });
    await counter.minutes({ from: new Date(now.getTime() - 2 * dayMs), to: now, timeoutMs: 30_000 });
    await counter.top({ periods, to: now, timeoutMs: 30_000 });
    await counter.top({ periods: all, to: now, timeoutMs: 30_000 });
    await counter.topups({ periods: [...periods, ...all], to: now, timeoutMs: 30_000 });
    await counter.ranking({ from: periods[2]!.from!, to: now, limit: 1_000, timeoutMs: 30_000 });
    await counter.keepBuyers({ day: '2026-12-20', from: periods[0]!.from!, to: now, cap: 100_000, timeoutMs: 30_000 });
    await counter.services({ scope, periods, timeoutMs: 30_000 });
    await counter.services({ scope, periods: all, timeoutMs: 30_000 });
    await counter.endpoints({ scope, periods: all, rankBy: 'all', only: [{ hostHash: md5(hosts[0]!), pathHash: md5('/v1/item/1') }], dailyFrom: now, timeoutMs: 30_000 });
    await counter.serviceDays({ scope: { ...scope, from: periods[2]!.from! }, timeoutMs: 30_000 });
    await counter.callsIn({ scope, windows: [{ period: '7d', from: new Date('2026-12-07T00:00:00.000Z'), to: periods[1]!.from! }], timeoutMs: 30_000 });
    await counter.priceFrom({ hostHashes: scope.hostHashes, from: periods[2]!.from!, to: now, timeoutMs: 30_000 });
    await counter.endpointScope({ host: hosts[0]!, path: '/v1/item/1', from: periods[2]!.from!, cap: 10_000, timeoutMs: 30_000 });
    await counter.liveTail({ from: new Date(now.getTime() - 10 * 60_000), at: now, minutesFrom: new Date(now.getTime() - 30 * 60_000), timeoutMs: 30_000 });
    await counter.endpoints({
      scope: { endpoint: { host: hosts[0]!, path: '/v1/item/1', by: 'path' }, from: periods[2]!.from!, cap: 10_000 }, periods: [periods[2]!], rankBy: '30d', withFree: true,
      dailyFrom: periods[2]!.from!, maxPathLength: 2_048, timeoutMs: 30_000,
    });

    expect(await nestedLoopFilters()).toEqual([]);
  }, 60_000);
});
