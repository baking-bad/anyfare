import { describe, expect, it } from 'vitest';

import { readSettings } from '../src/config';
import { servicesMarkdown } from '../src/markdown/services';
import { serviceMarkdown } from '../src/markdown/service';
import { markdownPageFor } from '../src/markdown/pages';
import { missingPageFor } from '../src/missing/pages';
import { callsChange, checkHref, isHost, lastCall, meterShare, parsePeriod, perBuyer, serviceHref } from '../src/services/content';
import { apiServicesQuery, parseServicesFilters, servicesHref, withSearch, withSort } from '../src/services/filters';
import { paths } from '../src/api/endpoints';
import { answer, sampleCall, sampleService } from './support/fakeApi';
import type { CallsPage, ServicesPage } from '../src/api/types';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const settings = readSettings({ SITE_URL: 'https://site.example.com', API_URL: 'https://api.example.com', PAY_URL: 'https://pay.example.com', CONSOLE_URL: 'https://console.example.com' });
const page = (query: string): ServicesPage => answer(new URL(`https://x.example.com/v1/services${query}`), 'full', now)!.body as ServicesPage;

describe('the Services URL and its query', () => {
  it('reads q, sort and page, and drops what it does not know', () => {
    expect(parseServicesFilters(new URLSearchParams('q=%20maps%20&sort=price&page=3'))).toEqual({ q: 'maps', sort: 'price', page: 3 });
    expect(parseServicesFilters({ sort: 'nope', page: '0', q: '' })).toEqual({ sort: 'calls', page: 1 });
    expect(parseServicesFilters({ page: ['2', '5'], q: ['a', 'b'] })).toEqual({ q: 'a', sort: 'calls', page: 2 });
    expect(parseServicesFilters(new URLSearchParams('page=1.5'))).toEqual({ sort: 'calls', page: 1 });
  });

  it('writes the URL in a fixed order without defaults, and the same filters give the same URL', () => {
    expect(servicesHref({ sort: 'calls', page: 1 })).toBe('/services');
    expect(servicesHref({ q: 'a b', sort: 'volume', page: 2 })).toBe('/services?q=a+b&sort=volume&page=2');
    expect(servicesHref({ sort: 'price', page: 2 }, '/services.md')).toBe('/services.md?sort=price&page=2');
    const filters = parseServicesFilters(new URLSearchParams('page=2&sort=buyers&q=x'));
    expect(parseServicesFilters(new URLSearchParams(servicesHref(filters).split('?')[1]))).toEqual(filters);
  });

  it('asks the API for 20 a page, and a new search or sort goes back to page 1', () => {
    expect(paths.services(apiServicesQuery({ q: 'maps', sort: 'price', page: 2 }))).toBe('/v1/services?q=maps&sort=price&page=2&size=20');
    expect(withSearch({ sort: 'price', page: 3 }, ' geo ')).toEqual({ q: 'geo', sort: 'price', page: 1 });
    expect(withSearch({ q: 'geo', sort: 'price', page: 3 }, '  ')).toEqual({ sort: 'price', page: 1 });
    expect(withSort({ q: 'geo', sort: 'calls', page: 2 }, 'buyers')).toEqual({ q: 'geo', sort: 'buyers', page: 1 });
    expect(withSort({ sort: 'calls', page: 2 }, 'x')).toEqual({ sort: 'calls', page: 1 });
  });
});

describe('the fake services list', () => {
  it('has a second page, searches, and sorts', () => {
    expect(page('').total).toBeGreaterThanOrEqual(25);
    expect(page('?page=2').services.length).toBeGreaterThan(0);
    expect(page('?q=MAPS').services.map(row => row.host)).toEqual(['maps.example.com']);
    expect(page('?sort=price').services[0]!.priceFrom).toBe('0.001');
    expect(page('?q=zzz').totals.services).toBe(page('').totals.services);
  });
});

describe('the host', () => {
  it.each([['api.example.com', true], ['A.Example.COM', true], ['xn--e1afmkfd.xn--p1ai', true], ['localhost', false], ['bad_host.com', false], ['a..com', false], ['-a.com', false], ['a.com:80', false], ['', false], [`${'a'.repeat(64)}.com`, false]])('%s is %s', (host, valid) => {
    expect(isHost(host)).toBe(valid);
  });

  it('is told apart in the address by the proxy table, one entry per kind', () => {
    expect(missingPageFor('/services/api.example.com')?.page.kind).toBe('service');
    expect(missingPageFor('/calls/pay_x')?.page.kind).toBe('receipt');
    expect(missingPageFor('/services')).toBeUndefined();
    expect(missingPageFor('/services/a/b')).toBeUndefined();
  });
});

