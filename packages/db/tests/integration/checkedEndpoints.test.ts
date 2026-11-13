import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import { createFakeClock, createTestDatabase, type FakeClock, type TestDatabase } from '@anyfare/testing';

import {
  checkedHosts, checkedRegistrationTimeoutMs, createPostgres, createRoutingRepository, evictCheckedHost, maxCheckedEndpoints, maxCheckedEndpointsPerHost,
  maxCheckedHostLabels, maxCheckedHosts, maxCheckedHostsPerParent, maxRoutedEndpointsPerHost, migrationsFolder, paidHosts, routedEndpoints, statsAnswers,
  statsServices, type EndpointInput,
} from '../../src/index.js';

// Endpoints a payable check lists, beside those of paid calls: the checked pool of hosts the count doesn't
// store, its caps per host, per parent domain and in all, across connections, the fees no eviction touches,
// the key's bounds, and the migration that marked every earlier endpoint paid

let database: TestDatabase;
let clock: FakeClock;
let counter = 0;
const noon = '2026-11-12T12:00:00.000Z';
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');

beforeAll(async () => {
  database = await createTestDatabase();
  clock = createFakeClock(noon);
});

afterAll(async () => {
  await database?.drop();
});

// Each its own parent domain, so the parents' caps stay out of the way
const hostOf = (): string => {
  counter += 1;

  return `api.checked-${counter}.dev`;
};
const checkedBy = (mayAddHost = true, method: 'GET' | 'POST' = 'GET'): NonNullable<EndpointInput['checked']> => ({ method, mayAddHost });
const rowsOf = async (host: string) => database.db.select().from(routedEndpoints).where(eq(routedEndpoints.host, host)).orderBy(routedEndpoints.path);
const summaryOf = async (host: string) => (await database.db.select().from(checkedHosts).where(eq(checkedHosts.host, host)))[0];
// The checked pool: the checked hosts the count doesn't store
const pooled = async (): Promise<number> => (await database.db.execute<{ count: number }>(sql`select count(*)::int as count from checked_hosts c
  where not exists (select 1 from stats_services s where s.host_hash = md5(c.host))`)).rows[0]!.count;
// As the count stores a service: a row of its own
const store = async (host: string): Promise<void> => {
  await database.db.insert(statsServices).values({
    hostHash: md5(host), host, paidEndpoints: 1, priceFrom: null, calls: 1, buyers: 1, volume: 1_000n, successRate: 1, p50Ms: 100, trend: [], countedAt: clock.now(),
  }).onConflictDoNothing();
};
// No host in the pool, and no endpoint listed only by a check, as evictions would leave them
const empty = async (): Promise<void> => {
  await database.db.delete(routedEndpoints).where(eq(routedEndpoints.status, 'checked'));
  await database.db.delete(checkedHosts);
};
// Fills the pool to `count` hosts, each of a parent of its own, the one checked longest ago first, each with an endpoint listed only by a check
const fill = async (prefix: string, count: number): Promise<string[]> => {
  const parent = (index: number): string => `${prefix}-${index}.dev`;
  const hosts = Array.from({ length: count }, (_, index) => `api.${parent(index)}`);
  for (let index = 0; index < hosts.length; index += 500) {
    const batch = hosts.slice(index, index + 500);
    const at = (offset: number) => new Date(Date.parse(noon) + (index + offset) * 1_000);
    await database.db.insert(routedEndpoints).values(batch.map((host, offset) => ({
      host, path: '/v1/x', lastPrice: 1_000n, createdAt: at(offset), status: 'checked' as const, checkedAt: at(offset), checkMethod: 'GET' as const,
    })));
    await database.db.insert(checkedHosts).values(batch.map((host, offset) => ({
      host, parent: parent(index + offset), listedAt: at(offset), checkedAt: at(offset), paidAt: null, checkedEndpoints: 1, priceFrom: 1_000n,
    })));
  }

  return hosts;
};

