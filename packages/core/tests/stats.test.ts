import { describe, expect, it } from 'vitest';

import type { MicroUsd } from '@anyfare/common';

import {
  buildEndpointAnswer, buildLiveAnswer, buildServicePage, buildStoredEndpoint, buildTopAnswer, composePlatformAnswer, createBlocklistMatcher, createPaidWith,
  endpointListEntry, endpointNumbersOf, hostLabels, lastUtcDays, parentDomainOf, periodBefore, periodStart, type LiveTail,
} from '../src/index.js';
import { examplePlatform } from './fixtures.js';

const noon = new Date('2026-12-15T12:00:00.000Z');

const tail = (changes: Partial<LiveTail> = {}): LiveTail => ({
  from: noon, at: noon, calls: 0, volume: 0n, todayCalls: 0, todayVolume: 0n, todayNear: 0, todayBuyers: 0, perMinute: [], ...changes,
});

describe('the periods of the public numbers', () => {
  it('are UTC days: today from midnight, 7 and 30 days with today, and the period before ends where one starts', () => {
    expect(periodStart('today', noon)).toEqual(new Date('2026-12-15T00:00:00.000Z'));
    expect(periodStart('7d', noon)).toEqual(new Date('2026-12-09T00:00:00.000Z'));
    expect(periodStart('30d', noon)).toEqual(new Date('2026-11-16T00:00:00.000Z'));
    expect(periodStart('all', noon)).toBeUndefined();
    expect(periodBefore('7d', noon)).toEqual({ from: new Date('2026-12-02T00:00:00.000Z'), to: new Date('2026-12-09T00:00:00.000Z') });
    // A millisecond before midnight is still the day before
    expect(periodStart('today', new Date('2026-12-14T23:59:59.999Z'))).toEqual(new Date('2026-12-14T00:00:00.000Z'));
    expect(periodStart('today', new Date('2026-12-15T00:00:00.000Z'))).toEqual(new Date('2026-12-15T00:00:00.000Z'));
    expect(lastUtcDays(new Date('2026-12-02T00:00:00.000Z'), 3)).toEqual(['2026-11-30', '2026-12-01', '2026-12-02']);
  });
});

describe('the answers of the counts', () => {
  it('are zeros on zero-filled days before a count', () => {
    const answer = composePlatformAnswer(undefined, undefined, noon);

    expect(answer.calls).toEqual({ today: 0, '7d': 0, '30d': 0, all: 0 });
    expect(answer.daily).toHaveLength(30);
    expect(answer.daily.at(-1)).toEqual({ day: '2026-12-15', calls: 0, volume: '0' });
    expect(buildEndpointAnswer({ host: 'one.example.com', path: '/v1', period: 'today', numbers: undefined, daily: [], dailyTo: noon, exact: true })).toMatchObject({
      stats: { calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null }, byPaidWith: [], daily: expect.arrayContaining([{ day: '2026-12-02', calls: 0 }]),
    });
  });

  it('never name a Credits buyer, whatever the counts hold, and leave unknown payers out of the returning share', () => {
    const page = buildServicePage({
      host: 'one.example.com', period: 'all', callsBefore: undefined, daily: [], now: noon,
      counts: {
        calls: 3, volume: 30_000n, buyers: 3, free: 0, p50Ms: 10, p95Ms: 10, paidEndpoints: 1, ways: [], knownBuyers: 2, returning: 1,
        topBuyers: [{ payer: 'acc_named', paidWith: 'credits', calls: 2, spent: 20_000n, lastCallAt: noon }],
      },
    });

    expect(page.topBuyers).toEqual({ share: 0.6667, buyers: [{ payer: null, paidWith: 'credits', calls: 2, spent: '0.02', lastCallAt: noon.toISOString() }] });
    expect(page.stats).toMatchObject({ buyers: 3, returningShare: 0.5, callsBefore: null });
    expect(JSON.stringify(page)).not.toContain('acc_named');
  });

  it('give a success rate of 0 when every call failed, and none without a finished call', () => {
    expect(endpointNumbersOf({ calls: 0, volume: 0n, buyers: 0, free: 4, p50Ms: 50, p95Ms: 50, ways: [] }).successRate).toBe(0);
    expect(endpointNumbersOf(undefined).successRate).toBeNull();
  });

  it('keep an endpoint\'s 14 days to its count\'s, and link it on the pay host when it\'s listed', () => {
    const stored = buildStoredEndpoint({
      hostHash: 'h', pathHash: 'p', path: '/v1/x', method: 'GET', price: 5_000n, daily: [{ day: '2026-12-15', calls: 2 }, { day: '2026-12-02', calls: 1 }],
      periods: { today: { calls: 2, volume: 20_000n, buyers: 1, free: 0, p50Ms: 9, p95Ms: 9, ways: [{ paidWith: 'base', calls: 2 }] } },
    }, noon);

    expect(stored.daily).toEqual([1, ...Array.from({ length: 12 }, () => 0), 2]);
    expect(stored.recent['30d']).toEqual({ calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null, byPaidWith: [] });
    expect(endpointListEntry({ host: 'one.example.com', path: stored.path, method: stored.method, price: stored.price, numbers: stored.recent.today, payUrl: 'https://pay.anyfare.test/' }))
      .toMatchObject({ priceNow: '0.005', calls: 2, link: 'https://pay.anyfare.test/one.example.com/v1/x' });
  });
});

