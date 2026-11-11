import { describe, expect, it } from 'vitest';

import { createBlocklistMatcher, endpointListEntry, endpointNumbersOf, type TopAnswer } from '@anyfare/core';
import type { HostListing, ListedServiceRow, ListedServices } from '@anyfare/db';
import { createFakeClock } from '@anyfare/testing';

import {
  createShownServices, isUnlisted, listedEndpoints, listedPage, servicesPage, servicesTotals, shownServices, topWithoutBlocked,
} from '../../src/stats/listed.js';
import { createSnapshotCache } from '../../src/stats/live.js';

// What the list, a service's page and the top lists show of what the reads gave, without a database

const noon = new Date('2026-11-20T12:00:00.000Z');
const payUrl = 'https://pay.anyfare.test';
const minutes = (count: number): Date => new Date(noon.getTime() - count * 60_000);
const none = () => false;

const row = (host: string, changes: Partial<ListedServiceRow> = {}): ListedServiceRow => ({
  kind: 'stored', hostHash: host, host, status: 'paid', paidEndpoints: 1, priceFrom: 1_000n, calls: 1, buyers: 1, volume: 1_000n, successRate: 1, p50Ms: 100,
  trend: [], countedAt: noon, listedAt: minutes(60), checkedAt: undefined, ...changes,
});
const pooled = (host: string, checkedMinutesAgo: number, changes: Partial<ListedServiceRow> = {}): ListedServiceRow => row(host, {
  kind: 'checked', status: 'checked', calls: 0, buyers: 0, volume: 0n, successRate: null, p50Ms: null, countedAt: undefined,
  checkedAt: minutes(checkedMinutesAgo), listedAt: minutes(checkedMinutesAgo), ...changes,
});
const listedOf = (rows: readonly ListedServiceRow[], changes: Partial<ListedServices> = {}): ListedServices => ({
  rows, stored: rows.filter(each => each.kind === 'stored').length, totals: { answer: { services: 3, paidEndpoints: 9, calls30d: 40 }, countedAt: minutes(5) },
  marks: { recent: minutes(2), all: undefined }, ...changes,
});
const listing = (changes: Partial<HostListing> = {}): HostListing => ({
  blocked: false, paid: false, stored: false, paidSummary: undefined, paidRows: [], listedAt: undefined, checkedAt: undefined, checkedCount: 0, checked: [],
  checkedTimes: new Map(), pooled: false, poolHidden: false, paidHidden: false, ...changes,
});
const ranked = (path: string, calls: number) => endpointListEntry({
  host: 'api.example.com', path, method: 'GET', price: 1_000n, payUrl,
  numbers: endpointNumbersOf({ calls, volume: BigInt(calls) * 1_000n, buyers: 1, free: 0, p50Ms: 90, p95Ms: 90, ways: [] }),
});

