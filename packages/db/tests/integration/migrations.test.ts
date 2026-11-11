import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import { createTestDatabase, type TestDatabase } from '@anyfare/testing';

import { migrateDatabase, migrationAttempts, migrationLockTimeoutMs } from '../../src/index.js';

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
