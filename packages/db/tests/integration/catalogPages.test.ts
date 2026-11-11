import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBlocklistMatcher } from '@anyfare/core';
import { createTestDatabase, createTestPool, type TestDatabase } from '@anyfare/testing';

import { catalogScanBudget, createCatalogRepository, type CatalogCursor, type CatalogRepository } from '../../src/catalogRepository.js';
import * as schema from '../../src/schema/index.js';

// The catalog's pages, walked to the end: every endpoint shown once, none of a blocked host, and a page that goes on
// with fewer than its limit, for any reason, says so

let database: TestDatabase;
let pool: pg.Pool;
const queries: string[] = [];
const noon = Date.parse('2026-11-20T12:00:00.000Z');
const blocked = createBlocklistMatcher(['blocked.example.com']);
// 50 of a host, then 300 of a blocked one, then 50 of another, and 1,500 more past a search's budget
const hosts = [...Array.from({ length: 50 }, () => 'first.example.com'), ...Array.from({ length: 300 }, () => 'blocked.example.com'),
  ...Array.from({ length: 50 }, () => 'last.example.com'), ...Array.from({ length: 1_500 }, () => 'more.example.com')];

beforeAll(async () => {
  database = await createTestDatabase();
  const rows = hosts.map((host, index) => ({
    host, path: index === 1_850 ? '/v1/100%_OFF' : `/v1/item/${index}`, lastPrice: index % 2 === 0 ? 1_000n : 5_000n, createdAt: new Date(noon + index * 1_000),
    status: 'paid' as const,
  }));
  for (let index = 0; index < rows.length; index += 500)
    await database.db.insert(schema.routedEndpoints).values(rows.slice(index, index + 500));
  pool = createTestPool(database);
});

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const recording = (): CatalogRepository => createCatalogRepository({ db: drizzle({ client: pool, schema, logger: { logQuery: sql => queries.push(sql) } }) });

/** Every page from the first to the last, each checked against the rule a client relies on. */
const walk = async (input: { readonly q?: string; readonly maxPrice?: bigint; readonly limit: number }) => {
  const catalog = recording();
  const pages: { entries: number; partial: boolean; next: boolean }[] = [];
  const seen: string[] = [];
  let after: CatalogCursor | undefined;
  for (let page = 0; page < 500; page += 1) {
    queries.length = 0;
    const found = await catalog.routed({ ...input, ...after === undefined ? {} : { after }, isBlocked: blocked, timeoutMs: 5_000 } as Parameters<CatalogRepository['routed']>[0]);
    // One statement a page, its timeout set before it
    expect(queries.filter(sql => /^\s*(with|select)\b/i.test(sql))).toHaveLength(1);
    // Fewer than the limit and more to come: it says so, and only then
    expect(found.partial).toBe(found.next !== undefined && found.entries.length < input.limit);
    pages.push({ entries: found.entries.length, partial: found.partial, next: found.next !== undefined });
    seen.push(...found.entries.map(entry => `${entry.host}${entry.path}`));
    if (found.next === undefined)
      break;
    after = found.next;
  }

  return { pages, seen };
};

describe('a walk of the catalog', () => {
  it('goes past a blocked host\'s 300 endpoints: the pages it emptied say they go on, and every other endpoint shows once', async () => {
    const { pages, seen } = await walk({ limit: 20 });

    expect(seen).toHaveLength(hosts.length - 300);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.some(entry => entry.startsWith('blocked.example.com'))).toBe(false);
    expect(pages.filter(page => page.entries === 0 && page.partial && page.next).length).toBeGreaterThan(0);
    expect(pages.at(-1)).toMatchObject({ next: false, partial: false });
  });

  it('searches a part of the host and path without case, every character its own, a budget of rows a page, to the end', async () => {
    const searched = await walk({ q: '100%_off', limit: 10 });
    const widest = await walk({ q: 'MORE.example', maxPrice: 1_000n, limit: 100 });

    expect(searched.seen).toEqual(['more.example.com/v1/100%_OFF']);
    // 1,900 rows, 1,000 a page: the first page read its budget and found nothing there
    expect(searched.pages.map(page => [page.entries, page.partial])).toEqual([[0, true], [1, false]]);
    expect(widest.seen).toHaveLength(750);
    expect(Math.ceil(hosts.length / catalogScanBudget)).toBe(2);
  });

  it('goes on after a search\'s window from its last row, so nothing is skipped or read twice', async () => {
    const catalog = recording();
    const first = await catalog.routed({ q: 'nothing-has-this', limit: 10, isBlocked: blocked, timeoutMs: 5_000 });
    const { rows: [windowEnd] } = await pool.query<{ created_at: Date; host: string; path: string }>(`select created_at, host, path from routed_endpoints
      order by created_at, host, path offset ${catalogScanBudget - 1} limit 1`);

    expect(first).toMatchObject({ entries: [], partial: true });
    expect(first.next).toEqual({ createdAt: windowEnd!.created_at, host: windowEnd!.host, path: windowEnd!.path });
  });
});
