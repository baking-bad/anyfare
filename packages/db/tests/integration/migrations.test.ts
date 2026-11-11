import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import { createTestDatabase, type TestDatabase } from '@anyfare/testing';

import { migrateDatabase, migrationLockTimeoutMs } from '../../src/index.js';

const logger = createLogger({ level: 'silent' });
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await database?.drop();
});

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

  it('fails a run whose statement can\'t get a table\'s lock within its lock timeout, 10 s by default, instead of waiting', async () => {
    const fresh = await createTestDatabase();
    const blocker = new pg.Client({ connectionString: fresh.url.expose() });
    await blocker.connect();
    try {
      // As a long transaction would: every statement on the table queues behind the lock
      await blocker.query('begin');
      await blocker.query('lock table drizzle.__drizzle_migrations in access exclusive mode');
      const started = performance.now();

      const error = await migrateDatabase({ url: fresh.url, logger, lockTimeoutMs: 300 }).catch((thrown: unknown) => thrown) as { code?: string; cause?: { code?: string } };

      // 55P03: the lock wasn't available in time
      expect(error.cause?.code ?? error.code).toBe('55P03');
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(migrationLockTimeoutMs).toBe(10_000);
    }
    finally {
      await blocker.query('rollback');
      await blocker.end();
      await fresh.drop();
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
