import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@anyfare/common';
import { hashApiKey, loadPlatformConfig, type JsonObject, type PlatformConfig } from '@anyfare/core';
import * as db from '@anyfare/db';
import {
  createAccountRepository, createCallRepository, createLedger, createPaymentKeyRepository, createPaymentRepository, createRoutingRepository, type Database, type Ledger,
} from '@anyfare/db';
import { createFakeClock, createFakeIdGenerator, createTestDatabase, createTestRedis, fixtureTime, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { PublicStatsBudgetError } from '../../src/publicStats.js';
import { RunStoppedError } from '../../src/scheduler.js';
import { seedCall, statsApi, statsJobs } from '../support/stats.js';

// What the counts must take: a path of any length and the longest host, through the ledger; at most 100
// endpoints a service and the configured number of services; statements on their own, each bounded, on
// one connection at a time; and tables that never hold what names a buyer or a routed call's query.

const clock = createFakeClock(fixtureTime(0, 20, 12, 0, 0, 0));
const accountId = 'acc_limits_5c1d';
const keyId = 'key_limits_7e2f';
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
// About 6,000 characters that don't compress: longer than the endpoint read takes
const longPath = `/v1/${randomBytes(4_500).toString('base64url')}`;
// The longest host routing keeps: a name of 253 characters and a port of 5 digits
const longHost = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}:65535`;

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let ledger: Ledger;
let api: ReturnType<typeof statsApi>;
let counter = 0;

beforeAll(async () => {
  [database, redis, config] = await Promise.all([createTestDatabase(), createTestRedis(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } })]);
  const { db: database_ } = database;
  ledger = createLedger({ db: database_, clock, ids: createFakeIdGenerator('limits-') });
  api = statsApi(database.postgres, redis, config, clock);
  await createAccountRepository({ db: database_ }).create({ id: accountId, createdAt: clock.now() });
  await createPaymentKeyRepository({ db: database_ }).insert({
    id: keyId, accountId, keyHash: hashApiKey(Secret.from('af_test_limits')), label: undefined, createdAt: clock.now(), allowance: undefined,
    dailyBudget: 50_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
  await ledger.credit({ accountId, amount: 10_000_000n, reference: 'credit-limits' });
});

afterAll(async () => {
  await api?.server.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// The counts run a moment after the calls they count, as they would: a count counts to before its own time
const jobs = (changes: Parameters<typeof statsJobs>[3] = {}, on: Database = database.db) => {
  clock.advance(1_000);

  return statsJobs(on, config, clock, changes);
};

// What the proxy records once the API is paid: the leg the buyer is charged for
const paidLeg = async (paymentId: string): Promise<void> => {
  const routing = createRoutingRepository({ db: database.db, clock });
  await routing.recordTargetPayment({
    paymentId, protocol: 'x402', network: 'eip155:84532', asset: 'base-usdc', amount: 1_000n, atomicAmount: 1_000n,
    payTo: '0x4444444444444444444444444444444444444444', signatureId: `sig-${paymentId}`,
  });
  await routing.updateTargetPayment(paymentId, { status: 'settled' });
};

/** A Credits call held and captured through the ledger, with its details. */
const creditsCall = async (host: string, path: string): Promise<string> => {
  counter += 1;
  const id = `pay_limits_${counter}`;
  const held = await ledger.hold({
    payment: {
      id, requestId: `req-${id}`, rail: 'credits', buyerAccountId: accountId, keyId, targetHost: host, targetPath: path, network: undefined, asset: undefined,
      atomicAmount: undefined, amount: 1_100n,
    },
    dailyBudget: 50_000_000n,
    allowance: undefined,
  });
  expect(held.ok).toBe(true);
  await createCallRepository({ db: database.db }).recordDetails({ paymentId: id, method: 'GET', payer: undefined, arrivedAt: clock.now() });
  await paidLeg(id);
  await createPaymentRepository({ db: database.db, clock }).recordDecision({ paymentId: id, decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 90 });
  expect((await ledger.capture({ paymentId: id })).payment.status).toBe('captured');

  return id;
};

/** A chain call verified, settling and settled, as the rail moves it. */
const chainCall = async (host: string, path: string, settlementRequest: JsonObject): Promise<string> => {
  counter += 1;
  const id = `pay_limits_${counter}`;
  const payments = createPaymentRepository({ db: database.db, clock });
  await payments.create({
    id, requestId: `req-${id}`, rail: 'x402', buyerAccountId: undefined, keyId: undefined, targetHost: host, targetPath: path, network: 'eip155:84532',
    asset: 'base-usdc', atomicAmount: 1_100n, amount: 1_100n, status: 'verified',
  });
  await createCallRepository({ db: database.db }).recordDetails({ paymentId: id, method: 'POST', payer: '0x7777777777777777777777777777777777777777', arrivedAt: clock.now() });
  await payments.changeStatus({ paymentId: id, to: 'settling', from: 'verified', settlementRequest });
  await paidLeg(id);
  const settled = await ledger.settle({ paymentId: id, asset: 'base-usdc', transactionHash: `0x${'ef'.repeat(32)}`, receipt: 'token=secret-in-receipt', needsReview: false });
  expect(settled.payment.status).toBe('settled');

  return id;
};

// Every row of the counts' tables, as text
const tablesText = async (): Promise<string> => {
  const { rows } = await database.db.execute(sql`select concat_ws(' ',
    (select coalesce(json_agg(t), '[]') from stats_answers t)::text, (select coalesce(json_agg(t), '[]') from stats_services t)::text,
    (select coalesce(json_agg(t), '[]') from stats_service_pages t)::text, (select coalesce(json_agg(t), '[]') from stats_endpoints t)::text,
    (select coalesce(json_agg(t), '[]') from stats_buyers t)::text) as text`);

  return String(rows[0]?.['text']);
};

const count = async (table: string, where = sql`true`): Promise<number> =>
  Number((await database.db.execute(sql`select count(*)::int as count from ${sql.identifier(table)} where ${where}`)).rows[0]?.['count']);

describe('the public numbers\' counts, on what a buyer controls', () => {
  it('take a 6,000-character path and a 259-character host through the ledger, and count the path without storing, listing or linking it', async () => {
    expect([longPath.length, longHost.length]).toEqual([6_004, 259]);
    await creditsCall(longHost, longPath);
    await chainCall(longHost, longPath, { resource: `https://${longHost}${longPath}?token=secret-in-query` });
    await chainCall(longHost, '/v1/short', {});

    await jobs().recent();
    await jobs().all();

    const service = (await api.get<{ stats: { calls: number; buyers: number }; paidEndpoints: number; endpoints: { path: string }[] }>(`/v1/services/${longHost}`)).body;
    expect(service.stats).toMatchObject({ calls: 3, buyers: 2 });
    expect(service.paidEndpoints).toBe(2);
    expect(service.endpoints.map(endpoint => endpoint.path)).toEqual(['/v1/short']);
    expect((await api.get<{ calls: Record<string, number> }>('/v1/stats')).body.calls).toMatchObject({ today: 3, all: 3 });
    const tables = await tablesText();
    expect(tables).toContain(longHost);
    expect(tables).not.toContain(longPath.slice(0, 100));
    expect((await api.get(`/v1/endpoints/stats?host=${longHost}&path=${longPath}`)).status).toBe(400);
  });

  it('keep at most 100 endpoints a service, by paid calls, and list them, while counting every one', async () => {
    const host = 'many.example.com';
    for (let index = 0; index < 150; index += 1) {
      for (let call = 0; call < (index < 10 ? 2 : 1); call += 1)
        await seedCall(database.db, { host, path: `/v1/item/${index}`, at: fixtureTime(0, 20, 9, 0, index, call), way: 'base', status: 'settled', ms: 50, payer: '0x2222222222222222222222222222222222222222', method: 'GET' });
    }

    await jobs().recent();

    expect(await count('stats_endpoints', sql`host_hash = ${md5(host)}`)).toBe(100);
    const service = (await api.get<{ paidEndpoints: number; endpoints: { path: string; calls: number }[]; stats: { calls: number } }>(`/v1/services/${host}`)).body;
    expect([service.paidEndpoints, service.endpoints.length, service.stats.calls]).toEqual([150, 100, 160]);
    // The ten with two calls first
    expect(service.endpoints.slice(0, 10).every(endpoint => endpoint.calls === 2)).toBe(true);
    // One not kept is read when asked for
    const kept = new Set(service.endpoints.map(endpoint => endpoint.path));
    const other = Array.from({ length: 150 }, (_, index) => `/v1/item/${index}`).find(path => !kept.has(path))!;
    expect((await api.get(`/v1/endpoints/stats?host=${host}&path=${other}`)).body).toMatchObject({ stats: { calls: 1 }, exact: true });
  });

  it('keep no account ID, key ID, their md5, request ID or query string in its tables', async () => {
    await chainCall('private.example.com', '/v1/pools', { resource: 'https://private.example.com/v1/pools?token=secret-in-query', body: 'secret-in-body' });
    await creditsCall('private.example.com', '/v1/pools');

    await jobs().recent();
    await jobs().all();

    const text = await tablesText();
    expect(text).toContain('private.example.com');
    // The kept buyers hold the Credits buyer in this form only, which no answer may show
    expect(text).toContain(md5(`account:${md5(accountId)}`));
    for (const secret of [accountId, keyId, md5(accountId), md5(keyId), 'req-pay_limits', 'secret-in-query', 'secret-in-body', 'secret-in-receipt', 'token='])
      expect(text, secret).not.toContain(secret);
  });

  it('show no account ID, key ID, their md5 or a routed call\'s query string in any answer of what they counted', async () => {
    const periods = ['today', '7d', '30d', 'all'];
    const paths = [
      '/v1/stats', '/v1/stats/live', '/v1/services', '/v1/services?q=private',
      ...periods.flatMap(period => [`/v1/stats/top?period=${period}`, `/v1/services/private.example.com?period=${period}`,
        `/v1/endpoints/stats?host=private.example.com&path=/v1/pools&period=${period}`]),
    ];

    for (const path of paths) {
      const answer = await api.get(path);
      expect(answer.status, path).toBe(200);
      // The account's md5, and the form the kept buyers hold
      for (const secret of [accountId, keyId, md5(accountId), md5(keyId), md5(`account:${md5(accountId)}`), 'secret-in-query', 'secret-in-body', 'secret-in-receipt', 'token='])
        expect(answer.text, `${path} ${secret}`).not.toContain(secret);
    }
    // Counted as a buyer, never named
    const service = (await api.get<{ stats: { buyers: number }; topBuyers: { buyers: { payer: string | null; paidWith: string }[] } }>('/v1/services/private.example.com')).body;
    expect(service.stats.buyers).toBe(2);
    expect(service.topBuyers.buyers.find(buyer => buyer.paidWith === 'credits')?.payer).toBeNull();
  });

  it('count chain payments with no known payer as one buyer per network, who never returns and is never a top buyer', async () => {
    const host = 'unknown.example.com';
    // Each network's unknown payers on two days, and one known payer on one
    for (const [way, at] of [['base', fixtureTime(0, 19, 9)], ['base', fixtureTime(0, 20, 9)], ['near', fixtureTime(0, 19, 10)], ['near', fixtureTime(0, 20, 10)]] as const)
      await seedCall(database.db, { host, path: '/v1/old', at, way, status: 'settled', ms: 80 });
    await seedCall(database.db, { host, path: '/v1/old', at: fixtureTime(0, 20, 11), way: 'base', status: 'settled', ms: 80, payer: '0x6666666666666666666666666666666666666666', method: 'GET' });

    await jobs().recent();

    const service = (await api.get<{ stats: Record<string, unknown>; byPaidWith: { buyers: number }[]; topBuyers: { buyers: { payer: string }[] } }>(`/v1/services/${host}?period=7d`)).body;
    expect(service.stats).toMatchObject({ calls: 5, buyers: 3, returningShare: 0 });
    expect(service.byPaidWith.map(way => way.buyers)).toEqual([2, 1]);
    expect(service.topBuyers.buyers.map(buyer => buyer.payer)).toEqual(['0x6666666666666666666666666666666666666666']);
  });
});