describe('the services the list shows', () => {
  it('shows at most 20 hosts of the pool of one parent domain, the most recently checked first, and every paid one whatever its parent', () => {
    // 100 hosts of one parent in the pool, an honest one of another, and paid ones of that parent
    const crowd = Array.from({ length: 100 }, (_, index) => pooled(`h${index}.crowd.example`, index));
    const rows = [
      row('api.crowd.example'), row('pay.crowd.example', { kind: 'paid', countedAt: undefined, calls: 0 }), ...crowd.slice(0, 50), pooled('honest.example.net', 50),
      ...crowd.slice(50),
    ];

    const shown = shownServices(listedOf(rows), none);
    const ofCrowd = shown.filter(each => each.kind === 'checked' && each.host.endsWith('.crowd.example'));

    expect(ofCrowd.map(each => each.host)).toEqual(Array.from({ length: 20 }, (_, index) => `h${index}.crowd.example`));
    expect(shown.map(each => each.host)).toEqual(expect.arrayContaining(['api.crowd.example', 'pay.crowd.example', 'honest.example.net']));
    expect(shown).toHaveLength(2 + 20 + 1);
  });

  it('counts a blocked host of the pool toward its parent\'s 20, as a service\'s page does: the 21st newest isn\'t shown', () => {
    // 21 hosts of one parent listed only by checks, the newest blocked
    const crowd = Array.from({ length: 21 }, (_, index) => pooled(`h${index}.crowded.example`, index));
    const shown = shownServices(listedOf(crowd), createBlocklistMatcher(['h0.crowded.example']));

    expect(shown.map(each => each.host)).toEqual(crowd.slice(1, 20).map(each => each.host));
  });

  it('leaves out a host the blocklist names or names a parent domain of, and shows each host once, its first kind', () => {
    const isBlocked = createBlocklistMatcher(['blocked.example.com', 'evil.example']);
    const rows = [row('blocked.example.com'), row('a.b.evil.example'), row('fine.example.com'), pooled('fine.example.com', 1), pooled('evil.example', 1), pooled('notevil.example', 1)];

    expect(shownServices(listedOf(rows), isBlocked).map(each => [each.host, each.kind])).toEqual([['fine.example.com', 'stored'], ['notevil.example', 'checked']]);
  });
});

describe('the totals of the list', () => {
  it('count what the list shows, each service once: its paid ones, and their listed endpoints, of paid calls and of checks', () => {
    const rows = [
      row('a.example.com', { paidEndpoints: 4, calls: 30 }), row('b.example.com', { paidEndpoints: 2, calls: 10 }),
      row('c.example.com', { kind: 'paid', paidEndpoints: 1000, calls: 0, countedAt: undefined }), pooled('d.example.net', 1, { paidEndpoints: 20 }),
    ];
    const isBlocked = createBlocklistMatcher(['b.example.com']);
    const listed = listedOf(rows);
    const shown = shownServices(listed, isBlocked);

    // The count's calls without the stored one blocked; its endpoints with what the list shows
    expect(servicesTotals({ listed, shown, isBlocked })).toEqual({ services: 3, paidServices: 2, paidEndpoints: 4 + 1000 + 20, calls30d: 40 - 10 });
    expect(servicesTotals({ listed: listedOf([], { totals: undefined }), shown: [], isBlocked: none })).toEqual({ services: 0, paidServices: 0, paidEndpoints: 0, calls30d: 0 });
  });
});

describe('a page of the list', () => {
  const rows = [
    row('alpha.example.com', { calls: 10, buyers: 3, volume: 100_000n, paidEndpoints: 3, priceFrom: 900n, listedAt: minutes(60) }),
    row('beta.example.org', { calls: 5, buyers: 4, volume: 20_000n, priceFrom: 2_000n, listedAt: minutes(59) }),
    row('gamma.example.org', { kind: 'paid', calls: 0, buyers: 0, volume: 0n, priceFrom: undefined, countedAt: undefined, listedAt: minutes(30), trend: [] }),
    pooled('newer.example.net', 39, { paidEndpoints: 2, priceFrom: 1_000n }),
    pooled('aged.example.net', 50, { priceFrom: 3_000n }),
  ];
  const services = createShownServices(listedOf(rows), none);
  const hosts = (sort: Parameters<typeof services.sorted>[0]) => services.sorted(sort).map(each => each.host);

  it('sorts by each order, paid services first by calls and the checked ones the newest first', () => {
    expect(hosts('calls')).toEqual(['alpha.example.com', 'beta.example.org', 'gamma.example.org', 'newer.example.net', 'aged.example.net']);
    expect(hosts('buyers')).toEqual(['beta.example.org', 'alpha.example.com', 'gamma.example.org', 'aged.example.net', 'newer.example.net']);
    expect(hosts('volume')).toEqual(['alpha.example.com', 'beta.example.org', 'gamma.example.org', 'aged.example.net', 'newer.example.net']);
    expect(hosts('endpoints')).toEqual(['alpha.example.com', 'newer.example.net', 'aged.example.net', 'beta.example.org', 'gamma.example.org']);
    expect(hosts('price')).toEqual(['alpha.example.com', 'newer.example.net', 'beta.example.org', 'aged.example.net', 'gamma.example.org']);
    expect(hosts('newest')).toEqual(['gamma.example.org', 'newer.example.net', 'aged.example.net', 'beta.example.org', 'alpha.example.com']);
  });

  it('searches a part of the host, pages what matches, and gives the totals of all and the oldest time it shows', () => {
    const page = servicesPage({ services, q: '.org', sort: 'calls', page: 2, size: 1, now: noon });

    expect(page.services.map(each => each.host)).toEqual(['gamma.example.org']);
    expect(page).toMatchObject({ page: 2, size: 1, total: 2, totalCapped: true, totals: { services: 5, paidServices: 3 }, updatedAt: minutes(5).toISOString() });
    // A service not stored shows no numbers and a trend of zeros
    expect(page.services[0]).toMatchObject({ status: 'paid', calls: 0, volume: '0', priceFrom: null, trend: Array.from({ length: 30 }, () => 0) });
    expect(servicesPage({ services, q: 'nowhere', sort: 'calls', page: 1, size: 20, now: noon })).toMatchObject({ services: [], total: 0 });
  });
});