describe('a payable check\'s endpoint', () => {
  it('is listed once, as checked, with the check\'s method, price and time; a second check updates those only', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = hostOf();

    expect(await routing.registerEndpoint({ host, path: '/v1/pools', lastPrice: 1_100n, checked: checkedBy() })).toBe('created');
    clock.advance(61_000);
    expect(await routing.registerEndpoint({ host, path: '/v1/pools', lastPrice: 1_200n, checked: checkedBy(true, 'POST') })).toBe('exists');

    expect(await rowsOf(host)).toEqual([{
      host, path: '/v1/pools', feeBps: null, lastPrice: 1_200n, createdAt: new Date(noon), status: 'checked', checkedAt: new Date(Date.parse(noon) + 61_000),
      checkMethod: 'POST',
    }]);
    expect(await summaryOf(host)).toEqual({
      host, parent: host.split('.').slice(-2).join('.'), listedAt: new Date(noon), checkedAt: new Date(Date.parse(noon) + 61_000), paidAt: null,
      checkedEndpoints: 1, priceFrom: 1_200n,
    });
    // Listed only by a check, its fee is the platform's, as for an endpoint never listed
    expect(await routing.endpointFee(host, '/v1/pools')).toBeUndefined();
    expect(await routing.endpointFee(host, '/v1/never')).toBeUndefined();
    clock.set(noon);
  });

  it('lists or refreshes a host of the pool only when the check\'s client was counted for it, new to the pool or not', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = hostOf();

    expect(await routing.registerEndpoint({ host, path: '/v1/a', checked: checkedBy(false) })).toBe('limited');
    expect(await rowsOf(host)).toEqual([]);
    expect(await summaryOf(host)).toBeUndefined();
    expect(await routing.registerEndpoint({ host, path: '/v1/a', checked: checkedBy(true) })).toBe('created');
    // In the pool already, it takes nothing more without a count: neither a new endpoint nor a refresh
    expect(await routing.registerEndpoint({ host, path: '/v1/b', checked: checkedBy(false) })).toBe('limited');
    expect(await routing.registerEndpoint({ host, path: '/v1/a', checked: checkedBy(false) })).toBe('limited');
    expect(await routing.registerEndpoint({ host, path: '/v1/b', checked: checkedBy(true) })).toBe('created');
    expect((await summaryOf(host))?.checkedEndpoints).toBe(2);
  });

  it('confirms a stored service\'s paid endpoint without a count, and one the count doesn\'t store only when counted: it joins the pool', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const [stored, unstored] = [hostOf(), hostOf()];
    for (const host of [stored, unstored])
      expect(await routing.registerEndpoint({ host, path: '/v1/paid', lastPrice: 1_000n })).toBe('created');
    await store(stored);
    clock.advance(5_000);

    expect(await routing.registerEndpoint({ host: stored, path: '/v1/paid', lastPrice: 1_100n, checked: checkedBy(false) })).toBe('exists');
    expect(await routing.registerEndpoint({ host: unstored, path: '/v1/paid', lastPrice: 1_100n, checked: checkedBy(false) })).toBe('limited');
    expect(await routing.registerEndpoint({ host: unstored, path: '/v1/paid', lastPrice: 1_100n, checked: checkedBy(true) })).toBe('exists');

    expect(await rowsOf(stored)).toEqual([expect.objectContaining({ status: 'paid', lastPrice: 1_100n, checkedAt: new Date(Date.parse(noon) + 5_000), checkMethod: 'GET' })]);
    // Paid since its first endpoint was listed, with no endpoint listed only by a check
    expect(await summaryOf(unstored)).toMatchObject({ checkedAt: new Date(Date.parse(noon) + 5_000), paidAt: new Date(noon), listedAt: new Date(noon), checkedEndpoints: 0 });
    clock.set(noon);
  });

  it('lists nothing of a host the blocklist names a parent domain of, though routing refuses only the exact name', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    await routing.block({ host: 'evil-parent.dev', reason: 'abuse' });

    for (const host of ['evil-parent.dev', 'a.evil-parent.dev', 'b.a.evil-parent.dev:8443'])
      expect(await routing.registerEndpoint({ host, path: '/v1/x', checked: checkedBy() }), host).toBe('blocked');
    expect(await routing.registerEndpoint({ host: 'notevil-parent.dev', path: '/v1/x', checked: checkedBy() })).toBe('created');
    expect(await database.db.$count(routedEndpoints, sql`${routedEndpoints.host} like '%evil-parent.dev%' and ${routedEndpoints.host} <> 'notevil-parent.dev'`)).toBe(0);
    expect([await routing.isBlocked('a.evil-parent.dev'), await routing.isBlocked('evil-parent.dev')]).toEqual([false, true]);
    await routing.unblock('evil-parent.dev');
  });
});

describe('an operator\'s fee', () => {
  it('is set on a paid endpoint only: one listed only by a check has none to set, as one never listed', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = hostOf();
    await routing.registerEndpoint({ host, path: '/v1/checked', checked: checkedBy() });
    await routing.registerEndpoint({ host, path: '/v1/paid' });

    expect(await routing.setEndpointFee({ host, path: '/v1/checked', feeBps: 150 })).toBe(false);
    expect(await routing.setEndpointFee({ host, path: '/v1/paid', feeBps: 150 })).toBe(true);
    expect((await rowsOf(host)).map(row => [row.path, row.feeBps])).toEqual([['/v1/checked', null], ['/v1/paid', 150]]);
  });

  it('is never pushed out with its host: hosts with a fee on an endpoint stay in the pool, whatever its status, and the next leaves', async () => {
    await empty();
    const routing = createRoutingRepository({ db: database.db, clock });
    const hosts = await fill('fee', maxCheckedHosts);
    // The 8 hosts checked longest ago, more than an eviction tries beyond what it needs, each have a fee on an
    // endpoint: a checked one, as an operator's row may be, or a paid one
    for (const [index, host] of hosts.slice(0, 8).entries()) {
      if (index % 2 === 0)
        await database.db.update(routedEndpoints).set({ feeBps: 200 }).where(eq(routedEndpoints.host, host));
      else
        await database.db.insert(routedEndpoints).values({ host, path: '/v1/paid', createdAt: clock.now(), status: 'paid', feeBps: 300 });
    }
    clock.set('2026-11-14T12:00:00.000Z');

    expect(await routing.registerEndpoint({ host: 'api.fee-new.dev', path: '/v1/x', checked: checkedBy() })).toBe('created');

    expect(await pooled()).toBe(maxCheckedHosts);
    for (const host of hosts.slice(0, 8))
      expect(await summaryOf(host), host).toBeDefined();
    expect(await summaryOf(hosts[8]!)).toBeUndefined();
    expect((await rowsOf(hosts[0]!)).map(row => row.feeBps)).toEqual([200]);
    clock.set(noon);
  });
});

