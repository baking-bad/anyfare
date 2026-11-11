import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBlocklistMatcher } from '@anyfare/core';
import { createFakeClock, createTestDatabase, createTestPool, type TestDatabase } from '@anyfare/testing';

import { catalogScanBudget, createCatalogRepository, type CatalogCursor } from '../../src/catalogRepository.js';
import { createRoutingRepository, maxCheckedEndpointsPerHost, maxCheckedHosts } from '../../src/index.js';
import * as schema from '../../src/schema/index.js';
import { createStatsRepository } from '../../src/statsRepository.js';

// The plans of what checks list, on a database as full as the caps let it be: 1,000 stored services, 100 of
// them with 20 checked endpoints, a checked pool of 1,000 hosts with 20 each, 5,000 more checked hosts the
// count dropped since, 60 hosts at the paid cap the count doesn't store, 20,000 more paid long ago, 105,000 routed
// endpoints in all, and a blocklist of 200. Each read goes by an index or a hash, none reads the routed endpoints
// whole, none matches the blocklist row by row, and the public reads stay within a measured number of buffers.

let database: TestDatabase;
let pool: pg.Pool;
const queries: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
const now = new Date('2026-11-20T12:00:00.000Z');
const clock = createFakeClock(now);
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
const at = (seconds: number): Date => new Date(now.getTime() - seconds * 1_000);
const parentOf = (host: string): string => host.split(':')[0]!.split('.').slice(-2).join('.');

