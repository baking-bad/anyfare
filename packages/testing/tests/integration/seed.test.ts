import { sql } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, type Server } from '@anyfare/common';
import type { PlatformConfig } from '@anyfare/core';
import { statsServices } from '@anyfare/db';
import { createApp } from '@anyfare/api';

import { createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '../../src/index.js';
import { loadLocalConfig } from '../../src/local/config.js';
import { emptyLocal, seedLocal, type SeedSummary } from '../../src/local/seed.js';
import { longHost, seededHosts, seedRequestPrefix, veryLongPath } from '../../src/local/seedData.js';

// The seed on a database of its own, read through the Platform API's public answers

const slow = 180_000;

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let api: Server;
let url: string;
let summary: SeedSummary;

const rows = async <TRow extends QueryResultRow>(query: ReturnType<typeof sql>): Promise<readonly TRow[]> =>
  (await database.db.execute<TRow>(query)).rows as readonly TRow[];
const count = async (query: ReturnType<typeof sql>): Promise<number> => Number((await rows<{ n: number }>(query))[0]?.n);
const read = async (path: string): Promise<{ status: number; text: string; body: any }> => {
  const response = await fetch(`${url}${path}`);
  const text = await response.text();

  return { status: response.status, text, body: JSON.parse(text) };
};

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  config = await loadLocalConfig();
  summary = await seedLocal({ postgres: database.postgres, config });
  api = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis });
  url = `http://127.0.0.1:${(await api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
}, slow);

afterAll(async () => {
  await api?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('the seed', () => {
  it('makes about 2,000 calls to 9 services, most on NEAR, with every way to pay', () => {
    expect(summary.calls).toBeGreaterThan(1_900);
    expect(summary.calls).toBeLessThan(2_100);
    expect(summary.services).toBe(seededHosts.length);
    expect(Object.keys(summary.callsByWay).sort()).toEqual(['credits', 'mpp eip155:42431', 'x402 eip155:84532', 'x402 near:testnet', 'x402 solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1']);
    const [most] = Object.entries(summary.callsByWay).sort((a, b) => b[1] - a[1]);
    expect(most![0]).toBe('x402 near:testnet');
    expect(Object.values(summary.callsByWay).reduce((sum, calls) => sum + calls, 0)).toBe(summary.calls);
    expect(summary.freeCalls / summary.calls).toBeGreaterThan(0.02);
    expect(summary.freeCalls / summary.calls).toBeLessThan(0.07);
  });

  it('counts the way each call was paid in the database too', async () => {
    const byWay = await rows<{ way: string; n: number }>(sql`
      select (case when rail = 'credits' then 'credits' else rail || ' ' || network end) as way, count(*)::int as n from payments group by 1`);

    expect(Object.fromEntries(byWay.map(row => [row.way, row.n]))).toEqual(summary.callsByWay);
  });

  it('balances the ledger: every transaction sums to zero, every balance is its entries, and all balances sum to zero', async () => {
    expect(await count(sql`select count(*) as n from (select transaction_id from ledger_entries group by 1 having sum(amount) <> 0) as unbalanced`)).toBe(0);
    expect(await count(sql`
      select count(*) as n from balances b
      where b.balance <> coalesce((select sum(amount) from ledger_entries e where e.ledger_account_id = b.ledger_account_id), 0)`)).toBe(0);
    expect(await count(sql`select coalesce(sum(balance), 0) as n from balances`)).toBe(0);
    expect(await count(sql`select count(*) as n from balances where balance < 0 and not may_go_negative`)).toBe(0);
    expect(await count(sql`select count(*) as n from ledger_transactions`)).toBeGreaterThan(2_000);
  });

  it('writes top-ups in every state, the credited ones booked in the ledger', async () => {
    const states = await rows<{ status: string; n: number }>(sql`select status, count(*)::int as n from topups group by status`);

    expect(states.map(row => row.status).sort()).toEqual(
      ['credited', 'expired', 'failed', 'incomplete', 'processing', 'quote_failed', 'quote_unknown', 'quoting', 'refunded', 'waiting'],
    );
    expect(await count(sql`select count(*) as n from topups`)).toBeGreaterThanOrEqual(14);
    expect(await count(sql`select count(*) as n from topups where status = 'credited' and ledger_transaction_id is not null`))
      .toBe(Number(states.find(row => row.status === 'credited')!.n));
  });

  it('registers each endpoint with its last price, and keeps the very long path and host', async () => {
    expect(await count(sql`select count(*) as n from routed_endpoints where last_price is not null and status = 'paid'`)).toBe(summary.endpoints - 1);
    expect(await count(sql`select count(*) as n from payments where length(target_path) = ${veryLongPath.length}`)).toBe(1);
    expect(longHost).toHaveLength(200);
    expect(await count(sql`select count(*) as n from payments where target_host = ${longHost}`)).toBeGreaterThan(0);
  });

  it('keeps a few calls without details, and chain payers that are many, some with one call, some on several days', async () => {
    expect(await count(sql`select count(*) as n from payments p where not exists (select 1 from call_details d where d.payment_id = p.id)`)).toBeGreaterThan(10);
    const payers = await rows<{ network: string; payers: number; single: number; multiday: number }>(sql`
      select network, count(*)::int as payers, (count(*) filter (where calls = 1))::int as single, (count(*) filter (where days > 1))::int as multiday from (
        select p.network, d.payer, count(*) as calls, count(distinct date_trunc('day', p.created_at)) as days
        from payments p join call_details d on d.payment_id = p.id where p.rail <> 'credits' and d.payer is not null group by 1, 2) as grouped
      group by network`);

    expect(payers).toHaveLength(4);
    for (const row of payers) {
      expect(row.payers).toBeGreaterThan(50);
      expect(row.single).toBeGreaterThan(5);
      expect(row.multiday).toBeGreaterThan(5);
    }
  });

  it('answers the public reads with data', async () => {
    const stats = await read('/v1/stats');
    const live = await read('/v1/stats/live');
    const top = await read('/v1/stats/top?period=30d');
    const services = await read('/v1/services?size=50');
    const calls = await read('/v1/calls?size=20');
    const service = await read('/v1/services/api.example.com?period=30d');

    for (const answer of [stats, live, top, services, calls, service])
      expect(answer.status).toBe(200);
    expect(stats.body.allUpdatedAt).not.toBeNull();
    expect(JSON.stringify(stats.body)).toContain('near');
    expect(live.body).toBeTruthy();
    expect(top.body.services.length).toBeGreaterThan(0);
    expect(services.body.services.length).toBeGreaterThanOrEqual(8);
    expect(services.body.services.map((item: { host: string }) => item.host)).toContain('api.example.com');
    expect(calls.body.calls).toHaveLength(20);
    expect(calls.body.total).toBeGreaterThan(1_900);
    expect(service.body.endpoints.length).toBeGreaterThanOrEqual(6);
    // The path too long to list is counted in the totals and never listed
    expect(service.body.endpoints.every((endpoint: { path: string }) => endpoint.path.length <= 2_048)).toBe(true);
    expect(service.text).not.toContain('xxxxxxxxxx');
  });

  it('has numbers for today, the last minutes, and the daily chart', async () => {
    const stats = (await read('/v1/stats')).body;
    const live = (await read('/v1/stats/live')).body;

    expect(stats.calls.today).toBeGreaterThan(30);
    expect(stats.calls['30d']).toBeGreaterThan(1_800);
    expect(stats.daily.filter((day: { calls: number }) => day.calls > 0).length).toBeGreaterThanOrEqual(28);
    expect(live.perMinute.reduce((sum: number, minute: { calls: number }) => sum + minute.calls, 0)).toBeGreaterThan(5);
    expect(live.today.calls).toBeGreaterThan(30);
  });

  it('names no Credits account in any public answer', async () => {
    const ids = (await rows<{ id: string }>(sql`select id from accounts`)).map(row => row.id);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    const { rows: found } = await database.db.execute<{ id: string }>(sql`select id from payments order by created_at desc limit 3`);
    const paths = [
      '/v1/stats', '/v1/stats/live', '/v1/stats/top?period=30d', '/v1/stats/top?period=all', '/v1/services?size=50', '/v1/services/api.example.com?period=30d',
      '/v1/services/data.example.org?period=all', '/v1/calls?size=100', '/v1/calls?paidWith=credits&size=100', '/v1/endpoints/stats?host=api.example.com&path=%2Fv1%2Fmarkets&period=30d',
      ...found.map(row => `/v1/calls/${row.id}`),
    ];
    const credits = await rows<{ id: string }>(sql`select id from payments where rail = 'credits' order by created_at desc limit 3`);
    for (const path of [...paths, ...credits.map(row => `/v1/calls/${row.id}`)]) {
      const { text } = await read(path);
      for (const id of ids)
        expect(text, path).not.toContain(id);
      expect(text, path).not.toContain('acc_');
      expect(text, path).not.toContain(seedRequestPrefix);
    }
  });

  it('can run again without duplicating, and --empty removes what it wrote', async () => {
    const before = await count(sql`select count(*) as n from payments`);
    const again = await seedLocal({ postgres: database.postgres, config, now: new Date(), calls: 300 });

    expect(again.calls).toBeGreaterThan(250);
    expect(await count(sql`select count(*) as n from payments`)).toBe(again.calls);
    expect(before).toBeGreaterThan(again.calls);
    expect(await count(sql`select count(*) as n from accounts`)).toBe(again.accounts);

    await emptyLocal({ postgres: database.postgres, config });

    for (const table of ['payments', 'call_details', 'target_payments', 'signatures', 'topups', 'ledger_transactions', 'ledger_entries', 'accounts', 'api_keys', 'routed_endpoints', 'checked_hosts', 'stats_buyers'])
      expect(await count(sql.raw(`select count(*) as n from ${table}`)), table).toBe(0);
    expect(await count(sql`select coalesce(sum(abs(balance)), 0) as n from balances`)).toBe(0);
    expect(await count(sql`select count(*) as n from balances b where not exists (select 1 from ledger_accounts a where a.id = b.ledger_account_id)`)).toBe(0);
    const stats = (await read('/v1/stats')).body;
    expect(stats.calls.all).toBe(0);
    expect((await read('/v1/services')).body.services).toEqual([]);
    expect(await database.db.select().from(statsServices)).toEqual([]);
  }, slow);
});