describe('the cap of checked endpoints per host', () => {
  it('lists the 20th checked endpoint and caps the 21st; a paid call still lists its endpoint; a checked one becomes paid and frees its place', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = hostOf();
    for (let index = 0; index < maxCheckedEndpointsPerHost - 1; index += 1)
      expect(await routing.registerEndpoint({ host, path: `/v1/checked/${index}`, lastPrice: 2_000n + BigInt(index), checked: checkedBy() })).toBe('created');

    expect(await routing.registerEndpoint({ host, path: '/v1/checked/last', lastPrice: 5_000n, checked: checkedBy() })).toBe('created');
    expect(await routing.registerEndpoint({ host, path: '/v1/checked/one-too-many', checked: checkedBy() })).toBe('capped');
    expect(await routing.registerEndpoint({ host, path: '/v1/paid', lastPrice: 1_000n })).toBe('created');
    expect(await summaryOf(host)).toMatchObject({ checkedEndpoints: 20, priceFrom: 2_000n, paidAt: new Date(noon) });

    // Its first billable call: paid, out of the checked ones' count, and the next check finds room
    expect(await routing.registerEndpoint({ host, path: '/v1/checked/0', lastPrice: 2_100n })).toBe('exists');
    expect((await rowsOf(host)).find(row => row.path === '/v1/checked/0')).toMatchObject({ status: 'paid', lastPrice: 2_100n });
    expect(await summaryOf(host)).toMatchObject({ checkedEndpoints: 19, priceFrom: 2_001n });
    expect(await routing.registerEndpoint({ host, path: '/v1/checked/one-too-many', checked: checkedBy() })).toBe('created');
    const rows = await rowsOf(host);
    expect(rows.filter(row => row.status === 'checked')).toHaveLength(20);
    expect(rows.filter(row => row.status === 'paid').map(row => row.path).sort()).toEqual(['/v1/checked/0', '/v1/paid']);
  });

  it('holds when many checks of one host list new endpoints at once, on connections of their own', async () => {
    const other = createPostgres({ url: database.url, logger: createLogger({ level: 'silent' }) });
    try {
      const host = hostOf();
      await createRoutingRepository({ db: database.db, clock }).registerEndpoint({ host, path: '/v1/first', checked: checkedBy() });

      const results = await Promise.all(Array.from({ length: 30 }, (_, index) => createRoutingRepository({ db: index % 2 === 0 ? database.db : other.db, clock })
        .registerEndpoint({ host, path: `/v1/many/${index}`, checked: checkedBy() })));

      expect(results.filter(result => result === 'created')).toHaveLength(maxCheckedEndpointsPerHost - 1);
      expect(results.filter(result => result === 'capped')).toHaveLength(30 - (maxCheckedEndpointsPerHost - 1));
      expect((await rowsOf(host)).filter(row => row.status === 'checked')).toHaveLength(maxCheckedEndpointsPerHost);
      expect((await summaryOf(host))?.checkedEndpoints).toBe(maxCheckedEndpointsPerHost);
    }
    finally {
      await other.close();
    }
  });

  it('never lets checked endpoints take a paid place, and at the paid cap a billable call takes a checked endpoint out: each endpoint is held once', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = hostOf();
    await routing.registerEndpoint({ host, path: '/v1/checked', checked: checkedBy() });
    await database.db.insert(routedEndpoints).values(Array.from({ length: maxRoutedEndpointsPerHost - 1 }, (_, index) => ({
      host, path: `/v1/paid/${index}`, lastPrice: null, createdAt: clock.now(), status: 'paid' as const,
    })));

    expect(await routing.registerEndpoint({ host, path: '/v1/paid/last' })).toBe('created');
    expect(await routing.registerEndpoint({ host, path: '/v1/paid/one-too-many' })).toBe('capped');
    // It can't become paid past the cap, so it leaves, as a paid one past the cap is never kept
    expect(await routing.registerEndpoint({ host, path: '/v1/checked', lastPrice: 900n })).toBe('capped');
    expect((await rowsOf(host)).find(row => row.path === '/v1/checked')).toBeUndefined();
    expect(await summaryOf(host)).toMatchObject({ checkedEndpoints: 0 });
    expect(await database.db.$count(routedEndpoints, eq(routedEndpoints.host, host))).toBe(maxRoutedEndpointsPerHost);
  });
});