beforeAll(async () => {
  database = await createTestDatabase();
  const { db } = database;
  const insert = async <TRow>(rows: readonly TRow[], write: (batch: TRow[]) => Promise<unknown>): Promise<void> => {
    for (let index = 0; index < rows.length; index += 1_000)
      await write(rows.slice(index, index + 1_000));
  };
  // Stored services, each with 3 paid endpoints; the first 100 also with 20 checked ones and their row
  const stored = Array.from({ length: 1_000 }, (_, index) => `api.paid-${index}.example.com`);
  await insert(stored, batch => db.insert(schema.statsServices).values(batch.map((host, index) => ({
    hostHash: md5(host), host, paidEndpoints: 3, priceFrom: 1_000n, calls: 1_000 - index, buyers: 1, volume: 10_000n, successRate: 1, p50Ms: 100, trend: [],
    countedAt: now, listedAt: at(86_400 + index),
  }))));
  await insert(stored.flatMap(host => [0, 1, 2].map(path => ({ host, path }))), batch => db.insert(schema.routedEndpoints).values(batch.map(({ host, path }) => ({
    host, path: `/v1/paid/${path}`, lastPrice: 1_000n, createdAt: at(86_400 + path), status: 'paid' as const,
  }))));
  // The pool: 1,000 hosts, each of a parent of its own, 100 of them reached by a paid call since
  const pooled = Array.from({ length: maxCheckedHosts }, (_, index) => `api.checked-${index}.example.net`);
  const checkedOn = [...stored.slice(0, 100), ...pooled];
  await insert(checkedOn.flatMap(host => Array.from({ length: maxCheckedEndpointsPerHost }, (_, path) => ({ host, path }))), batch => db.insert(schema.routedEndpoints)
    .values(batch.map(({ host, path }) => ({
      host, path: `/v1/checked/${path}`, lastPrice: 2_000n, createdAt: at(path), status: 'checked' as const, checkedAt: at(path), checkMethod: 'GET' as const,
    }))));
  // 5,000 more the count stored once and dropped, and none pushed out yet: the pool's read keeps the newest 1,000
  const dropped = Array.from({ length: 5_000 }, (_, index) => `api.dropped-${index}.example.org`);
  // Each checked a second before the one ahead of it: the last checked longest ago
  await insert([...checkedOn, ...dropped].map((host, index) => ({ host, index })), batch => db.insert(schema.checkedHosts).values(batch.map(({ host, index }) => ({
    host, parent: parentOf(host), listedAt: at(86_400 + index), checkedAt: at(index),
    paidAt: host.startsWith('api.paid-') || host.startsWith('api.dropped-') || index % 10 === 0 ? at(86_400) : null,
    checkedEndpoints: host.startsWith('api.dropped-') ? 0 : maxCheckedEndpointsPerHost, priceFrom: 2_000n,
  }))));
  // 60 hosts at the paid cap: the routed endpoints mostly paid ones, as they are
  for (let host = 0; host < 60; host += 1) {
    await insert(Array.from({ length: 1_000 }, (_, path) => path), batch => db.insert(schema.routedEndpoints).values(batch.map(path => ({
      host: `busy-${host}.example.org`, path: `/v1/item/${path}`, lastPrice: 1_000n, createdAt: at(path), status: 'paid' as const,
    }))));
  }
  // Their rows of paid hosts, as their registrations keep them, and 20,000 more hosts a paid call reached long ago
  await db.insert(schema.paidHosts).values(Array.from({ length: 60 }, (_, host) => ({
    host: `busy-${host}.example.org`, registeredAt: at(host), listedAt: at(999), paidEndpoints: 1_000, endpoints: 1_000, priceFrom: 1_000n,
  })));
  await insert(Array.from({ length: 20_000 }, (_, index) => index), batch => db.insert(schema.paidHosts).values(batch.map(index => ({
    host: `old-${index}.paid-long-ago.example`, registeredAt: at(40 * 86_400 + index), listedAt: at(40 * 86_400 + index), paidEndpoints: 1, endpoints: 1, priceFrom: 1_000n,
  }))));
  await insert(Array.from({ length: 20_000 }, (_, index) => index), batch => db.insert(schema.routedEndpoints).values(batch.map(index => ({
    host: `old-${index}.paid-long-ago.example`, path: '/v1/old', lastPrice: 1_000n, createdAt: at(40 * 86_400 + index), status: 'paid' as const,
  }))));
  // The blocklist: 200 hosts, and parent domains of others
  await db.insert(schema.hostBlocklist).values([
    ...Array.from({ length: 50 }, (_, index) => ({ host: `checked-${index * 7}.example.net`, reason: 'abuse', createdAt: now })),
    ...Array.from({ length: 149 }, (_, index) => ({ host: `elsewhere-${index}.example.info`, reason: 'abuse', createdAt: now })),
    { host: 'example.biz', reason: 'abuse', createdAt: now },
  ]);
  await db.insert(schema.statsAnswers).values(['services', 'run:recent', 'run:all'].map(key => ({ key, answer: {}, countedAt: now })));
  pool = createTestPool(database);
  await pool.query('vacuum analyze');
// Seeding takes longer than the default hook limit on a busy machine
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

// A database that records every statement it sends
const recording = () => {
  queries.length = 0;

  return drizzle({ client: pool, schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } });
};

const plan = async (query: { readonly sql: string; readonly params: readonly unknown[] }): Promise<string> => {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(`explain (costs off) ${query.sql}`, [...query.params]);

  return rows.map(row => row['QUERY PLAN']).join('\n');
};

// The buffers a statement touches, shared hits and reads, as it runs
const buffers = async (query: { readonly sql: string; readonly params: readonly unknown[] }): Promise<number> => {
  const { rows } = await pool.query<{ 'QUERY PLAN': [{ Plan: { 'Shared Hit Blocks': number; 'Shared Read Blocks': number } }] }>(
    `explain (analyze, buffers, format json) ${query.sql}`, [...query.params]);
  const top = rows[0]!['QUERY PLAN'][0].Plan;

  return top['Shared Hit Blocks'] + top['Shared Read Blocks'];
};

// The statements that read or write the tables, without the transaction's own
const statements = () => queries.filter(query => /^\s*(with|select|insert|update|delete)\b/i.test(query.sql) && /routed_endpoints|checked_hosts/.test(query.sql));
const plans = async () => Promise.all(statements().map(plan));
// No table of these read whole. The blocklist is the operators' own, a few rows: the planner may read it whole.
const wholeRead = /Seq Scan on (?:routed_endpoints|stats_services|checked_hosts)\b/;

const blocklist = async (): Promise<(host: string) => boolean> => createBlocklistMatcher(await createStatsRepository({ db: database.db }).blocklist({ limit: 10_001, timeoutMs: 2_000 }));

describe('the plans of what checks list', () => {
  it('read every service the list may show in one statement: no blocklist, the paid hosts newest first by their index, each with one probe of its paid endpoints', async () => {
    const store = createStatsRepository({ db: recording() });
    const listed = await store.listedServices({ maxPaid: 1_000, timeoutMs: 2_000 });
    const [statement] = queries.filter(query => /stored_rows/.test(query.sql));
    const text = await plan(statement!);

    // 1,000 stored, the newest 1,000 paid ones the count doesn't store, and the 900 of the pool no paid call reached
    expect([listed.rows.length, listed.stored]).toEqual([1_000 + 1_000 + 900, 1_000]);
    expect(listed.rows.filter(row => row.kind === 'paid').map(row => row.host).slice(0, 2)).toEqual(['busy-0.example.org', 'busy-1.example.org']);
    // The paid hosts are every host a paid call ever reached: by their index, the newest first. The checked hosts and
    // the stored services are bounded by their caps: the planner may read them whole.
    expect(text, text).not.toMatch(/host_blocklist|Seq Scan on (?:paid_hosts|routed_endpoints)\b/);
    expect(text, text).toContain('paid_hosts_registered_idx');
    expect(text.match(/routed_endpoints\w*/g)).toEqual(['routed_endpoints_listed_idx', 'routed_endpoints']);
    // About 10,300: a probe by key for each of the 1,000 stored and the 1,000 paid hosts
    expect(await buffers(statement!)).toBeLessThan(12_000);
  });

  it('read a host\'s listing and a stored service\'s page by the keys and the partial indexes', async () => {
    const store = createStatsRepository({ db: recording() });
    const options = { timeoutMs: 2_000, maxPaid: 1_000 };
    await store.hostListing('api.paid-1.example.com', ['/v1/paid/0', '/v1/paid/1'], options);
    // The pool's oldest: the most to read before it
    await store.hostListing('api.checked-999.example.net', [], options);
    // A host at the paid cap, with no checked endpoint: no probe of it may scan for one
    await store.hostListing('busy-1.example.org', ['/v1/item/1'], options);
    await store.servicePage('api.paid-1.example.com', '30d', options);
    const texts = await plans();

    expect(texts).toHaveLength(4);
    for (const text of texts) {
      expect(text, text).toContain('routed_endpoints_pkey');
      expect(text, text).toContain('routed_endpoints_checked_idx');
      expect(text, text).toContain('checked_hosts_pkey');
      expect(text, text).toContain('paid_hosts_pkey');
      // Where it stands in the pool may read the checked hosts and the stored services whole: the pool and the
      // stored ones a check reached, and stats.maxServices, each bounded. The paid hosts and the routed endpoints never.
      expect(text, text).not.toMatch(/Seq Scan on (?:routed_endpoints|paid_hosts)\b/);
    }
    // About 50 each, and 1,900 for the pool's oldest, whose place in it is read
    for (const query of statements())
      expect(await buffers(query)).toBeLessThan(2_500);
  });

  it('read an endpoint\'s fee, as every probe does, by the key alone, and a check\'s listing by keys', async () => {
    const routing = createRoutingRepository({ db: recording(), clock });
    await routing.endpointFee('busy-1.example.org', '/v1/item/7');
    await routing.endpointListing('busy-1.example.org', '/v1/item/7', { timeoutMs: 5_000 });
    const [fee, listing] = await plans();

    expect(fee, fee).toMatch(/Index Scan using routed_endpoints_pkey on routed_endpoints\n\s+Index Cond: \(\(host = .*\) AND \(path = .*\)\)/);
    expect(listing, listing).toContain('routed_endpoints_pkey');
    expect(listing, listing).toContain('routed_endpoints_checked_idx');
    expect(listing, listing).toContain('stats_services_pkey');
    expect(listing, listing).toContain('checked_hosts_pkey');
    expect(listing, listing).not.toMatch(wholeRead);
    expect(await buffers(statements()[1]!)).toBeLessThan(50);
  });

  it('register a check\'s endpoint and a paid one by the indexes, and push out the host checked longest ago by its own', async () => {
    const routing = createRoutingRepository({ db: recording(), clock });
    expect(await routing.registerEndpoint({ host: 'api.checked-1.example.net', path: '/v1/checked/3', lastPrice: 2_100n, checked: { method: 'GET', mayAddHost: true } }))
      .toBe('exists');
    expect(await routing.registerEndpoint({ host: 'api.paid-500.example.com', path: '/v1/new', lastPrice: 2_100n, checked: { method: 'POST', mayAddHost: false } }))
      .toBe('created');
    expect(await routing.registerEndpoint({ host: 'api.paid-1.example.com', path: '/v1/checked/4', lastPrice: 1_000n })).toBe('exists');
    expect(await routing.registerEndpoint({ host: 'api.brand-new.example.net', path: '/v1/x', lastPrice: 1_000n, checked: { method: 'GET', mayAddHost: true } }))
      .toBe('created');
    const texts = await plans();

    expect(texts.length).toBeGreaterThan(10);
    // The checked hosts are the pool and one row per stored host a check reached: their counts may read them
    // whole, a bounded read. The routed endpoints are never read whole.
    for (const text of texts)
      expect(text, text).not.toMatch(/Seq Scan on routed_endpoints\b/);
    const all = texts.join('\n');
    // The count of every checked endpoint by their own index
    expect(all).toContain('routed_endpoints_checked_order_idx');
    // The pool held 6,000: two checks of hosts of the pool, each pushed out the 10 checked longest ago, no more
    expect(await database.db.$count(schema.checkedHosts, eq(schema.checkedHosts.host, 'api.dropped-4999.example.org'))).toBe(0);
    expect(await database.db.$count(schema.checkedHosts, eq(schema.checkedHosts.host, 'api.dropped-4980.example.org'))).toBe(0);
    expect(await database.db.$count(schema.checkedHosts, eq(schema.checkedHosts.host, 'api.dropped-4979.example.org'))).toBe(1);
  });

  it('read a page of the catalog by its order\'s index from its cursor, as deep as it goes, never matching the blocklist row by row', async () => {
    const catalog = createCatalogRepository({ db: recording() });
    const isBlocked = await blocklist();
    const total = await database.db.$count(schema.routedEndpoints);
    const first = await catalog.routed({ limit: 20, isBlocked, timeoutMs: 2_000 });
    // From the cursor of the 80,000th endpoint: past any offset's reach
    const [deep] = (await pool.query<{ created_at: Date; host: string; path: string }>(`select created_at, host, path from routed_endpoints
      order by created_at, host, path offset 80000 limit 1`)).rows;
    const after: CatalogCursor = { createdAt: deep!.created_at, host: deep!.host, path: deep!.path };
    const later = await catalog.routed({ limit: 100, after, isBlocked, timeoutMs: 2_000 });
    const [page, deepPage] = statements();
    const [pageText, deepText] = [await plan(page!), await plan(deepPage!)];

    expect(total).toBeGreaterThan(80_100);
    expect([first.entries.length, first.next === undefined, first.partial]).toEqual([20, false, false]);
    expect(later.entries).toHaveLength(100);
    expect(later.entries[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(after.createdAt.getTime());
    for (const text of [pageText, deepText]) {
      expect(text, text).toContain('routed_endpoints_catalog_idx');
      expect(text, text).not.toMatch(/Seq Scan on routed_endpoints\b|host_blocklist|SubPlan/);
    }
    // Each reads its own rows: the cursor's row starts the index's scan, however many share its time
    expect(deepText, deepText).toMatch(/Index Cond: \(ROW\(created_at, host, path\) > ROW\(/);
    expect(deepText, deepText).not.toMatch(/Sort/);
    for (const statement of [page!, deepPage!])
      expect(await buffers(statement)).toBeLessThan(400);
  });

  it('search the catalog a budget of rows a page, saying where it stopped, so a search reaches its newest endpoints', async () => {
    const catalog = createCatalogRepository({ db: recording() });
    const isBlocked = await blocklist();
    // The newest host at the paid cap: its 1,000 endpoints lie past 80,000 others
    const found: string[] = [];
    let after: CatalogCursor | undefined;
    let pages = 0;
    for (;;) {
      queries.length = 0;
      const page = await catalog.routed({ q: 'BUSY-0.example', limit: 100, ...after === undefined ? {} : { after }, isBlocked, timeoutMs: 2_000 });
      pages += 1;
      found.push(...page.entries.map(entry => `${entry.host}${entry.path}`));
      // A page that goes on with fewer than its limit says so, and only such a page
      expect(page.partial).toBe(page.next !== undefined && page.entries.length < 100);
      if (pages === 1) {
        // One statement: the window read once, its matches and where it ends
        const sent = statements();
        expect(sent).toHaveLength(1);
        expect([page.entries.length, page.partial, page.next !== undefined]).toEqual([0, true, true]);
        expect(await buffers(sent[0]!)).toBeLessThan(2_000);
      }
      if (page.next === undefined)
        break;
      after = page.next;
    }

    expect(new Set(found).size).toBe(1_000);
    expect(found.every(entry => entry.startsWith('busy-0.example.org/'))).toBe(true);
    // Each page read at most its budget: as many pages as the endpoints in all over it, give or take the pages that found some
    expect(pages).toBeGreaterThanOrEqual(Math.floor(80_000 / catalogScanBudget));
  });
});