describe('the live answer', () => {
  it('adds the tail to the base\'s today and minutes, counts today\'s buyers by the tail\'s union, and gives the last 30 minutes with zeros', () => {
    const at = new Date('2026-12-15T12:00:30.000Z');
    const minute = (time: string) => Date.parse(time);
    const answer = buildLiveAnswer(
      {
        day: '2026-12-15', today: { calls: 3, volume: '30000', nearCalls: 1, buyers: 2 }, buyersKept: 2,
        minutes: [[minute('2026-12-15T11:00:00.000Z'), 2, '20000'], [minute('2026-12-14T11:59:00.000Z'), 1, '5000'], [minute('2026-12-14T10:00:00.000Z'), 4, '7000']],
      },
      tail({ at, calls: 1, volume: 10_000n, todayCalls: 1, todayVolume: 10_000n, todayNear: 1, todayBuyers: 3, perMinute: [{ minute: new Date('2026-12-15T12:00:00.000Z'), calls: 1 }] }),
    );

    expect(answer).toMatchObject({
      at: at.toISOString(),
      today: { calls: 4, volume: '0.04', buyers: 3, nearShare: 0.5 },
      // From 12:00 the day before, to the minute: the minute at 11:59 is before it
      last24h: { calls: 3, volume: '0.03', volumeBefore: '0.012' },
    });
    expect(answer.perMinute).toHaveLength(30);
    expect([answer.perMinute[0], answer.perMinute[29]]).toEqual([{ minute: '2026-12-15T11:31:00.000Z', calls: 0 }, { minute: '2026-12-15T12:00:00.000Z', calls: 1 }]);
  });

  it('counts today from the tail alone after midnight, and today\'s buyers by the base when it kept too many to tell new ones apart', () => {
    const base = { day: '2026-12-14', today: { calls: 9, volume: '90000', nearCalls: 0, buyers: 200_000 }, buyersKept: 100_000, minutes: [] };

    expect(buildLiveAnswer(base, tail({ todayCalls: 1, todayBuyers: 1 })).today).toMatchObject({ calls: 1, buyers: 1 });
    expect(buildLiveAnswer({ ...base, day: '2026-12-15' }, tail({ todayCalls: 1, todayBuyers: 100_001 })).today).toMatchObject({ calls: 10, buyers: 200_000 });
  });
});

describe('how a payment was paid', () => {
  it('names each rail on each of the config\'s networks', () => {
    const { ways } = createPaidWith(examplePlatform);

    expect(ways).toEqual(expect.arrayContaining([
      { rail: 'x402', network: 'eip155:84532', paidWith: 'base' }, { rail: 'x402', network: 'near:testnet', paidWith: 'near' },
      { rail: 'mpp', network: 'eip155:42431', paidWith: 'tempo' }, { rail: 'x402', network: 'eip155:42431', paidWith: 'eip155:42431' },
      { rail: 'mpp', network: 'eip155:84532', paidWith: 'eip155:84532' },
    ]));
  });
});