describe('the checked pool\'s cap', () => {
  it('lists the 1,000th without pushing any out, then pushes out the one checked longest ago, with its checked endpoints, and only it', async () => {
    await empty();
    const routing = createRoutingRepository({ db: database.db, clock });
    const hosts = await fill('cap', maxCheckedHosts - 1);
    clock.set('2026-11-13T12:00:00.000Z');

    expect(await routing.registerEndpoint({ host: 'api.thousandth.dev', path: '/v1/x', checked: checkedBy() })).toBe('created');
    expect(await pooled()).toBe(maxCheckedHosts);
    expect(await summaryOf(hosts[0]!)).toBeDefined();

    expect(await routing.registerEndpoint({ host: 'api.newest.dev', path: '/v1/x', checked: checkedBy() })).toBe('created');
    expect(await pooled()).toBe(maxCheckedHosts);
    expect(await summaryOf(hosts[0]!)).toBeUndefined();
    expect(await rowsOf(hosts[0]!)).toEqual([]);
    expect(await summaryOf(hosts[1]!)).toBeDefined();
    clock.set(noon);
  });

  it('holds a host a paid call reached, while the count doesn\'t store it; a stored one leaves the pool, and is never pushed out', async () => {
    await empty();
    const routing = createRoutingRepository({ db: database.db, clock });
    const hosts = await fill('paid', maxCheckedHosts);
    // The oldest gets a paid call: still in the pool, so still the one to leave. The second oldest is stored.
    await routing.registerEndpoint({ host: hosts[0]!, path: '/v1/paid', lastPrice: 1_000n });
    await store(hosts[1]!);
    expect(await pooled()).toBe(maxCheckedHosts - 1);
    clock.set('2026-11-13T12:00:00.000Z');

    expect(await routing.registerEndpoint({ host: 'api.paid-new-1.dev', path: '/v1/x', checked: checkedBy() })).toBe('created');
    expect(await routing.registerEndpoint({ host: 'api.paid-new-2.dev', path: '/v1/x', checked: checkedBy() })).toBe('created');

    expect(await pooled()).toBe(maxCheckedHosts);
    // The paid one went with its checked endpoints, its paid one kept; the stored one stayed
    expect(await summaryOf(hosts[0]!)).toBeUndefined();
    expect((await rowsOf(hosts[0]!)).map(row => [row.path, row.status])).toEqual([['/v1/paid', 'paid']]);
    expect(await summaryOf(hosts[1]!)).toBeDefined();
    // The first new host took the stored one's place; the second, the paid one's
    expect(await summaryOf(hosts[2]!)).toBeDefined();
    clock.set(noon);
  });

  it('holds across connections: new hosts at once past the cap each push one out, and 1,000 stay', async () => {
    await empty();
    await fill('race', maxCheckedHosts - 5);
    const other = createPostgres({ url: database.url, logger: createLogger({ level: 'silent' }) });
    try {
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) => createRoutingRepository({ db: index % 2 === 0 ? database.db : other.db, clock })
        .registerEndpoint({ host: `api.racer-${index}.dev`, path: '/v1/x', checked: checkedBy() })));

      expect(results).toEqual(Array.from({ length: 20 }, () => 'created'));
      expect(await pooled()).toBe(maxCheckedHosts);
      // Each pushed-out host left with its endpoints: no checked endpoint without its host's row
      const { rows } = await database.db.execute<{ orphans: number }>(sql`select count(*)::int as orphans from routed_endpoints r
        where r.status = 'checked' and not exists (select 1 from checked_hosts c where c.host = r.host)`);
      expect(rows[0]?.orphans).toBe(0);
    }
    finally {
      await other.close();
    }
  });

  it('pushes out a host only while it is still in the pool once its lock is held: one stored or given a fee meanwhile stays', async () => {
    await empty();
    const [storedMeanwhile, feeMeanwhile, still] = await fill('raced', 3);
    const other = createPostgres({ url: database.url, logger: createLogger({ level: 'silent' }) });
    try {
      const evicted = await database.db.transaction(async tx => {
        // The candidates, chosen before their locks are taken
        const { rows: candidates } = await tx.execute<{ host: string }>(sql`select host from checked_hosts order by checked_at`);
        expect(candidates.map(row => row.host)).toEqual([storedMeanwhile, feeMeanwhile, still]);
        // Meanwhile, on another connection: the count stores one, and an operator sets a fee on the other's paid endpoint
        await createRoutingRepository({ db: other.db, clock }).registerEndpoint({ host: feeMeanwhile!, path: '/v1/paid' });
        await createRoutingRepository({ db: other.db, clock }).setEndpointFee({ host: feeMeanwhile!, path: '/v1/paid', feeBps: 100 });
        await other.db.insert(statsServices).values({
          hostHash: md5(storedMeanwhile!), host: storedMeanwhile!, paidEndpoints: 1, priceFrom: null, calls: 1, buyers: 1, volume: 1n, successRate: 1, p50Ms: 1, trend: [],
          countedAt: clock.now(),
        });

        return Promise.all(candidates.map(row => evictCheckedHost(tx, row.host)));
      });

      expect(evicted).toEqual([false, false, true]);
      expect((await rowsOf(storedMeanwhile!)).map(row => row.status)).toEqual(['checked']);
      expect((await rowsOf(feeMeanwhile!)).map(row => row.status)).toEqual(['paid', 'checked']);
      expect(await summaryOf(storedMeanwhile!)).toBeDefined();
      expect(await summaryOf(feeMeanwhile!)).toBeDefined();
      expect(await rowsOf(still!)).toEqual([]);
    }
    finally {
      await other.close();
    }
  });
});

describe('the cap per parent domain', () => {
  it('keeps the newest 20 hosts of one parent domain: the 20th lists, the 21st pushes out its oldest, and no other domain\'s', async () => {
    await empty();
    const routing = createRoutingRepository({ db: database.db, clock });
    const others = await fill('elsewhere', 5);
    const hosts = Array.from({ length: maxCheckedHostsPerParent + 1 }, (_, index) => `h${index}.evil-family.dev`);
    clock.set('2026-11-13T12:00:00.000Z');
    for (const [index, host] of hosts.entries()) {
      clock.advance(1_000);
      expect(await routing.registerEndpoint({ host, path: '/v1/x', checked: checkedBy() }), `${index}`).toBe('created');
      if (index === maxCheckedHostsPerParent - 1)
        expect(await database.db.$count(checkedHosts, eq(checkedHosts.parent, 'evil-family.dev'))).toBe(maxCheckedHostsPerParent);
    }

    expect(await database.db.$count(checkedHosts, eq(checkedHosts.parent, 'evil-family.dev'))).toBe(maxCheckedHostsPerParent);
    expect(await summaryOf(hosts[0]!)).toBeUndefined();
    expect(await summaryOf(hosts[1]!)).toBeDefined();
    for (const host of others)
      expect(await summaryOf(host), host).toBeDefined();
    clock.set(noon);
  });

  it('puts every host of a shared suffix such as co.uk in one domain: they compete within its 20, and crowd out no other', async () => {
    await empty();
    const routing = createRoutingRepository({ db: database.db, clock });
    const elsewhere = await fill('uk-elsewhere', 3);
    clock.set('2026-11-13T12:00:00.000Z');
    for (let index = 0; index < maxCheckedHostsPerParent + 5; index += 1) {
      clock.advance(1_000);
      expect(await routing.registerEndpoint({ host: `shop${index}.co.uk`, path: '/v1/x', checked: checkedBy() })).toBe('created');
    }

    expect(await database.db.$count(checkedHosts, eq(checkedHosts.parent, 'co.uk'))).toBe(maxCheckedHostsPerParent);
    expect(await summaryOf('shop0.co.uk')).toBeUndefined();
    expect(await summaryOf(`shop${maxCheckedHostsPerParent + 4}.co.uk`)).toBeDefined();
    for (const host of elsewhere)
      expect(await summaryOf(host), host).toBeDefined();
    clock.set(noon);
  });
});

