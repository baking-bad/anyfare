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
  maxCheckedHosts, maxCheckedHostsPerParent, maxRoutedEndpointsPerHost, migrationsFolder, routedEndpoints, statsServices, type EndpointInput,
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
    expect(await routing.registerEndpoint({ host, path: '/v1/pools', lastPrice: 1_200n, checked: checkedBy(false, 'POST') })).toBe('exists');

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

  it('adds a host to the pool only when the check\'s client was counted for a new one', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const host = hostOf();

    expect(await routing.registerEndpoint({ host, path: '/v1/a', checked: checkedBy(false) })).toBe('limited');
    expect(await rowsOf(host)).toEqual([]);
    expect(await summaryOf(host)).toBeUndefined();
    expect(await routing.registerEndpoint({ host, path: '/v1/a', checked: checkedBy(true) })).toBe('created');
    // A host in the pool already takes more without a count
    expect(await routing.registerEndpoint({ host, path: '/v1/b', checked: checkedBy(false) })).toBe('created');
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

    expect(await at('/v1/a')).toEqual({ status: undefined, hostListed: false, checkedEndpoints: 0, stored: false, checkedHost: false, blocked: false });
    await routing.registerEndpoint({ host, path: '/v1/a', checked: checkedBy() });
    await routing.registerEndpoint({ host, path: '/v1/paid' });
    await store(host);

    expect(await at('/v1/a')).toEqual({ status: 'checked', hostListed: true, checkedEndpoints: 1, stored: true, checkedHost: true, blocked: false });
    expect(await at('/v1/paid')).toMatchObject({ status: 'paid' });
    await routing.block({ host: host.split('.').slice(-2).join('.'), reason: 'abuse' });
    expect(await at('/v1/other')).toMatchObject({ status: undefined, hostListed: true, blocked: true });
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

describe('the migration that lists checked endpoints', () => {
  it('marks every endpoint registered before it paid', async () => {
    const fresh = await createTestDatabase({ migrate: false });
    try {
      const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      const tags = journal.entries.map(entry => entry.tag);
      const at = tags.findIndex(tag => tag.endsWith('_checked_endpoints'));
      expect(at).toBe(tags.length - 1);
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