describe('the top lists', () => {
  it('keep the 5 services and endpoints the count ranked, every way to pay with a paid call, most calls first, and the 5 tokens most topped up', () => {
    const services = Array.from({ length: 7 }, (_, index) => ({ host: `s${index}.example.com`, calls: 70 - index }));
    const endpoints = Array.from({ length: 6 }, (_, index) => ({ host: 'e.example.com', path: `/v1/${index}`, calls: 60 - index }));
    const way = (paidWith: string, calls: number) => ({ paidWith, calls, volume: 0n as MicroUsd, buyers: 0 });
    const topup = (network: string, token: string, count: number) => ({ network, token, count, amount: 0n as MicroUsd });

    const top = buildTopAnswer({ services, endpoints }, [way('near', 2), way('credits', 0), way('base', 9), way('tempo', 2)], [
      topup('near:testnet', 'wNEAR', 3), topup('eip155:84532', 'USDC', 7), topup('near:testnet', 'USDC', 3), topup('a', 'x', 1), topup('b', 'y', 1), topup('c', 'z', 1),
      topup('d', 'none', 0),
    ]);

    expect(top.services).toEqual(services.slice(0, 5));
    expect(top.endpoints).toEqual(endpoints.slice(0, 5));
    // A way with no paid call is left out; a tie goes by name
    expect(top.paidWith).toEqual([{ paidWith: 'base', calls: 9 }, { paidWith: 'near', calls: 2 }, { paidWith: 'tempo', calls: 2 }]);
    expect(top.topupTokens).toEqual([
      { network: 'eip155:84532', token: 'USDC', count: 7 }, { network: 'near:testnet', token: 'USDC', count: 3 }, { network: 'near:testnet', token: 'wNEAR', count: 3 },
      { network: 'a', token: 'x', count: 1 }, { network: 'b', token: 'y', count: 1 },
    ]);
    // A token never topped up isn't one
    expect(buildTopAnswer({ services: [], endpoints: [] }, [], [topup('d', 'none', 0), topup('a', 'x', 1)]).topupTokens).toEqual([{ network: 'a', token: 'x', count: 1 }]);
  });
});

describe('the blocklist as the public lists match it', () => {
  it('names a host and every subdomain of it, by whole labels, without case and without the port', () => {
    const isBlocked = createBlocklistMatcher(['evil.example', 'Bad.Example.COM', 'x.y.z.example.org']);

    for (const host of ['evil.example', 'a.evil.example', 'a.b.c.evil.example:8443', 'BAD.example.com', 'deep.x.y.z.example.org'])
      expect(isBlocked(host), host).toBe(true);
    for (const host of ['notevil.example', 'evil.example.net', 'example', 'y.z.example.org', 'ad.example.com', 'z.example.org'])
      expect(isBlocked(host), host).toBe(false);
    expect(createBlocklistMatcher([])('evil.example')).toBe(false);
  });

  it('costs a host of 127 labels as few steps as the entries have lengths, whatever their number', () => {
    const entries = Array.from({ length: 200 }, (_, index) => `blocked-${index}.example`);
    const isBlocked = createBlocklistMatcher(entries);
    const long = Array.from({ length: 127 }, () => 'a').join('.');
    const started = performance.now();
    for (let index = 0; index < 10_000; index += 1)
      isBlocked(long);

    expect(performance.now() - started).toBeLessThan(200);
    expect(isBlocked(`${long.slice(0, 200)}.blocked-7.example`)).toBe(true);
  });

  it('gives a host\'s labels and its parent domain without the port', () => {
    expect([hostLabels('a.b.example.com:8443'), hostLabels('example.com'), parentDomainOf('a.b.example.com:8443')]).toEqual([4, 2, 'example.com']);
  });
});