describe('the cap of checked endpoints in all', () => {
  it('lists the 25,000th, then the next pushes out the one checked longest ago, never one with a fee', async () => {
    await empty();
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = hostOf();
    expect(await routing.registerEndpoint({ host, path: '/v1/first', checked: checkedBy() })).toBe('created');
    // The rest, 20 to a host, each checked a second after the one before; the 8 oldest have a fee
    const rest = maxCheckedEndpoints - 2;
    for (let index = 0; index < rest; index += 1_000) {
      await database.db.insert(routedEndpoints).values(Array.from({ length: Math.min(1_000, rest - index) }, (_, offset) => {
        const at = new Date(Date.parse('2026-11-11T12:00:00.000Z') + (index + offset) * 1_000);

        return {
          host: `api.bulk-${Math.floor((index + offset) / 20)}.dev`, path: `/v1/${(index + offset) % 20}`, createdAt: at, status: 'checked' as const, checkedAt: at,
          feeBps: index + offset < 8 ? 100 : null,
        };
      }));
    }
    expect(await database.db.$count(routedEndpoints, eq(routedEndpoints.status, 'checked'))).toBe(maxCheckedEndpoints - 1);

    expect(await routing.registerEndpoint({ host, path: '/v1/last', checked: checkedBy() })).toBe('created');
    expect(await database.db.$count(routedEndpoints, eq(routedEndpoints.status, 'checked'))).toBe(maxCheckedEndpoints);
    expect(await routing.registerEndpoint({ host, path: '/v1/one-more', checked: checkedBy() })).toBe('created');

    expect(await database.db.$count(routedEndpoints, eq(routedEndpoints.status, 'checked'))).toBe(maxCheckedEndpoints);
    // The 8 oldest have a fee and stay; the next oldest left
    expect((await rowsOf('api.bulk-0.dev')).map(row => row.path).sort()).toEqual(Array.from({ length: 20 }, (_, index) => `/v1/${index}`)
      .filter(item => item !== '/v1/8').sort());
    await empty();
  });
});

describe('a check\'s registration and a lock it waits for', () => {
  it('gives up after its timeout while another session holds its host\'s lock, and lists nothing', async () => {
    const host = hostOf();
    const holder = new pg.Client({ connectionString: database.url.expose() });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock(7301, hashtext($1))', [host]);
      const started = performance.now();

      const error = await createRoutingRepository({ db: database.db, clock }).registerEndpoint({ host, path: '/v1/x', checked: checkedBy() })
        .then(() => undefined, (thrown: { cause?: { code?: string } }) => thrown);
      const tookMs = performance.now() - started;

      // 57014: the statement was cancelled at its timeout
      expect(error?.cause?.code).toBe('57014');
      expect(tookMs).toBeGreaterThanOrEqual(checkedRegistrationTimeoutMs - 100);
      expect(tookMs).toBeLessThan(checkedRegistrationTimeoutMs + 1_500);
      expect(await rowsOf(host)).toEqual([]);
    }
    finally {
      await holder.end();
    }
  });
});

describe('the endpoint\'s listing as the proxy reads it', () => {
  it('says whether the endpoint and its host are listed, stored, reached by a check, or blocked by a parent domain', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = hostOf();
    const at = (pathname: string, of = host) => routing.endpointListing(of, pathname, { timeoutMs: 1_000 });

    expect(await at('/v1/a')).toEqual({ status: undefined, hostListed: false, checkedEndpoints: 0, stored: false, checkedHost: false, blocked: false, paidCapped: false });
    await routing.registerEndpoint({ host, path: '/v1/a', checked: checkedBy() });
    await routing.registerEndpoint({ host, path: '/v1/paid' });
    await store(host);

    expect(await at('/v1/a')).toEqual({ status: 'checked', hostListed: true, checkedEndpoints: 1, stored: true, checkedHost: true, blocked: false, paidCapped: false });
    expect(await at('/v1/paid')).toMatchObject({ status: 'paid' });
    await routing.block({ host: host.split('.').slice(-2).join('.'), reason: 'abuse' });
    expect(await at('/v1/other')).toMatchObject({ status: undefined, hostListed: true, blocked: true });
  });
});