describe('a service page\'s endpoints', () => {
  it('lists its paid endpoints with calls first, then its other paid ones with no numbers, then those only checked, each once', () => {
    const endpoints = listedEndpoints({
      host: 'api.example.com', payUrl,
      ranked: [ranked('/v1/busy', 9), ranked('/v1/quiet', 2)],
      listing: listing({
        paid: true,
        checkedTimes: new Map([['/v1/quiet', minutes(3)]]),
        paidRows: [
          { path: '/v1/idle', method: null, price: 500n, checkedAt: undefined }, { path: '/v1/busy', method: null, price: 1_000n, checkedAt: undefined },
          { path: '/v1/confirmed', method: 'POST', price: 700n, checkedAt: minutes(1) },
        ],
        checked: [{ path: '/v1/checked', method: 'GET', price: 300n, checkedAt: minutes(2) }],
        checkedCount: 1,
      }),
    });

    expect(endpoints.map(each => [each.path, each.status, each.calls, each.checkedAt])).toEqual([
      ['/v1/busy', 'paid', 9, null], ['/v1/quiet', 'paid', 2, minutes(3).toISOString()], ['/v1/idle', 'paid', 0, null],
      ['/v1/confirmed', 'paid', 0, minutes(1).toISOString()], ['/v1/checked', 'checked', 0, minutes(2).toISOString()],
    ]);
    expect(endpoints[2]).toEqual({
      path: '/v1/idle', method: null, priceNow: '0.0005', calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null,
      link: 'https://pay.anyfare.test/api.example.com/v1/idle', status: 'paid', checkedAt: null,
    });
  });

  it('keeps within 100 endpoints, paths of at most 512 characters and 24 KB of them, skipping one that doesn\'t fit for the next', () => {
    const many = Array.from({ length: 150 }, (_, index) => ({ path: `/v1/${index}`, method: null, price: 1_000n, checkedAt: undefined }));
    const long = (count: number, chars: number) => Array.from({ length: count }, (_, index) => ({ path: `/${String(index).padStart(3, '0')}${'p'.repeat(chars - 4)}`, method: null, price: 1n, checkedAt: undefined }));

    expect(listedEndpoints({ host: 'h.example.com', payUrl, ranked: [], listing: listing({ paidRows: many }) })).toHaveLength(100);
    // 99 paths of 244 characters leave 420 of the 24,576: one of 512 is skipped, one of 400 fits
    const tight = listedEndpoints({
      host: 'h.example.com', payUrl, ranked: [],
      listing: listing({ paidRows: [...long(99, 244), { path: `/${'x'.repeat(511)}`, method: null, price: 1n, checkedAt: undefined }, { path: `/${'y'.repeat(399)}`, method: null, price: 1n, checkedAt: undefined }] }),
    });
    expect(tight.map(each => each.path.length).slice(-2)).toEqual([244, 400]);
    expect(tight.reduce((sum, each) => sum + each.path.length, 0)).toBeLessThanOrEqual(24_576);
    expect(listedEndpoints({ host: 'h.example.com', payUrl, ranked: [ranked(`/${'z'.repeat(512)}`, 1)], listing: listing() })).toEqual([]);
  });

  it('counts its listed endpoints as its row of paid hosts does, or before one the count\'s and those only checked', () => {
    const common = { host: 'api.example.com', payUrl, ranked: [ranked('/v1/busy', 9)], status: 'paid' as const };

    expect(listedPage({ ...common, countedEndpoints: 1, listing: listing({ paid: true, checkedCount: 2, paidSummary: { endpoints: 1_020, priceFrom: 1n } }) }).paidEndpoints).toBe(1_020);
    expect(listedPage({ ...common, countedEndpoints: 1, listing: listing({ paid: true, checkedCount: 2 }) }).paidEndpoints).toBe(3);
  });
});

