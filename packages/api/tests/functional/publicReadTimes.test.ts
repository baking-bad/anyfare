import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { checkedHosts, hostBlocklist, paidHosts, routedEndpoints, statsAnswers, statsServices } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, type FakeClock, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';
import { catalogCacheMs } from '../../src/catalog/routes.js';
import { servicesCacheMs } from '../../src/stats/routes.js';

// The time an uncached public read of what routing listed takes, at the caps, with the names that cost the most:
// 1,000 stored services, 1,000 paid hosts the count doesn't store, half of them names of 122 labels a paid call may
// have, and a checked pool of 1,000 hosts with 20 endpoints each, every name of 8 labels of 30 characters, the most a
// check lists; and a blocklist of 200, a quarter of it naming parent domains of the pool. Measured here: the list
// 26 to 28 ms alone and up to 33 beside other tests, a page of the catalog 3 to 5 ms, whatever the names, the
// blocklist matched in the process. The bounds leave room for a slower machine.

const generous = { requests: 100_000, windowSeconds: 60 };
const noon = new Date('2026-11-20T12:00:00.000Z');
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
const at = (seconds: number): Date => new Date(noon.getTime() - seconds * 1_000);
// 8 labels of 30 characters, 247 in all, each of a parent domain of its own
const longName = (kind: string, index: number): string => [
  `${kind}-${index}`.padEnd(30, 'a'), ...Array.from({ length: 5 }, (_, label) => `label${label}`.padEnd(30, 'b')), `${kind}-${index}`.padEnd(30, 'p'), 'c'.repeat(30),
].join('.');
// 122 labels, as only a paid call lists
const deepName = (index: number): string => `${'a.'.repeat(120)}p${index}.ex`;

