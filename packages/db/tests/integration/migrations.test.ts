import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import { createTestDatabase, type TestDatabase } from '@anyfare/testing';

import { migrateDatabase, migrationAttempts, migrationLockTimeoutMs, migrationsFolder } from '../../src/index.js';

const logger = createLogger({ level: 'silent' });
let database: TestDatabase;
// Migrated, for the runs that meet a lock
let locked: TestDatabase;

beforeAll(async () => {
  [database, locked] = await Promise.all([createTestDatabase({ migrate: false }), createTestDatabase()]);
});

afterAll(async () => {
  await Promise.all([database?.drop(), locked?.drop()]);
});

// A session that holds the migrations table's lock, as a long transaction would: every statement on it queues behind
const lockMigrations = async (): Promise<pg.Client> => {
  const blocker = new pg.Client({ connectionString: locked.url.expose() });
  await blocker.connect();
  await blocker.query('begin');
  await blocker.query('lock table drizzle.__drizzle_migrations in access exclusive mode');

  return blocker;
};

const tables = async (): Promise<readonly string[]> => {
  const { rows } = await database.db.execute<{ name: string }>(sql`select table_name as name from information_schema.tables where table_schema = 'public' order by table_name`);

  return rows.map(row => row.name);
};

describe('migrateDatabase', () => {
  it('applies every migration to an empty database, and a second run is a no-op', async () => {
    expect(await tables()).toEqual([]);

    const applied = await migrateDatabase({ url: database.url, logger });

    expect(applied).toBeGreaterThan(0);
    expect(await tables()).toContain('audit_log');
    expect(await migrateDatabase({ url: database.url, logger })).toBe(0);
  });

  it('fails a run whose statements can\'t get a table\'s lock within its lock timeout, after a few attempts with a pause, instead of waiting', async () => {
    const lines: Record<string, unknown>[] = [];
    const capturing = createLogger({ level: 'warn' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const blocker = await lockMigrations();
    try {
      const started = performance.now();

      const error = await migrateDatabase({ url: locked.url, logger: capturing, lockTimeoutMs: 200, attempts: 3, retryPauseMs: 100 })
        .catch((thrown: unknown) => thrown) as { code?: string; cause?: { code?: string } };

      // 55P03: the lock wasn't available in time, three times
      expect(error.cause?.code ?? error.code).toBe('55P03');
      expect(performance.now() - started).toBeGreaterThanOrEqual(3 * 200 + 2 * 100);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(lines.filter(line => line['msg'] === 'A migration couldn\'t get a table\'s lock in time: it tries again after a pause')).toHaveLength(2);
      expect([migrationLockTimeoutMs, migrationAttempts]).toEqual([3_000, 3]);
    }
    finally {
      await blocker.end();
    }
  });

  it('goes on once the lock is free again in one of its pauses', async () => {
    const blocker = await lockMigrations();
    try {
      setTimeout(() => void blocker.query('rollback'), 300);

      expect(await migrateDatabase({ url: locked.url, logger, lockTimeoutMs: 200, attempts: 3, retryPauseMs: 300 })).toBe(0);
    }
    finally {
      await blocker.end();
    }
  });

  it('tries again when Postgres makes it a deadlock\'s victim: a registration read the routed endpoints, and wrote while an index was built', async () => {
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    expect(journal.entries.at(-1)!.tag).toBe('0011_paid_hosts');
    const pending = await createTestDatabase();
    const lines: Record<string, unknown>[] = [];
    const capturing = createLogger({ level: 'warn' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const registration = new pg.Client({ connectionString: pending.url.expose() });
    await registration.connect();
    try {
      // As before 0011, with enough endpoints that its index takes a moment to build: its table and index gone, the
      // time's index back, and it not applied
      await pending.db.execute(sql.raw(`drop table paid_hosts; drop index routed_endpoints_catalog_idx;
        create index routed_endpoints_created_idx on routed_endpoints using btree (created_at);
        delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
        insert into routed_endpoints (host, path, created_at, status)
          select 'host-' || (i % 5000) || '.example.com', '/v1/path/' || i, now() - (i || ' seconds')::interval, 'paid' from generate_series(1, 200000) as i`));
      // A registration reads the table: it holds its share of it until it commits
      await registration.query('begin');
      await registration.query(`select count(*) from routed_endpoints where host = 'host-1.example.com'`);

      const run = migrateDatabase({ url: pending.url, logger: capturing, lockTimeoutMs: 10_000, attempts: 3, retryPauseMs: 300 });
      // The catalog's index is being built: the build holds the table's share lock
      for (let waited = 0; ; waited += 5) {
        const { rows } = await pending.db.execute(sql`select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
          where l.relation = 'routed_endpoints'::regclass and l.granted and l.mode = 'ShareLock' and a.query like '%CREATE INDEX "routed_endpoints_catalog_idx"%'`);
        if (rows.length > 0)
          break;
        expect(waited).toBeLessThan(10_000);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      // The registration writes, and waits for the build; the old index's drop then waits for the registration: Postgres
      // cancels the migrations, and the write goes through
      const written = registration.query(`insert into routed_endpoints (host, path, created_at, status) values ('host-1.example.com', '/v1/new', now(), 'paid')`)
        .then(() => registration.query('commit'));

      expect(await run).toBe(1);
      await written;
      expect(lines.map(line => [line['msg'], line['code']])).toEqual([['A migration was a deadlock\'s victim: it tries again after a pause', '40P01']]);
      const { rows: [applied] } = await pending.db.execute<{ table: string | null; index: string | null; old: string | null }>(sql`select
        to_regclass('paid_hosts')::text as table, to_regclass('routed_endpoints_catalog_idx')::text as index, to_regclass('routed_endpoints_created_idx')::text as old`);
      expect(applied).toEqual({ table: 'paid_hosts', index: 'routed_endpoints_catalog_idx', old: null });
    }
    finally {
      await registration.end();
      await pending.drop();
    }
  // 200,000 endpoints to write first
  }, 60_000);

  it('applies each migration once when two runs race', async () => {
    const fresh = await createTestDatabase({ migrate: false });
    try {
      const results = await Promise.all([
        migrateDatabase({ url: fresh.url, logger }),
        migrateDatabase({ url: fresh.url, logger }),
      ]);

      expect(Math.min(...results)).toBe(0);
      expect(Math.max(...results)).toBeGreaterThan(0);
    }
    finally {
      await fresh.drop();
    }
  });
});