describe('whether a service page is found', () => {
  it.each([
    ['a stored service', listing({ paid: true }), true, true, false],
    ['a stored one on the blocklist', listing({ paid: true, blocked: true }), true, true, true],
    ['a paid one the count doesn\'t store', listing({ paid: true }), false, true, false],
    ['a paid one outside the newest the list shows', listing({ paid: true, paidHidden: true }), false, true, true],
    ['a paid one asked for before its listing says so', listing(), false, true, false],
    ['a checked one', listing({ pooled: true, checkedCount: 1 }), false, false, false],
    ['a checked one outside the pool the list shows, a blocked one of its parent counted', listing({ pooled: true, checkedCount: 1, poolHidden: true }), false, false, true],
    ['a host with a checked endpoint the list doesn\'t read as of the pool', listing({ checkedCount: 1 }), false, false, true],
    ['a host neither reached', listing(), false, false, true],
  ])('%s', (_case, listed, stored, paid, unlisted) => {
    expect(isUnlisted(listed, stored, paid)).toBe(unlisted);
  });
});

describe('the top lists', () => {
  it('leave out a host the blocklist names or names a parent domain of, and keep the rest in their order', () => {
    const top: TopAnswer = {
      services: [{ host: 'a.evil.example', calls: 9 }, { host: 'fine.example.com', calls: 5 }],
      endpoints: [{ host: 'evil.example', path: '/x', calls: 4 }, { host: 'fine.example.com', path: '/y', calls: 3 }, { host: 'notevil.example', path: '/z', calls: 1 }],
      paidWith: [{ paidWith: 'base', calls: 10 }],
      topupTokens: [],
    };

    expect(topWithoutBlocked(top, createBlocklistMatcher(['evil.example']))).toEqual({
      ...top, services: [{ host: 'fine.example.com', calls: 5 }], endpoints: [{ host: 'fine.example.com', path: '/y', calls: 3 }, { host: 'notevil.example', path: '/z', calls: 1 }],
    });
  });
});

describe('a snapshot in the process', () => {
  it('serves one read to every caller for its time, never keeps a failed one, and reads again after', async () => {
    const clock = createFakeClock(noon);
    let reads = 0;
    let failing = false;
    const cache = createSnapshotCache({
      clock, ttlMs: 5_000, read: async () => {
        reads += 1;
        if (failing)
          throw new Error('canceling statement due to statement timeout');

        return reads;
      },
    });

    expect(await Promise.all([cache.get(), cache.get()])).toEqual([1, 1]);
    clock.advance(4_999);
    expect(await cache.get()).toBe(1);
    clock.advance(1);
    failing = true;
    await expect(cache.get()).rejects.toThrow('statement timeout');
    failing = false;
    expect(await cache.get()).toBe(3);
  });
});