let database: TestDatabase;
let redis: TestRedis;
let clock: FakeClock;
let server: ApiServer;
let url: string;

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  const loaded = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
  const config: PlatformConfig = { ...loaded, rateLimits: { ...loaded.rateLimits, publicReads: generous, documents: generous } };
  const { db } = database;
  const insert = async <TRow>(rows: readonly TRow[], write: (batch: TRow[]) => Promise<unknown>): Promise<void> => {
    for (let index = 0; index < rows.length; index += 1_000)
      await write(rows.slice(index, index + 1_000));
  };
  const stored = Array.from({ length: config.stats.maxServices }, (_, index) => longName('stored', index));
  const paid = Array.from({ length: config.stats.maxServices }, (_, index) => (index % 2 === 0 ? longName('paid', index) : deepName(index)));
  const pooled = Array.from({ length: 1_000 }, (_, index) => longName('pool', index));
  await insert(stored, batch => db.insert(statsServices).values(batch.map((host, index) => ({
    hostHash: md5(host), host, paidEndpoints: 3, priceFrom: 1_000n, calls: 1_000 - index, buyers: 1, volume: 10_000n, successRate: 1, p50Ms: 100, trend: [],
    countedAt: noon, listedAt: at(86_400),
  }))));
  await insert(stored.flatMap(host => [0, 1, 2].map(path => ({ host, path }))), batch => db.insert(routedEndpoints).values(batch.map(({ host, path }) => ({
    host, path: `/v1/paid/${path}`, lastPrice: 1_000n, createdAt: at(86_400 + path), status: 'paid' as const,
  }))));
  await insert(paid, batch => db.insert(routedEndpoints).values(batch.map((host, index) => ({
    host, path: '/v1/paid', lastPrice: 1_000n, createdAt: at(3_600 + index), status: 'paid' as const,
  }))));
  await insert([...stored, ...paid].map((host, index) => ({ host, index })), batch => db.insert(paidHosts).values(batch.map(({ host, index }) => ({
    host, registeredAt: at(index), listedAt: at(86_400), paidEndpoints: index < stored.length ? 3 : 1, endpoints: index < stored.length ? 3 : 1, priceFrom: 1_000n,
  }))));
  await insert(pooled.flatMap(host => Array.from({ length: 20 }, (_, path) => ({ host, path }))), batch => db.insert(routedEndpoints).values(batch.map(({ host, path }) => ({
    host, path: `/v1/checked/${path}`, lastPrice: 2_000n, createdAt: at(path), status: 'checked' as const, checkedAt: at(path), checkMethod: 'GET' as const,
  }))));
  await insert(pooled.map((host, index) => ({ host, index })), batch => db.insert(checkedHosts).values(batch.map(({ host, index }) => ({
    host, parent: host.split('.').slice(-2).join('.'), listedAt: at(index), checkedAt: at(index), paidAt: null, checkedEndpoints: 20, priceFrom: 2_000n,
  }))));
  await db.insert(hostBlocklist).values([
    ...Array.from({ length: 150 }, (_, index) => ({ host: `blocked-${index}.example`, reason: 'abuse', createdAt: noon })),
    ...Array.from({ length: 50 }, (_, index) => ({ host: pooled[index * 20]!.split('.').slice(-2).join('.'), reason: 'abuse', createdAt: noon })),
  ]);
  await db.insert(statsAnswers).values([
    { key: 'services', answer: { services: 1_200, paidEndpoints: 3_000, calls30d: 500_000 }, countedAt: noon },
    { key: 'run:recent', answer: {}, countedAt: noon },
  ]);
  clock = createFakeClock(noon);
  server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock });
  url = `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
  await database.db.execute(sql`vacuum analyze`);
// Seeding takes longer than the default hook limit on a busy machine
}, 180_000);

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// An uncached read: past every cache in the process
const timed = async (path: string) => {
  clock.advance(Math.max(servicesCacheMs, catalogCacheMs));
  const started = performance.now();
  const response = await fetch(`${url}${path}`);
  const body = await response.json() as Record<string, unknown>;

  return { status: response.status, body, ms: performance.now() - started };
};

// Each of a few reads three times uncached, after one that warms the connection: its fastest is its own cost, without
// the waits of a busy machine running other tests beside it. The slowest of those.
const slowest = async (paths: readonly string[]) => {
  await timed(paths[0]!);
  const runs = [];
  for (const path of paths) {
    const tries = [await timed(path), await timed(path), await timed(path)];
    runs.push({ ...tries[2]!, ms: Math.min(...tries.map(each => each.ms)) });
  }

  return { runs, ms: Math.max(...runs.map(run => run.ms)) };
};

describe('an uncached public read at the caps, with the longest names and a blocklist of 200', () => {
  it('lists the services within 60 ms, sorted and searched in the process, and leaves out the 50 of blocked parents', async () => {
    const { runs, ms } = await slowest(['/v1/services', '/v1/services?sort=newest&size=100&page=5', '/v1/services?q=pool-9&sort=price', '/v1/services?sort=endpoints&page=30']);

    expect(runs.map(run => run.status)).toEqual([200, 200, 200, 200]);
    // 1,000 stored, 1,000 paid, and the pool's 1,000 but the 50 blocked
    expect(runs[0]!.body['totals']).toMatchObject({ services: 2_950, paidServices: 2_000 });
    expect(ms).toBeLessThan(60);
  });

  it('pages the catalog, deep or searched, within 25 ms each', async () => {
    const first = await timed('/v1/catalog?limit=100');
    let cursor = first.body['next'] as string;
    // Through to past most of it: each page read fresh
    for (let page = 0; page < 200 && cursor; page += 1)
      cursor = (await timed(`/v1/catalog?limit=100&cursor=${cursor}`)).body['next'] as string;
    const { runs, ms } = await slowest(['/v1/catalog?limit=100', '/v1/catalog?q=pool-999&limit=100', '/v1/catalog?maxPrice=0.0015&limit=100', '/v1/catalog?q=zzz&limit=100']);

    expect(runs.map(run => run.status)).toEqual([200, 200, 200, 200]);
    expect(runs[3]!.body).toMatchObject({ endpoints: [], partial: true });
    expect(ms).toBeLessThan(25);
  });
});
