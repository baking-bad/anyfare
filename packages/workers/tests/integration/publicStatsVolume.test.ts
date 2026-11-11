import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { endpointsPerService, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { callDetails, payments } from '@anyfare/db';
import { createFakeClock, createTestDatabase, fixtureTime, type TestDatabase } from '@anyfare/testing';

import { statsJobs } from '../support/stats.js';

// The counts at volume: one host with 20,000 paid calls, each to its own path of 4 KB, which the buyer pays
// little for, and 5,000 other hosts. What they keep, write and hold stays within the stated bounds.

const clock = createFakeClock(fixtureTime(1, 10, 12, 0, 0, 0));
const flooded = 'flood.example.com';
const floodCalls = 20_000;
const otherHosts = 5_000;
const mb = 1024 * 1024;

let database: TestDatabase;
let config: PlatformConfig;

beforeAll(async () => {
  [database, config] = await Promise.all([createTestDatabase(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } })]);
  const at = (index: number) => new Date(clock.now().getTime() - 60_000 - index * 1_000);
  const call = (index: number, host: string, path: string) => ({
    id: `pay_volume_${index}`, requestId: null, rail: 'x402' as const, buyerAccountId: null, keyId: null, targetHost: host, targetPath: path, network: 'eip155:84532',
    asset: 'base-usdc', atomicAmount: 1n, amount: 1n, fee: 0n, upstreamStatus: 200, upstreamLatencyMs: 40 + index % 100, status: 'settled' as const,
    transactionHash: null, receipt: null, settlementRequest: null, needsReview: false, createdAt: at(index), updatedAt: at(index),
  });
  const rows = [
    ...Array.from({ length: floodCalls }, (_, index) => call(index, flooded, `/v1/${randomBytes(3_000).toString('base64url')}`)),
    // Each other host: two calls on one short path
    ...Array.from({ length: otherHosts * 2 }, (_, index) => call(floodCalls + index, `host-${Math.floor(index / 2)}.example.com`, '/v1/quote')),
  ];
  for (let index = 0; index < rows.length; index += 500) {
    const batch = rows.slice(index, index + 500);
    await database.db.insert(payments).values(batch);
    await database.db.insert(callDetails).values(batch.map((row, offset) => ({
      paymentId: row.id, method: 'GET', payer: `0x${String((index + offset) % 3_000).padStart(40, '0')}`, arrivedAt: row.createdAt,
    })));
  }
  await database.db.execute(sql`analyze`);
// Seeding 30,000 calls, 80 MB of them paths, takes a while
}, 300_000);

afterAll(async () => {
  await database?.drop();
});

const rows = async (table: string): Promise<number> => Number((await database.db.execute(sql`select count(*)::int as count from ${sql.identifier(table)}`)).rows[0]?.['count']);
const bytes = async (): Promise<number> => Number((await database.db.execute(sql`select (pg_total_relation_size('stats_answers') + pg_total_relation_size('stats_services')
  + pg_total_relation_size('stats_service_pages') + pg_total_relation_size('stats_endpoints') + pg_total_relation_size('stats_buyers'))::bigint as size`)).rows[0]?.['size']);

describe('the public numbers\' counts at volume', () => {
  it('keep the configured number of services, never a path past 2,048 characters, and stay within their rows, bytes, heap and time', async () => {
    const { maxServices } = config.stats;
    const jobs = statsJobs(database.db, config, clock);
    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    const sampling = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 5);
    const started = performance.now();
    try {
      await jobs.recent();
      await jobs.all();
    }
    finally {
      clearInterval(sampling);
    }
    const tookMs = performance.now() - started;

    // The hard bounds: the platform's few answers, and per stored service its row, 4 pages and at most 100 endpoints
    const stored = { services: await rows('stats_services'), pages: await rows('stats_service_pages'), endpoints: await rows('stats_endpoints') };
    expect(stored.services).toBe(maxServices);
    expect(stored.pages).toBeLessThanOrEqual(4 * maxServices);
    expect(stored.endpoints).toBeLessThanOrEqual(endpointsPerService * maxServices);
    expect(await rows('stats_answers')).toBeLessThanOrEqual(11);
    // None of the flooded host's 20,000 paths is kept: each is longer than the endpoint read takes
    expect(Number((await database.db.execute(sql`select count(*)::int as count from stats_endpoints where host_hash = md5(${flooded})`)).rows[0]?.['count'])).toBe(0);
    expect(Number((await database.db.execute(sql`select max(length(path))::int as length from stats_endpoints`)).rows[0]?.['length'])).toBeLessThanOrEqual(2_048);
    // Yet every call is counted
    const page = (await database.db.execute(sql`select answer from stats_service_pages where host_hash = md5(${flooded}) and period = '30d'`)).rows[0]?.['answer'] as {
      stats: { calls: number }; paidEndpoints: number;
    };
    expect([page.stats.calls, page.paidEndpoints]).toEqual([floodCalls, floodCalls]);
    expect(await bytes()).toBeLessThan(20 * mb);
    expect(peak - baseline).toBeLessThan(150 * mb);
    expect(tookMs).toBeLessThan(60_000);

    // A second run with nothing new writes nothing
    expect(await jobs.recent()).toMatchObject({ written: 0, deleted: 0 });
  }, 180_000);
});
