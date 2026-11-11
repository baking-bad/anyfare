import { randomBytes } from 'node:crypto';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { endpointsPerService, loadPlatformConfig, maxListedPathLength, storedPathBytesPerService, type PlatformConfig } from '@anyfare/core';
import { callDetails, payments } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, fixtureTime, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { recentBudgetMs } from '../../src/publicStats.js';
import { statsApi, statsJobs } from '../support/stats.js';

// The frequent count at the defaults' worst: 1,000 services with 100 endpoints each, every path short, so
// each keeps all 100, or every path just under the longest the counts keep, so each keeps what its path
// budget holds. What they keep, write and hold stays within the stated bounds, a full count fits its
// budget, and so does the one after midnight, when every row's days move on.

// The collector, to measure what a run leaves behind
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const hostCount = 1_000;
const pathsPerHost = 100;
const mb = 1024 * 1024;

/** 1,000 services with 100 paid calls each, each to a path of its own of this length, on a database of their own. */
const flood = (pathLength: number) => {
  const clock = createFakeClock(fixtureTime(1, 10, 23, 50, 0, 0));
  let database: TestDatabase;
  let redis: TestRedis;
  let config: PlatformConfig;

  beforeAll(async () => {
    [database, redis, config] = await Promise.all([createTestDatabase(), createTestRedis(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } })]);
    const at = (index: number) => new Date(clock.now().getTime() - 60_000 - (index % 600) * 1_000);
    // A path that doesn't compress
    const path = (index: number) => `/v1/${index}/${randomBytes(pathLength).toString('base64url')}`.slice(0, pathLength);
    for (let host = 0; host < hostCount; host += 5) {
      const rows = Array.from({ length: 5 * pathsPerHost }, (_, offset) => {
        const index = host * pathsPerHost + offset;

        return {
          id: `pay_volume_${index}`, requestId: null, rail: 'x402' as const, buyerAccountId: null, keyId: null, targetHost: `host-${host + Math.floor(offset / pathsPerHost)}.example.com`,
          targetPath: path(index), network: 'eip155:84532', asset: 'base-usdc', atomicAmount: 1n, amount: 1n, fee: 0n, upstreamStatus: 200, upstreamLatencyMs: 40 + index % 100,
          status: 'settled' as const, transactionHash: null, receipt: null, settlementRequest: null, needsReview: false, createdAt: at(index), updatedAt: at(index),
        };
      });
      await database.db.insert(payments).values(rows);
      await database.db.insert(callDetails).values(rows.map((row, offset) => ({
        paymentId: row.id, method: 'GET', payer: `0x${String((host * pathsPerHost + offset) % 3_000).padStart(40, '0')}`, arrivedAt: row.createdAt,
      })));
    }
    await database.db.execute(sql`analyze`);
  // Seeding 100,000 calls takes a while
  }, 600_000);

  afterAll(async () => {
    await Promise.all([database?.drop(), redis?.cleanup()]);
  });

  const rows = async (table: string): Promise<number> => Number((await database.db.execute(sql`select count(*)::int as count from ${sql.identifier(table)}`)).rows[0]?.['count']);
  const bytes = async (): Promise<number> => Number((await database.db.execute(sql`select (pg_total_relation_size('stats_answers') + pg_total_relation_size('stats_services')
    + pg_total_relation_size('stats_service_pages') + pg_total_relation_size('stats_endpoints') + pg_total_relation_size('stats_buyers'))::bigint as size`)).rows[0]?.['size']);

  /** A run, with its time, how far the heap grew while it ran, and what it left behind once collected. */
  const measured = async (run: () => Promise<unknown>) => {
    gc();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sampling = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 5);
    const started = performance.now();
    try {
      const result = await run();
      const tookMs = performance.now() - started;
      gc();

      return { result, tookMs, peakMb: (peak - before) / mb, leftMb: (process.memoryUsage().heapUsed - before) / mb };
    }
    finally {
      clearInterval(sampling);
    }
  };

  return {
    clock,
    run: async () => {
      const { maxServices } = config.stats;
      const jobs = statsJobs(database.db, config, clock);
      clock.set(fixtureTime(1, 10, 23, 50, 0, 0));

      const first = await measured(() => jobs.recent());
      const stored = { services: await rows('stats_services'), pages: await rows('stats_service_pages'), endpoints: await rows('stats_endpoints') };
      const pathBytes = Number((await database.db.execute(sql`select max(total)::int as total from (select sum(length(path)) as total from stats_endpoints group by host_hash) as hosts`))
        .rows[0]?.['total']);
      const storedMb = await bytes() / mb;
      const served = await statsApi(database.postgres, redis, config, clock).get('/v1/services/host-0.example.com?period=30d');
      // Nothing new: nothing written
      const again = await measured(() => jobs.recent());
      // After midnight every row's days move on: all of them written again
      clock.set(fixtureTime(1, 11, 0, 5, 0, 0));
      const midnight = await measured(() => jobs.recent());
      const report = {
        stored, pathBytes, storedMb: Math.round(storedMb), servedKb: Math.round(served.text.length / 1024),
        runs: [first, again, midnight].map(run => ({ tookMs: Math.round(run.tookMs), peakMb: Math.round(run.peakMb), leftMb: Math.round(run.leftMb) })),
      };
      console.info(JSON.stringify(report));

      expect(served.status).toBe(200);
      // A served service answer stays under about 100 KB
      expect(served.text.length).toBeLessThan(100 * 1024);
      expect(pathBytes).toBeLessThanOrEqual(storedPathBytesPerService);
      expect(stored.services).toBe(maxServices);
      expect(stored.pages).toBe(3 * maxServices);
      expect(again.result).toMatchObject({ written: 0, deleted: 0 });
      expect(midnight.result).toMatchObject({ services: maxServices, written: stored.services + stored.pages + stored.endpoints });
      for (const run of [first, again, midnight]) {
        expect(run.tookMs).toBeLessThan(recentBudgetMs / 2);
        // The peak holds garbage the collector hasn't taken yet, so it moves with the machine. What a run keeps
        // is the next line. An unbounded count grows past this by a wide margin.
        expect(run.peakMb).toBeLessThan(512);
        expect(run.leftMb).toBeLessThan(32);
      }

      return { stored, storedMb };
    },
  };
};

describe('the frequent count with 1,000 services of 100 short paths', () => {
  const short = flood(40);

  it('keeps all 100 endpoints of each, within its bytes, heap and budget, after midnight too', async () => {
    const { stored, storedMb } = await short.run();

    expect(stored.endpoints).toBe(hostCount * endpointsPerService);
    expect(storedMb).toBeLessThan(150);
  }, 600_000);
});

describe('the frequent count with 1,000 services of 100 paths just under the longest kept', () => {
  const long = flood(maxListedPathLength - 2);

  it('keeps what each one\'s path budget holds, within its bytes, heap and budget, after midnight too', async () => {
    const { stored, storedMb } = await long.run();

    expect(stored.endpoints).toBe(hostCount * Math.floor(storedPathBytesPerService / (maxListedPathLength - 2)));
    expect(storedMb).toBeLessThan(150);
  }, 600_000);
});
