import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeClock, createTestDatabase, type TestDatabase } from '@anyfare/testing';

import { createCatalogRepository } from '../../src/catalogRepository.js';
import { createRoutingRepository, maxCheckedEndpointsPerHost, maxCheckedHosts } from '../../src/index.js';
import * as schema from '../../src/schema/index.js';
import { createStatsRepository, type ServicesSort } from '../../src/statsRepository.js';

// The plans of what checks list, on a database as full as the caps let it be: 1,000 stored services, 100 of
// them with 20 checked endpoints, a checked pool of 1,000 hosts with 20 each, 5,000 more checked hosts the
// count dropped since, 60 hosts at the paid cap, and a blocklist. Each read goes by an index or a hash, none
// reads the routed endpoints whole, and the public reads stay within a measured number of buffers.

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
  // The blocklist: hosts, and parent domains of others
  await db.insert(schema.hostBlocklist).values([
    ...Array.from({ length: 50 }, (_, index) => ({ host: `checked-${index * 7}.example.net`, reason: 'abuse', createdAt: now })),
    { host: 'example.biz', reason: 'abuse', createdAt: now },
  ]);
  await db.insert(schema.statsAnswers).values(['services', 'run:recent', 'run:all'].map(key => ({ key, answer: {}, countedAt: now })));
  pool = new pg.Pool({ connectionString: database.url.expose() });
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

describe('the plans of what checks list', () => {
  it.each(['calls', 'buyers', 'volume', 'endpoints', 'price', 'newest'] as ServicesSort[])(
    'read the list of services, sorted by %s, each table once by a hash, and no routed endpoint, within 1,500 buffers at the caps',
    async sort => {
      const store = createStatsRepository({ db: recording() });
      const found = await store.services({ sort, offset: 20, limit: 20, q: 'example' });
      const [statement] = queries.filter(query => /^\s*with/i.test(query.sql));
      const text = await plan(statement!);

      // 1,000 stored, and the pool's newest 1,000, of which 50 blocked
      expect(found.total).toBe(1_000 + maxCheckedHosts - 50);
      expect(text, text).not.toMatch(/routed_endpoints/);
      expect(text, text).not.toMatch(/Index (?:Only )?Scan/);
      expect(text, text).toMatch(/Hash (?:Right |Left )?(?:Anti )?Join/);
      expect(await buffers(statement!)).toBeLessThan(1_500);
    },
  );

  it('read a host\'s listing and a stored service\'s page by the keys and the partial indexes', async () => {
    const store = createStatsRepository({ db: recording() });
    await store.hostListing('api.paid-1.example.com', ['/v1/paid/0', '/v1/paid/1']);
    await store.hostListing('api.checked-3.example.net', []);
    // A host at the paid cap, with no checked endpoint: no probe of it may scan for one
    await store.hostListing('busy-1.example.org', ['/v1/item/1']);
    await store.servicePage('api.paid-1.example.com', '30d');
    const texts = await plans();

    expect(texts).toHaveLength(4);
    for (const text of texts) {
      expect(text, text).toContain('routed_endpoints_pkey');
      expect(text, text).toContain('routed_endpoints_checked_idx');
      expect(text, text).toContain('checked_hosts_pkey');
      expect(text, text).not.toMatch(wholeRead);
    }
    for (const query of statements())
      expect(await buffers(query)).toBeLessThan(300);
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
    expect(await routing.registerEndpoint({ host: 'api.checked-1.example.net', path: '/v1/checked/3', lastPrice: 2_100n, checked: { method: 'GET', mayAddHost: false } }))
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
    // The pool held 6,000: the 10 checked longest ago went, no more in one registration
    expect(await database.db.$count(schema.checkedHosts, eq(schema.checkedHosts.host, 'api.dropped-4999.example.org'))).toBe(0);
    expect(await database.db.$count(schema.checkedHosts, eq(schema.checkedHosts.host, 'api.dropped-4990.example.org'))).toBe(0);
    expect(await database.db.$count(schema.checkedHosts, eq(schema.checkedHosts.host, 'api.dropped-4989.example.org'))).toBe(1);
  });

  it('read a page of the catalog by its order\'s index, only as far as the page needs, and a search 10,000 deep at most', async () => {
    const catalog = createCatalogRepository({ db: recording() });
    const first = await catalog.routed({ limit: 20, offset: 0 });
    const searched = await catalog.routed({ q: 'nothing-has-this', limit: 20, offset: 0 });
    const [page, search] = statements();
    const [pageText, searchText] = [await plan(page!), await plan(search!)];

    expect([first.entries.length, first.more, searched.entries.length, searched.more]).toEqual([20, true, 0, false]);
    expect(pageText, pageText).toContain('routed_endpoints_created_idx');
    expect(pageText, pageText).not.toMatch(/Seq Scan on routed_endpoints\b/);
    expect(await buffers(page!)).toBeLessThan(300);
    // The search reads the oldest 10,000 and stops: a bound, whatever the table holds
    expect(await buffers(search!)).toBeLessThan(15_000);
    expect(searchText, searchText).toMatch(/Limit[\s\S]*routed_endpoints_created_idx/);
  });
});