describe('a host the count stored and dropped', () => {
  it('holds the pool\'s caps and its client\'s charge at every check once it is in the pool: 100 hosts of one parent shrink to 20, and no honest host goes', async () => {
    await empty();
    const routing = createRoutingRepository({ db: database.db, clock });
    // An honest pool of 900, each of a parent of its own, checked before the crowd
    const honest = await fill('honest', 900);
    // 100 hosts of one parent domain, each checked while the count stored it, as one ranked paid call each does: no cap, no charge then
    const crowd = Array.from({ length: 100 }, (_, index) => `h${String(index).padStart(3, '0')}.crowd-parent.dev`);
    clock.set(new Date(Date.parse(noon) + 3_600_000));
    for (const host of crowd) {
      await store(host);
      clock.advance(1_000);
      expect(await routing.registerEndpoint({ host, path: '/v1/x', lastPrice: 1_000n, checked: checkedBy(false) })).toBe('created');
    }
    // The count drops them: the pool holds 1,000, 100 of them of one parent
    await database.db.delete(statsServices).where(sql`${statsServices.host} like '%.crowd-parent.dev'`);
    expect(await pooled()).toBe(1_000);
    const before = await summaryOf(crowd[99]!);

    // A free refresh: none
    clock.advance(1_000);
    expect(await routing.registerEndpoint({ host: crowd[99]!, path: '/v1/x', checked: checkedBy(false) })).toBe('limited');
    expect(await summaryOf(crowd[99]!)).toEqual(before);
    // An honest newcomer at the pool's cap: one of the crowd past its parent's 20 leaves, no honest host
    clock.advance(1_000);
    expect(await routing.registerEndpoint({ host: 'api.newcomer.dev', path: '/v1/x', checked: checkedBy(true) })).toBe('created');
    expect(await summaryOf(honest[0]!)).toBeDefined();
    expect(await summaryOf(crowd[0]!)).toBeUndefined();
    // The crowd refreshed, each check counted: its parent's cap holds it to 20, and every honest host stays
    for (const host of crowd) {
      clock.advance(1_000);
      expect(await routing.registerEndpoint({ host, path: '/v1/x', checked: checkedBy(true) }), host).toMatch(/^(?:created|exists)$/);
    }
    const left = await database.db.$count(checkedHosts, eq(checkedHosts.parent, 'crowd-parent.dev'));
    const kept = await database.db.$count(checkedHosts, sql`${checkedHosts.host} like 'api.honest-%'`);

    expect([left, kept]).toEqual([maxCheckedHostsPerParent, 900]);
    expect(await summaryOf('api.newcomer.dev')).toBeDefined();
    clock.set(noon);
  });
});

