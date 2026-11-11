import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '../../src/index.js';
import { loadLocalConfig } from '../../src/local/config.js';
import { seedLocal } from '../../src/local/seed.js';
import { defaultStackPorts, startLocalStack, type LocalStack } from '../../src/local/stack.js';

// The stack on a scratch database: every public answer is zero, the local database is not touched, and the
// scratch database is gone once the stack stops

let database: TestDatabase;
let redis: TestRedis;
let stack: LocalStack;
let stopped = false;

const freePorts = Object.fromEntries(Object.keys(defaultStackPorts).map(name => [name, 0]));
const tables = ['payments', 'call_details', 'routed_endpoints', 'checked_hosts', 'accounts', 'api_keys', 'topups', 'ledger_entries', 'stats_services', 'stats_answers', 'stats_buyers'];
const countRows = async (): Promise<Record<string, number>> => Object.fromEntries(await Promise.all(tables.map(async table =>
  [table, Number((await database.db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]?.n)] as const)));
const json = async (url: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(url);

  return { status: response.status, body: await response.json() };
};
const exists = async (name: string): Promise<boolean> =>
  (await database.db.execute(sql`select 1 from pg_database where datname = ${name}`)).rows.length > 0;

let before: Record<string, number>;

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  // The local database holds rows, as a developer's does
  await seedLocal({ postgres: database.postgres, config: await loadLocalConfig(), calls: 120 });
  before = await countRows();
  stack = await startLocalStack({ databaseUrl: database.url.expose(), redisUrl: redis.url.expose(), redisPrefix: redis.prefix, ports: freePorts, scratch: true });
}, 120_000);

afterAll(async () => {
  if (!stopped)
    await stack?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('the stack on a scratch database', () => {
  it('runs on a new database next to the local one, and every public answer is zero', async () => {
    expect(before['payments']).toBeGreaterThan(100);
    expect(stack.scratchDatabase).toMatch(/^anyfare_scratch_/);
    expect(await exists(stack.scratchDatabase!)).toBe(true);

    const stats = await json(`${stack.urls.api}/v1/stats`);
    const live = await json(`${stack.urls.api}/v1/stats/live`);
    const services = await json(`${stack.urls.api}/v1/services`);
    const calls = await json(`${stack.urls.api}/v1/calls`);
    expect(stats.body.calls).toEqual({ today: 0, '7d': 0, '30d': 0, all: 0 });
    expect(live.body.today).toMatchObject({ calls: 0, buyers: 0 });
    expect(services.body.services).toEqual([]);
    expect(calls.body.total).toBe(0);
    expect((await json(`${stack.urls.api}/v1/catalog`)).body.endpoints).toEqual([]);
  });

  it('leaves the local database as it was, a check and a paid call included', async () => {
    await fetch(`${stack.urls.pay}/_/check?url=${encodeURIComponent(`${stack.urls.paidApi}/base`)}`);
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(await countRows()).toEqual(before);
  });

  it('drops the scratch database, and only it, once the stack stops', async () => {
    const name = stack.scratchDatabase!;
    await stack.close();
    stopped = true;

    expect(await exists(name)).toBe(false);
    expect(await countRows()).toEqual(before);
    expect(await exists(database.name)).toBe(true);
  });
});