describe('the numbers of a service', () => {
  it('shows a change only when there is a period before with calls', () => {
    expect(callsChange(118, 100)).toBeCloseTo(0.18);
    expect(callsChange(50, 100)).toBeCloseTo(-0.5);
    expect(callsChange(5, 0)).toBeNull();
    expect(callsChange(5, null)).toBeNull();
    expect(callsChange(0, 10)).toBe(-1);
  });

  it('averages the volume over the buyers, and has no average without buyers', () => {
    expect(perBuyer('2.2', 14)).toBeCloseTo(0.157, 3);
    expect(perBuyer('2.2', 0)).toBeNull();
    expect(perBuyer('', 3)).toBeNull();
    expect(perBuyer('x', 3)).toBeNull();
    expect(perBuyer('0', 3)).toBe(0);
  });

  it('sizes a meter against the largest share', () => {
    expect(meterShare(0.18, 0.36)).toBe(0.5);
    expect(meterShare(0.5, 0)).toBe(0);
    expect(meterShare(2, 1)).toBe(1);
  });

  it('reads the period, and words the last call', () => {
    expect(parsePeriod('7d')).toBe('7d');
    expect(parsePeriod('week')).toBe('30d');
    expect(parsePeriod(null)).toBe('30d');
    expect(serviceHref('a.example.com', '30d')).toBe('/services/a.example.com');
    expect(serviceHref('a.example.com', 'all')).toBe('/services/a.example.com?period=all');
    expect(lastCall(new Date(now - 120_000).toISOString(), now)).toBe('2m ago');
    expect(lastCall(new Date(now - 23 * 3_600_000).toISOString(), now)).toBe('23h ago');
    expect(lastCall(new Date(now - 30 * 3_600_000).toISOString(), now)).toBe('Yesterday');
    expect(lastCall(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe('3 days ago');
    expect(lastCall('nope', now)).toBe('-');
  });

  it('links the check page with the host and the path, slashes kept', () => {
    expect(checkHref('a.example.com', '/v1/x y')).toBe('/check?url=a.example.com/v1/x%20y');
    expect(checkHref('a.example.com')).toBe('/check?url=a.example.com');
  });
});

describe('the Services twin', () => {
  const ok = { ok: true, value: page('') } as const;

  it('says the lead, how to pay, the numbers, the page as a table and how to get the next page', () => {
    const markdown = servicesMarkdown(settings, ok, { sort: 'calls', page: 1 });

    expect(markdown).toMatch(/^# Services\n/);
    expect(markdown).toContain('Services agents paid through Anyfare. Any x402 or MPP API can be paid the same way: paste its link on the home page.');
    expect(markdown).toContain('https://pay.example.com/<host>/<path>');
    expect(markdown).toContain('- Services paid through Anyfare: 27');
    expect(markdown).toContain('| [api.example.com](https://site.example.com/services/api.example.com) | 4 | $0.001 | 612 | 41 | $6.06 | 99% | 340 ms |');
    expect(markdown).toContain('| [geo02.example.org](https://site.example.com/services/geo02.example.org) | 3 | $0.007 | 183 | 14 | $1.81 | - | - |');
    expect(markdown).toContain('Page 1, services 1–20 of 27. Next page: https://site.example.com/services.md?page=2');
    expect(markdown).toContain('`GET https://api.example.com/v1/services?sort=calls&page=1&size=20`');
    expect(markdown).not.toMatch(/registr|verified|proposal|undefined|NaN|\bnull\b/i);
  });

  it('says it is the last page, and that nothing matches', () => {
    expect(servicesMarkdown(settings, { ok: true, value: page('?page=2') }, { sort: 'calls', page: 2 })).toContain('This is the last page.');
    expect(servicesMarkdown(settings, { ok: true, value: page('?q=zzz') }, { q: 'zzz', sort: 'calls', page: 1 })).toContain('Nothing matches.');
    expect(servicesMarkdown(settings, { ok: false, error: { status: 503, code: 'api_unavailable', message: 'x' } }, { sort: 'calls', page: 1 })).toContain('Not available right now.');
  });
});

describe('the Service twin', () => {
  const service = sampleService('api.example.com', '30d', now)!;
  const calls: CallsPage = { calls: [sampleCall(0, now)], page: 1, size: 5, total: 1, totalCapped: false };

  it('says how to pay, the numbers, by method, the endpoints with their pay links, and a Credits buyer with no id', () => {
    const markdown = serviceMarkdown(settings, 'api.example.com', { ok: true, value: service }, { ok: true, value: calls });

    expect(markdown).toMatch(/^# api.example.com\n/);
    expect(markdown).toContain('Pay any of its endpoints at https://pay.example.com/api.example.com/<path>');
    expect(markdown).toContain('- Paid calls: 612 (+18% against the 30 days before)');
    expect(markdown).toContain('- Answered 2xx: 99% (6 failed calls, not charged)');
    expect(markdown).toContain('| USDC on NEAR | 220 | 36% | 15 | $2.18 | $0.145 |');
    expect(markdown).toContain('https://pay.example.com/api.example.com/v1/sample/quotes/latest |');
    expect(markdown).toContain('| A Credits account | Credits |');
    expect(markdown).toContain('/check?url=api.example.com/v1/sample/quotes/latest');
    expect(markdown).toContain('`GET https://api.example.com/v1/calls/stream?host=api.example.com`');
    expect(markdown).not.toMatch(/undefined|NaN|\bnull\b/);
  });

  it('leaves the change out when there is no period before, and marks a failed read', () => {
    const all = serviceMarkdown(settings, 'api.example.com', { ok: true, value: sampleService('api.example.com', 'all', now)! }, { ok: false, error: { status: 503, code: 'x', message: 'x' } });
    expect(all).not.toContain('against');
    expect(all).toContain('Not available right now.');
    expect(serviceMarkdown(settings, 'api.example.com', { ok: false, error: { status: 503, code: 'x', message: 'x' } }, { ok: true, value: calls })).toContain('Not available right now.');
  });

  it('is a twin for any name under /services, but not for the list with a query', () => {
    expect(markdownPageFor('/services/api.example.com')).toBeDefined();
    expect(markdownPageFor('/services')).toBeDefined();
    expect(markdownPageFor('/services/a/b')).toBeUndefined();
  });
});