describe('the public numbers\' counts, next to the payments', () => {
  it('keep pages for the configured number of services, delete the rows of one that left, and read that one when asked for', async () => {
    const before = await count('stats_services');
    expect(before).toBeGreaterThan(1);

    await jobs({ config: { ...config, stats: { ...config.stats, maxServices: 1 } } }).recent();

    expect([await count('stats_services'), await count('stats_service_pages', sql`period <> 'all'`)]).toEqual([1, 3]);
    expect(await count('stats_endpoints', sql`host_hash not in (select host_hash from stats_services)`)).toBe(0);
    // Past the few seconds the API keeps a page of the list in its process
    clock.advance(10_000);
    const listed = (await api.get<{ services: { host: string }[]; totalCapped: boolean; totals: { services: number; calls30d: number } }>('/v1/services')).body;
    // The totals count what the list shows; more services had a paid call, and their calls are counted
    expect([listed.services.length, listed.totalCapped, listed.totals.services]).toEqual([1, true, 1]);
    expect(listed.totals.calls30d).toBeGreaterThan(5);
    expect((await api.get('/v1/services/unknown.example.com?period=7d')).body).toMatchObject({ stats: { calls: 5, buyers: 3 }, exact: true });
    await jobs().recent();
  });

  it('fill the rows of paid hosts registered before their table, a batch at a time each run, so the list shows them', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const hosts = Array.from({ length: 3 }, (_, index) => `before-table-${index}.example.com`);
    await database.db.insert(db.routedEndpoints).values(hosts.map(host => ({ host, path: '/v1/x', lastPrice: 1_000n, createdAt: clock.now(), status: 'paid' as const })));
    await database.db.delete(db.paidHosts);
    await database.db.delete(db.statsAnswers).where(sql`key = 'backfill:paid_hosts'`);
    const batches: number[] = [];
    const recording = { backfillPaidHosts: async (input: { readonly batch: number; readonly timeoutMs: number }) => {
      const result = await routing.backfillPaidHosts({ ...input, batch: 2 });
      batches.push(result.hosts);

      return result;
    } };

    await statsJobs(database.db, config, clock, { routing: recording }).recent();

    expect(await count('paid_hosts', sql`host like 'before-table-%'`)).toBe(3);
    // Two, then the last one, and done
    expect(batches).toEqual([2, 1]);
    clock.advance(10_000);
    const listed = (await api.get<{ services: { host: string; status: string; calls: number }[] }>('/v1/services?q=before-table')).body;
    expect(listed.services.map(service => [service.host, service.status, service.calls])).toEqual(hosts.map(host => [host, 'paid', 0]));
    // Done: a later run reads its mark alone
    batches.length = 0;
    await statsJobs(database.db, config, clock, { routing: recording }).recent();
    expect(batches).toEqual([0]);
  });

  it('run each statement on its own: a call written between two is seen by the later one', async () => {
    const { options } = jobs();
    const counter = {
      ...options.counter,
      platform: async (input: Parameters<typeof options.counter.platform>[0]) => {
        const counted = await options.counter.platform(input);
        await seedCall(database.db, { host: 'between.example.com', path: '/v1/x', at: fixtureTime(0, 20, 11, 0, 0, 0), way: 'base', status: 'settled', ms: 10, payer: '0x3333333333333333333333333333333333333333', method: 'GET' });

        return counted;
      },
    };

    await jobs({ counter }).recent();

    // Ranked, and given a row and pages of its own, by statements that ran after it was written
    expect(await count('stats_services', sql`host = 'between.example.com'`)).toBe(1);
    expect((await api.get('/v1/services/between.example.com')).body).toMatchObject({ stats: { calls: 1 }, exact: true });
  });

  it('run on one connection at a time: a pool of one is enough', async () => {
    const pool = new pg.Pool({ connectionString: database.url.expose(), max: 1, connectionTimeoutMillis: 2_000 });
    try {
      const on = drizzle({ client: pool, schema: db }) as unknown as Database;
      const result = await jobs({}, on).recent();
      await jobs({}, on).all();

      expect(result.services).toBeGreaterThan(0);
    }
    finally {
      await pool.end();
    }
  });

  it('give up on a statement after its timeout, waiting on a lock included', async () => {
    const blocker = new pg.Client({ connectionString: database.url.expose() });
    await blocker.connect();
    try {
      await blocker.query('begin');
      await blocker.query('lock table payments in access exclusive mode');
      const started = performance.now();

      const error = await jobs({ timeoutMs: 300 }).recent().catch((thrown: unknown) => thrown) as { code?: string; cause?: { code?: string } };

      // 57014: the statement was cancelled by its timeout
      expect(error.cause?.code ?? error.code).toBe('57014');
      expect(performance.now() - started).toBeLessThan(5_000);
    }
    finally {
      await blocker.query('rollback');
      await blocker.end();
    }
  });

  it('stop cleanly at its time budget, between two statements, without marking the count complete', async () => {
    const marked = async () => (await database.db.execute(sql`select counted_at from stats_answers where key = 'run:recent'`)).rows[0]?.['counted_at'];
    const before = await marked();

    // A first statement that takes longer than the whole budget
    const { options } = jobs();
    const slow = {
      ...options.counter,
      platform: async (input: Parameters<typeof options.counter.platform>[0]) => {
        await new Promise(resolve => setTimeout(resolve, 300));

        return options.counter.platform(input);
      },
    };
    const error = await jobs({ counter: slow, budgetMs: 200 }).recent().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PublicStatsBudgetError);
    expect(await marked()).toEqual(before);
  });

  it('end as the budget\'s error, with its counts, when the budget cuts a statement short', async () => {
    const blocker = new pg.Client({ connectionString: database.url.expose() });
    await blocker.connect();
    try {
      await blocker.query('begin');
      await blocker.query('lock table payments in access exclusive mode');

      const error = await jobs({ budgetMs: 400 }).recent().catch((thrown: unknown) => thrown) as PublicStatsBudgetError;

      expect(error).toBeInstanceOf(PublicStatsBudgetError);
      expect(error.result).toEqual({ services: 0, written: 0, deleted: 0 });
      expect((error.cause as { cause?: { code?: string } } | undefined)?.cause?.code ?? (error.cause as { code?: string } | undefined)?.code).toBe('57014');
    }
    finally {
      await blocker.query('rollback');
      await blocker.end();
    }
  });

  it('end between two statements once the workers stop', async () => {
    const stopping = new AbortController();
    const { options } = jobs();
    const counter = {
      ...options.counter,
      platform: async (input: Parameters<typeof options.counter.platform>[0]) => {
        const counted = await options.counter.platform(input);
        stopping.abort();

        return counted;
      },
    };

    const error = await jobs({ counter }).recent(stopping.signal).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RunStoppedError);
  });

  it('go on from where a run stopped at its budget, with the same services, and complete the cycle as of its first run', async () => {
    const store = db.createStatsRepository({ db: database.db });
    const services = (await store.storedServices({ timeoutMs: 5_000 })).length;
    expect(services).toBeGreaterThan(4);
    const { options } = jobs();
    // Each service takes a while: a run's budget covers a few of them
    const slow = {
      ...options.counter,
      services: async (input: Parameters<typeof options.counter.services>[0]) => {
        await new Promise(resolve => setTimeout(resolve, 500));

        return options.counter.services(input);
      },
    };
    const firstAt = clock.now().getTime() + 1_000;
    const progress: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const result = await jobs({ counter: slow, budgetMs: 1_200, batchSize: 1 }).recent().catch((thrown: unknown) => thrown);
      const cycle = await store.cycle({ timeoutMs: 5_000 });
      if (!(result instanceof PublicStatsBudgetError)) {
        expect(cycle).toBeUndefined();
        break;
      }
      progress.push(cycle!.next);
    }

    // Each run went on from the last: further every time, and never from the first service again
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every((next, index) => index === 0 || next > progress[index - 1]!)).toBe(true);
    // Complete as of the cycle's first run, which every one of its rows is true at least as of
    const marked = (await database.db.execute(sql`select counted_at from stats_answers where key = 'run:recent'`)).rows[0]?.['counted_at'];
    expect(new Date(String(marked)).getTime()).toBe(firstAt);
  }, 60_000);
});
