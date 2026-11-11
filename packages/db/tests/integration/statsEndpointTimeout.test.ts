import { setTimeout as sleep } from 'node:timers/promises';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '@anyfare/testing';

import { createStatsRepository } from '../../src/statsRepository.js';

// The endpoint read a check makes gives up on the database itself: a slow read stops at its statement
// timeout instead of running on

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

describe('the stored endpoint read', () => {
  it('gives up after its statement timeout, such as while the table is locked', async () => {
    const store = createStatsRepository({ db: database.db });

    await database.db.transaction(async tx => {
      await tx.execute(sql`lock table stats_endpoints in access exclusive mode`);
      const started = Date.now();
      const read = store.endpoint('api.example.com', '/v1/pools', { timeoutMs: 200 });

      await expect(Promise.race([read, sleep(3_000).then(() => 'still waiting')])).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
    });
    // Without the lock, the same read answers
    expect(await store.endpoint('api.example.com', '/v1/pools', { timeoutMs: 1_000 })).toBeUndefined();
  });
});