describe('the paid hosts\' rows', () => {
  const paidRowOf = async (host: string) => (await database.db.select().from(paidHosts).where(eq(paidHosts.host, host)))[0];

  it('count each listed endpoint once, paid or checked, with the lowest last quote among them, and follow every registration and eviction', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = hostOf();
    const at = (seconds: number) => new Date(Date.parse(noon) + seconds * 1_000);

    expect(await routing.registerEndpoint({ host, path: '/v1/a', lastPrice: 2_000n, checked: checkedBy() })).toBe('created');
    // Listed only by checks: no row
    expect(await paidRowOf(host)).toBeUndefined();
    clock.set(at(10));
    expect(await routing.registerEndpoint({ host, path: '/v1/paid', lastPrice: 3_000n })).toBe('created');
    expect(await paidRowOf(host)).toEqual({ host, registeredAt: at(10), listedAt: new Date(noon), paidEndpoints: 1, endpoints: 2, priceFrom: 2_000n });
    // A checked one becomes paid: counted once
    clock.set(at(20));
    expect(await routing.registerEndpoint({ host, path: '/v1/a', lastPrice: 1_500n })).toBe('exists');
    expect(await paidRowOf(host)).toMatchObject({ registeredAt: at(20), paidEndpoints: 2, endpoints: 2, priceFrom: 1_500n });
    // A check registers it too: the list shows the most recently registered first
    clock.set(at(30));
    expect(await routing.registerEndpoint({ host, path: '/v1/c', lastPrice: 900n, checked: checkedBy() })).toBe('created');
    expect(await paidRowOf(host)).toMatchObject({ registeredAt: at(30), paidEndpoints: 2, endpoints: 3, priceFrom: 900n });
    // Pushed out of the pool: its checked endpoint goes, its paid ones stay
    expect(await database.db.transaction(async tx => evictCheckedHost(tx, host))).toBe(true);
    expect(await paidRowOf(host)).toMatchObject({ registeredAt: at(30), paidEndpoints: 2, endpoints: 2, priceFrom: 1_500n });
    clock.set(noon);
  });

  it('are mended by the workers from the routed endpoints, a window at a time: hosts from before the table, and never over a newer row', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const hosts = ['older-a.backfill.dev', 'older-b.backfill.dev', 'older-c.backfill.dev'];
    await database.db.insert(routedEndpoints).values([
      ...hosts.map((host, index) => ({ host, path: '/v1/paid', lastPrice: 1_000n + BigInt(index), createdAt: new Date(Date.parse(noon) - (index + 1) * 60_000), status: 'paid' as const })),
      { host: hosts[0]!, path: '/v1/checked', lastPrice: 500n, createdAt: new Date(Date.parse(noon) - 3_600_000), status: 'checked' as const, checkedAt: new Date(noon) },
      // Listed only by a check: no paid host
      { host: 'checked-only.backfill.dev', path: '/v1/x', createdAt: new Date(noon), status: 'checked' as const, checkedAt: new Date(noon) },
    ]);
    await database.db.delete(paidHosts).where(sql`${paidHosts.host} like '%.backfill.dev'`);
    await database.db.delete(statsAnswers).where(eq(statsAnswers.key, 'fill:paid_hosts'));
    // One a registration made a row for, newer than its endpoints, keeps it
    await database.db.insert(paidHosts).values({ host: hosts[2]!, registeredAt: new Date(noon), listedAt: new Date(noon), paidEndpoints: 1, endpoints: 1, priceFrom: 7n });
    const runs: { fixed: number; read: number; caughtUp: boolean }[] = [];
    for (let run = 0; run < 100 && !runs.at(-1)?.caughtUp; run += 1)
      runs.push(await routing.fillPaidHosts({ batch: 2, timeoutMs: 5_000 }));

    expect(await paidRowOf(hosts[0]!)).toEqual({
      host: hosts[0], registeredAt: new Date(Date.parse(noon) - 60_000), listedAt: new Date(Date.parse(noon) - 3_600_000), paidEndpoints: 1, endpoints: 2, priceFrom: 500n,
    });
    expect(await paidRowOf(hosts[1]!)).toMatchObject({ endpoints: 1, priceFrom: 1_001n });
    expect(await paidRowOf(hosts[2]!)).toMatchObject({ priceFrom: 7n });
    expect(await paidRowOf('checked-only.backfill.dev')).toBeUndefined();
    // At most 2 hosts a call
    expect(Math.max(...runs.map(run => run.fixed))).toBeLessThanOrEqual(2);
  });

  it('are mended at every run, with no end: an endpoint a replica of older code registered later makes its host\'s row stale, and the next call mends it', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = 'rollout.backfill.dev';
    // Past every endpoint the other tests wrote
    clock.set(new Date(Date.parse(noon) + 2 * 86_400_000));
    expect(await routing.registerEndpoint({ host, path: '/v1/a', lastPrice: 2_000n })).toBe('created');
    while (!(await routing.fillPaidHosts({ batch: 100, timeoutMs: 5_000 })).caughtUp);
    // Caught up: a call with nothing to mend reads the last few minutes, and mends nothing
    const idle = await routing.fillPaidHosts({ batch: 100, timeoutMs: 5_000 });
    expect(idle).toMatchObject({ fixed: 0, caughtUp: true });
    expect(idle.read).toBeLessThan(10);
    // Written as older code writes: the endpoint and nothing else
    clock.advance(60_000);
    await database.db.insert(routedEndpoints).values({ host, path: '/v1/b', lastPrice: 900n, createdAt: clock.now(), status: 'paid' });
    expect(await paidRowOf(host)).toMatchObject({ endpoints: 1, priceFrom: 2_000n });

    expect(await routing.fillPaidHosts({ batch: 100, timeoutMs: 5_000 })).toMatchObject({ fixed: 1, caughtUp: true });
    expect(await paidRowOf(host)).toMatchObject({ registeredAt: clock.now(), paidEndpoints: 2, endpoints: 2, priceFrom: 900n });
    clock.set(noon);
  });

  it('hold a registration of a host they mend for one batch at most', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    // 100 hosts of 1,000 endpoints each from before the table, their times woven: one window holds all 100
    const hosts = Array.from({ length: 100 }, (_, index) => `woven-${index}.backfill.dev`);
    const start = Date.parse(noon) - 86_400_000;
    for (let item = 0; item < 1_000; item += 10) {
      await database.db.insert(routedEndpoints).values(hosts.flatMap((host, index) => Array.from({ length: 10 }, (_, offset) => ({
        host, path: `/v1/item/${item + offset}`, lastPrice: 1_000n, createdAt: new Date(start + ((item + offset) * 100 + index) * 10), status: 'paid' as const,
      }))));
    }
    await database.db.insert(statsAnswers).values({ key: 'fill:paid_hosts', answer: { createdAt: new Date(start - 1).toISOString(), host: '', path: '' }, countedAt: clock.now() })
      .onConflictDoUpdate({ target: statsAnswers.key, set: { answer: sql`excluded.answer` } });

    const fill = (async () => {
      const started = performance.now();
      const result = await routing.fillPaidHosts({ batch: 100, timeoutMs: 5_000 });

      return { ...result, ms: performance.now() - started };
    })();
    // Once the batch holds the hosts' locks, a registration of one of them waits for it
    for (;;) {
      const { rows } = await database.db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and classid = 7301 and granted`);
      if (rows.length >= 100)
        break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const started = performance.now();
    expect(await routing.registerEndpoint({ host: hosts[0]!, path: '/v1/item/0', lastPrice: 800n })).toBe('exists');
    const waitedMs = performance.now() - started;
    const mended = await fill;

    expect(mended.fixed).toBe(100);
    // One batch: 100 hosts' rows from their 100,000 endpoints, measured 20 to 60 ms here
    expect(waitedMs).toBeLessThan(mended.ms + 50);
    expect(waitedMs).toBeLessThan(2_000);
    expect(await paidRowOf(hosts[0]!)).toMatchObject({ paidEndpoints: 1_000, endpoints: 1_000, priceFrom: 800n });
    await database.db.delete(routedEndpoints).where(sql`${routedEndpoints.host} like 'woven-%'`);
    await database.db.delete(paidHosts).where(sql`${paidHosts.host} like 'woven-%'`);
    await database.db.delete(statsAnswers).where(eq(statsAnswers.key, 'fill:paid_hosts'));
  }, 60_000);
});

describe('what a check lists of a host', () => {
  it('is no new endpoint of a host at its 1,000 paid ones, while one listed already still refreshes', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = 'paid-cap.capped-checks.dev';
    await database.db.insert(routedEndpoints).values(Array.from({ length: maxRoutedEndpointsPerHost }, (_, index) => ({
      host, path: `/v1/item/${index}`, lastPrice: 1_000n, createdAt: new Date(Date.parse(noon) - index * 1_000), status: 'paid' as const,
    })));

    expect((await routing.endpointListing(host, '/v1/new', { timeoutMs: 1_000 })).paidCapped).toBe(true);
    expect(await routing.registerEndpoint({ host, path: '/v1/new', checked: checkedBy() })).toBe('capped');
    expect(await routing.registerEndpoint({ host, path: '/v1/item/7', checked: checkedBy() })).toBe('exists');
    expect(await database.db.$count(routedEndpoints, eq(routedEndpoints.host, host))).toBe(maxRoutedEndpointsPerHost);
    await database.db.delete(routedEndpoints).where(eq(routedEndpoints.host, host));
  });

  it('is nothing of a name of more than 8 labels, while a paid call still registers one', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const named = (labels: number) => Array.from({ length: labels - 1 }, (_, index) => `l${index}`).concat('labels.dev').join('.');
    const [eight, nine] = [named(maxCheckedHostLabels - 1), named(maxCheckedHostLabels)];

    expect(eight.split('.')).toHaveLength(maxCheckedHostLabels);
    expect(await routing.registerEndpoint({ host: `${eight}:8443`, path: '/v1/x', checked: checkedBy() })).toBe('created');
    expect(await routing.registerEndpoint({ host: nine, path: '/v1/x', checked: checkedBy() })).toBe('capped');
    expect(await rowsOf(nine)).toEqual([]);
    expect(await routing.registerEndpoint({ host: nine, path: '/v1/x', lastPrice: 1_000n })).toBe('created');
  });
});

describe('the routed endpoints\' key', () => {
  it('takes a host of 259 bytes and a path of 2,048, and refuses a path of 2,049 bytes or a longer host, so its index row stays small', async () => {
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}:65535`;
    const insert = (values: { host: string; path: string }) => database.db.insert(routedEndpoints).values({ ...values, createdAt: clock.now(), status: 'paid' });
    const constraintOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
      promise.then(() => undefined, (error: { cause?: { constraint?: string } }) => error.cause?.constraint);

    expect(host).toHaveLength(259);
    await insert({ host, path: `/${'p'.repeat(2_047)}` });
    expect(await constraintOf(insert({ host, path: `/${'p'.repeat(2_048)}` }))).toBe('routed_endpoints_key_check');
    expect(await constraintOf(insert({ host: `${host}0`, path: '/v1' }))).toBe('routed_endpoints_key_check');
    // Characters of two bytes count as two
    expect(await constraintOf(insert({ host: 'multi.byte.dev', path: `/${'é'.repeat(1_024)}` }))).toBe('routed_endpoints_key_check');
    const { rows } = await database.db.execute<{ bytes: number }>(sql`select max(pg_column_size(row(host, path)))::int as bytes from routed_endpoints where host = ${host}`);
    expect(rows[0]!.bytes).toBeLessThan(2_704);
    await database.db.delete(routedEndpoints).where(and(eq(routedEndpoints.host, host)));
  });
});

