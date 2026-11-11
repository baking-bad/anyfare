import { createServer as createNetServer, type AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp as createApi, type ApiServer } from '@anyfare/api';
import { createLogger, Secret } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createPostgres, createStatsRepository, payments } from '@anyfare/db';
import { createFakeClock, createManualTimers, createTestDatabase, createTestRedis, fixtureTime, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp } from '../../src/app.js';
import { holdExpiryIntervalMs } from '../../src/holdExpiry.js';
import { publicStatsAllLockId, publicStatsLockId } from '../../src/publicStats.js';
import { settlementFollowUpIntervalMs } from '../../src/settlementFollowUp.js';

// The public numbers' two counts in the workers app: never at start, but after the payments' own jobs have
// run once, then each on its interval from the config, with one line a run and the age of each kind of
// count; on a pool of their own, so the payments' jobs run whatever happens to them; and what they write
// is what the API serves.

const start = fixtureTime(1, 2, 12, 0, 0, 0);
// The longest host routing keeps: a name of 253 characters and a port of 5 digits
const longHost = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}:65535`;

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let counter = 0;

const seed = async (host: string, at: string): Promise<void> => {
  counter += 1;
  await database.db.insert(payments).values({
    id: `pay_job_${counter}`, requestId: null, rail: 'x402', buyerAccountId: null, keyId: null, targetHost: host, targetPath: '/v1/quote', network: 'eip155:84532',
    asset: 'base-usdc', atomicAmount: 10_000n, amount: 10_000n, fee: 0n, upstreamStatus: 200, upstreamLatencyMs: 120, status: 'settled', transactionHash: null,
    receipt: null, settlementRequest: null, needsReview: false, createdAt: new Date(at), updatedAt: new Date(at),
  });
};

const closedPort = async (): Promise<number> => {
  const listener = createNetServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise(resolve => listener.close(resolve));

  return port;
};

// The others' database, for the counts that run on a pool of their own
let elsewhere: TestDatabase;

beforeAll(async () => {
  [database, redis, elsewhere] = await Promise.all([createTestDatabase(), createTestRedis(), createTestDatabase()]);
  const loaded = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
  config = { ...loaded, stats: { ...loaded.stats, intervalSeconds: 600, allIntervalSeconds: 3_600 } };
  await seed('first.example.com', fixtureTime(1, 2, 11, 0, 0, 0));
  await seed(longHost, fixtureTime(1, 2, 11, 30, 0, 0));
});

afterAll(async () => {
  await Promise.all([database?.drop(), redis?.cleanup(), elsewhere?.drop()]);
});

const capture = () => {
  const lines: Record<string, unknown>[] = [];

  // Debug: a run that did nothing is a debug line
  return { lines, logger: createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }) };
};

const ran = (lines: readonly Record<string, unknown>[], job: string) => lines.filter(line => (line['msg'] === 'A job ran' || line['msg'] === 'A job failed') && line['job'] === job);

describe('the public numbers\' counts in the workers', () => {
  it('first run once hold expiry and the settlement follow-up have, then each on its interval, with an info line and the age of its count', async () => {
    const { lines, logger } = capture();
    const clock = createFakeClock(start);
    const timers = createManualTimers();
    const stats = createStatsRepository({ db: database.db });
    const workers = createApp({ config, logger, postgres: database.postgres, clock, timers });
    let api: ApiServer | undefined;
    try {
      const port = await workers.listen({ host: '127.0.0.1', port: 0 });
      timers.advance(0);
      await new Promise(resolve => setTimeout(resolve, 100));
      // Never at start
      expect([ran(lines, 'public_stats'), ran(lines, 'public_stats_all')]).toEqual([[], []]);

      // The settlement follow-up's first run, then hold expiry's: only then the frequent count, and the all-time one after it
      timers.advance(settlementFollowUpIntervalMs);
      await vi.waitFor(() => expect(ran(lines, 'settlement_follow_up')).toHaveLength(1));
      timers.advance(holdExpiryIntervalMs - settlementFollowUpIntervalMs);
      await vi.waitFor(() => expect(ran(lines, 'hold_expiry')).toHaveLength(1));
      expect(ran(lines, 'public_stats')).toEqual([]);
      await vi.waitFor(() => {
        timers.advance(0);
        expect(ran(lines, 'public_stats_all')).toHaveLength(1);
      });

      expect(ran(lines, 'public_stats')[0]).toMatchObject({ level: 30, msg: 'A job ran', counts: { services: 2, written: expect.any(Number), deleted: 0 }, durationMs: expect.any(Number) });
      expect(ran(lines, 'public_stats_all')[0]).toMatchObject({ level: 30, msg: 'A job ran', counts: { services: 2 } });
      expect((await stats.platform()).recent?.countedAt).toEqual(new Date(start));
      clock.advance(120_000);
      const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      expect(metrics).toContain('workers_public_stats_age_seconds{count="recent"} 120');
      expect(metrics).toContain('workers_public_stats_age_seconds{count="all"} 120');

      // The next frequent count one interval after the first ended
      await seed('second.example.com', fixtureTime(1, 2, 12, 1, 0, 0));
      timers.advance(config.stats.intervalSeconds * 1_000 - 1);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ran(lines, 'public_stats')).toHaveLength(1);
      timers.advance(1);
      await vi.waitFor(() => expect(ran(lines, 'public_stats')).toHaveLength(2));
      expect(await stats.platform()).toMatchObject({ recent: { countedAt: new Date(fixtureTime(1, 2, 12, 2, 0, 0)), answer: { calls: { today: 3 } } } });
      expect(ran(lines, 'public_stats_all')).toHaveLength(1);

      api = createApi({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock });
      const { port: apiPort } = await api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
      const read = async (path: string) => (await fetch(`http://127.0.0.1:${apiPort}${path}`)).json() as Promise<Record<string, unknown>>;

      expect(await read('/v1/stats')).toMatchObject({ updatedAt: fixtureTime(1, 2, 12, 2, 0, 0), allUpdatedAt: start, calls: { today: 3, all: 2 }, services: { today: 3 } });
      expect(await read(`/v1/services/${longHost.toUpperCase()}`)).toMatchObject({ host: longHost, stats: { calls: 1 }, exact: true });
      expect(await read(`/v1/endpoints/stats?host=${longHost}&path=/v1/quote`)).toMatchObject({ host: longHost, stats: { calls: 1, p50Ms: 120 }, exact: true });
    }
    finally {
      await api?.close();
      await workers.close();
    }
  });

  it('first run only once every other job due within their interval has run once, the treasury\'s too', async () => {
    const { lines, logger } = capture();
    const timers = createManualTimers();
    const clock = createFakeClock(fixtureTime(1, 2, 12, 30, 0, 0));
    const balance = { balance: async () => 1_000_000n };
    // The treasury's balances first run 5 minutes after start; the frequent count every 10 minutes
    const workers = createApp({ config, logger, postgres: database.postgres, clock, timers, balanceReaders: { evm: balance, solana: balance, near: balance } });
    try {
      await workers.listen({ host: '127.0.0.1', port: 0 });
      for (const step of [settlementFollowUpIntervalMs, holdExpiryIntervalMs - settlementFollowUpIntervalMs])
        timers.advance(step);
      await vi.waitFor(() => expect(ran(lines, 'routing_losses')).toHaveLength(1));
      timers.advance(0);
      await new Promise(resolve => setTimeout(resolve, 100));
      // Hold expiry, the settlement follow-up and routing losses have run; the treasury's balances haven't
      expect(ran(lines, 'public_stats')).toEqual([]);
      timers.advance(5 * 60_000 - holdExpiryIntervalMs);
      await vi.waitFor(() => expect(ran(lines, 'treasury_balances')).toHaveLength(1));
      await vi.waitFor(() => {
        timers.advance(0);
        expect(ran(lines, 'public_stats')).toHaveLength(1);
      });
    }
    finally {
      await workers.close();
    }
  });

  it('count, read and write through their own pool only', async () => {
    const timers = createManualTimers();
    const clock = createFakeClock(fixtureTime(1, 2, 12, 30, 0, 0));
    const workers = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: elsewhere.postgres, statsPostgres: database.postgres, clock, timers });
    // Its lock taken on the others' database: the counts' lock is on their own
    const unlock = (await elsewhere.postgres.tryAdvisoryLock(publicStatsLockId))!;
    try {
      expect(await workers.scheduler.runNow('public_stats')).toBe('success');

      // The calls and the answers are where the counts' pool is, none where the others' is
      expect((await createStatsRepository({ db: database.db }).platform()).recent?.answer.calls.today).toBeGreaterThan(0);
      expect((await createStatsRepository({ db: elsewhere.db }).platform()).recent).toBeUndefined();
    }
    finally {
      await unlock();
      await workers.close();
    }
  });

  it('count today, 7 and 30 days while an all-time count runs: each has a lock of its own', async () => {
    const clock = createFakeClock(fixtureTime(1, 2, 12, 30, 0, 0));
    const workers = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, clock, timers: createManualTimers() });
    // As a slow all-time count on another replica holds it
    const unlock = (await database.postgres.tryAdvisoryLock(publicStatsAllLockId))!;
    try {
      expect(await workers.scheduler.runNow('public_stats_all')).toBe('skipped');
      expect(await workers.scheduler.runNow('public_stats')).toBe('success');
      expect((await createStatsRepository({ db: database.db }).platform()).recent?.countedAt).toEqual(clock.now());
    }
    finally {
      await unlock();
      await workers.close();
    }
  });

  it('count on a pool of their own: with it down, hold expiry and the settlement follow-up still run', async () => {
    const { lines, logger } = capture();
    const timers = createManualTimers();
    const down = createPostgres({ url: Secret.from(`postgres://anyfare:anyfare@127.0.0.1:${await closedPort()}/anyfare`), logger: createLogger({ level: 'silent' }), connectTimeoutMs: 500 });
    const workers = createApp({ config, logger, postgres: database.postgres, statsPostgres: down, timers });
    try {
      await workers.listen({ host: '127.0.0.1', port: 0 });
      for (let round = 0; round < 3; round += 1) {
        timers.advance(holdExpiryIntervalMs);
        await vi.waitFor(() => expect(ran(lines, 'hold_expiry')).toHaveLength(round + 1));
      }
      await vi.waitFor(() => {
        timers.advance(0);
        expect(ran(lines, 'public_stats').length).toBeGreaterThan(0);
      });

      expect(ran(lines, 'public_stats')[0]).toMatchObject({ msg: 'A job failed' });
      expect(ran(lines, 'hold_expiry').every(line => line['msg'] === 'A job ran')).toBe(true);
      expect(ran(lines, 'settlement_follow_up').length).toBeGreaterThanOrEqual(3);
    }
    finally {
      await workers.close();
      await down.close();
    }
  });
});