describe('the migrations that list checked endpoints and paid hosts', () => {
  it('make a table of their own for the paid hosts, and the catalog\'s index of the whole key, taking no exclusive lock of another table', async () => {
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // Later migrations may follow it
    const tag = '0011_paid_hosts';
    const text = await readFile(path.join(migrationsFolder, `${tag}.sql`), 'utf8');
    const statements = text.split('--> statement-breakpoint').map(part => part.trim()).filter(part => part !== '');

    expect(journal.entries.map(entry => entry.tag)).toContain(tag);
    // An index built takes a share lock of its table: writes wait for it, reads don't. The old index's drop, the one
    // exclusive lock, comes last, so it is held only to the commit.
    expect(statements.map(statement => statement.split('(', 1)[0]!.trim())).toEqual([
      'CREATE TABLE "paid_hosts"', 'CREATE INDEX "paid_hosts_registered_idx" ON "paid_hosts" USING btree',
      'CREATE INDEX "routed_endpoints_catalog_idx" ON "routed_endpoints" USING btree', 'DROP INDEX "routed_endpoints_created_idx";',
    ]);
  });

  it('mark every endpoint registered before them paid', async () => {
    const fresh = await createTestDatabase({ migrate: false });
    try {
      const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      const tags = journal.entries.map(entry => entry.tag);
      // Later migrations may follow it: only those before it are applied first
      const at = tags.findIndex(tag => tag.endsWith('_checked_endpoints'));
      expect(at).toBeGreaterThan(0);
      expect((await readdir(migrationsFolder)).filter(name => name.endsWith('.sql'))).toHaveLength(tags.length);
      const apply = async (tag: string): Promise<void> => {
        const text = await readFile(path.join(migrationsFolder, `${tag}.sql`), 'utf8');
        for (const statement of text.split('--> statement-breakpoint').map(part => part.trim()).filter(part => part !== ''))
          await fresh.db.execute(sql.raw(statement));
      };
      for (const tag of tags.slice(0, at))
        await apply(tag);
      await fresh.db.execute(sql`insert into routed_endpoints (host, path, fee_bps, last_price, created_at) values
        ('before.example.com', '/v1/a', 150, 1100, ${noon}::timestamptz), ('before.example.com', '/v1/b', null, null, ${noon}::timestamptz)`);

      await apply(tags[at]!);

      const { rows } = await fresh.db.execute<{ path: string; status: string; checked_at: string | null; fee_bps: number | null }>(sql`select path, status, checked_at, fee_bps
        from routed_endpoints order by path`);
      expect(rows).toEqual([
        { path: '/v1/a', status: 'paid', checked_at: null, fee_bps: 150 },
        { path: '/v1/b', status: 'paid', checked_at: null, fee_bps: null },
      ]);
    }
    finally {
      await fresh.drop();
    }
  });
});
