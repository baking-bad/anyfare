import { describe, expect, it } from 'vitest';

import { getEndpointStats, paths } from '../src/api/endpoints';
import type { ApiResult, Reader } from '../src/api/reader';
import type { CallsPage, ServiceDetail, ServicesPage } from '../src/api/types';
import { readCheckAnswer } from '../src/check/answer';
import { unlistedLine } from '../src/check/content';
import { loadCheckData } from '../src/check/data';
import { readSettings } from '../src/config';
import { paidServicesOnly } from '../src/home/data';
import { checkMarkdown } from '../src/markdown/check';
import { serviceMarkdown } from '../src/markdown/service';
import { servicesMarkdown } from '../src/markdown/services';
import {
  addServiceLine, checkedDay, checkedLine, endpointNote, endpointsLine, headStatus, nobodyPaidLine, notPaidYet, rowStatus, serviceMissingLine, servicesLead, servicesNumberLabels,
} from '../src/services/content';
import { apiServicesQuery, parseServicesFilters, servicesHref, sortChoices, withSort } from '../src/services/filters';
import { answer, checkedHosts, mixedHost, quietEndpointHost, sampleCheck, sampleCheckHosts, sampleService, unpricedCheckedHost, zeroPaidHost } from './support/fakeApi';

// A clock three days after the first day the site existed, so every time in these tests is from today or later
const now = Date.parse('2026-11-14T12:00:00.000Z');
const settings = readSettings({ SITE_URL: 'https://site.example.com', API_URL: 'https://api.example.com', PAY_URL: 'https://pay.example.com', CONSOLE_URL: 'https://console.example.com' });
const filters = { sort: 'calls', page: 1 } as const;

const list = (query: string, mode: 'full' | 'checked' | 'empty' = 'full'): ServicesPage => answer(new URL(`https://x.example.com/v1/services${query}`), mode, now)!.body as ServicesPage;
const detail = (host: string, mode: 'full' | 'checked' = 'full', period = '30d'): ServiceDetail | undefined => {
  const found = answer(new URL(`https://x.example.com/v1/services/${host}?period=${period}`), mode, now)!;

  return found.status === 200 ? found.body as ServiceDetail : undefined;
};
const calls: CallsPage = { calls: [], page: 1, size: 5, total: 0, totalCapped: false };
const noCalls: ApiResult<CallsPage> = { ok: true, value: calls };

describe('the day a check was made', () => {
  it('says today, yesterday, and then the UTC date as "11 Nov 2026"', () => {
    expect(checkedDay('2026-11-14T00:00:00.000Z', now)).toBe('today');
    expect(checkedDay('2026-11-14T23:59:59.000Z', now)).toBe('today');
    expect(checkedDay('2026-11-13T23:59:59.000Z', now)).toBe('yesterday');
    expect(checkedDay('2026-11-13T00:00:00.000Z', now)).toBe('yesterday');
    expect(checkedDay('2026-11-11T09:30:00.000Z', now)).toBe('11 Nov 2026');
    expect(checkedDay('2026-11-12T00:00:00.000Z', now)).toBe('12 Nov 2026');
    expect(checkedDay('2027-01-05T10:00:00.000Z', Date.parse('2027-03-01T00:00:00.000Z'))).toBe('5 Jan 2027');
  });

  it('counts the day in UTC, whatever the hour', () => {
    // 23:30 UTC on the 13th is "yesterday" at noon on the 14th, and the same instant read from the 14th at 00:10 is too
    expect(checkedDay('2026-11-13T23:30:00.000Z', Date.parse('2026-11-14T00:10:00.000Z'))).toBe('yesterday');
    expect(checkedDay('2026-11-14T00:10:00.000Z', Date.parse('2026-11-14T00:10:00.000Z'))).toBe('today');
  });

  it('has no day for no time, a time that is not one, or one in the future that reads as today', () => {
    expect(checkedDay(null, now)).toBeUndefined();
    expect(checkedDay('soon', now)).toBeUndefined();
    expect(checkedLine(null, now)).toBeUndefined();
    expect(checkedDay('2026-11-20T00:00:00.000Z', now)).toBe('today');
  });

  it('is the line "Checked <day>"', () => {
    expect(checkedLine('2026-11-14T08:00:00.000Z', now)).toBe('Checked today');
    expect(checkedLine('2026-11-13T08:00:00.000Z', now)).toBe('Checked yesterday');
    expect(checkedLine('2026-11-11T08:00:00.000Z', now)).toBe('Checked 11 Nov 2026');
  });
});

describe('what a row, a head and an endpoint say for each status', () => {
  const paidRow = { status: 'paid', checkedAt: '2026-11-13T08:00:00.000Z' } as const;
  const checkedRow = { status: 'checked', checkedAt: '2026-11-11T08:00:00.000Z' } as const;

  it('marks a checked row as not paid, with its day, and a paid row as neither', () => {
    expect(rowStatus(checkedRow, now)).toEqual({ notPaid: true, checked: 'Checked 11 Nov 2026' });
    expect(rowStatus({ status: 'checked', checkedAt: null }, now)).toEqual({ notPaid: true, checked: undefined });
    // A paid service says nothing under its host, even when a check confirmed one of its endpoints
    expect(rowStatus(paidRow, now)).toEqual({ notPaid: false, checked: undefined });
  });

  it('counts the endpoints in the head, marks a checked service, and says when a paid one was checked', () => {
    const endpoints = (statuses: readonly ('paid' | 'checked')[]) => statuses.map(status => ({ status, checkedAt: null }));

    expect(headStatus({ status: 'checked', checkedAt: '2026-11-11T08:00:00.000Z', paidEndpoints: 3, endpoints: endpoints(['checked', 'checked', 'checked']) }, now))
      .toEqual({ endpoints: '3 paid endpoints', notPaid: true, checked: 'Checked 11 Nov 2026' });
    expect(headStatus({ status: 'paid', checkedAt: '2026-11-14T08:00:00.000Z', paidEndpoints: 4, endpoints: endpoints(['paid', 'paid', 'paid', 'checked']) }, now))
      .toEqual({ endpoints: '4 paid endpoints', notPaid: false, checked: 'Checked today' });
    expect(headStatus({ status: 'paid', checkedAt: null, paidEndpoints: 1, endpoints: endpoints(['paid']) }, now))
      .toEqual({ endpoints: '1 paid endpoint', notPaid: false, checked: undefined });
  });

  it('keeps "with calls in this period" true when checked endpoints are among the listed ones', () => {
    expect(endpointsLine(7, 7)).toBe('7 paid endpoints');
    expect(endpointsLine(7, 6)).toBe('7 paid endpoints, 6 with calls in this period');
    // 4 listed endpoints: 3 with calls and 1 only checked
    expect(endpointsLine(4, 4, 1)).toBe('4 paid endpoints');
    // 7 listed: 5 paid and 1 checked are shown, and 1 paid has no calls in the period
    expect(endpointsLine(7, 6, 1)).toBe('7 paid endpoints, 5 with calls in this period');
    expect(endpointsLine(2, 2, 2)).toBe('2 paid endpoints');
  });

  it('does not count a paid endpoint with no call in the period as one with calls', () => {
    const listed = [{ status: 'paid', calls: 5 }, { status: 'paid', calls: 2 }, { status: 'paid', calls: 0 }, { status: 'checked', calls: 0 }] as const;

    expect(headStatus({ status: 'paid', checkedAt: null, paidEndpoints: 4, endpoints: listed }, now).endpoints).toBe('4 paid endpoints, 2 with calls in this period');
    expect(headStatus({ status: 'paid', checkedAt: null, paidEndpoints: 3, endpoints: listed.slice(0, 3) }, now).endpoints).toBe('3 paid endpoints, 2 with calls in this period');
    expect(headStatus({ status: 'paid', checkedAt: null, paidEndpoints: 2, endpoints: [{ status: 'paid', calls: 4 }, { status: 'paid', calls: 1 }] }, now).endpoints).toBe('2 paid endpoints');
  });

  it('marks only a checked endpoint, with its day', () => {
    expect(endpointNote({ status: 'checked', checkedAt: '2026-11-13T08:00:00.000Z' }, now)).toBe('Checked yesterday');
    expect(endpointNote({ status: 'checked', checkedAt: null }, now)).toBeUndefined();
    expect(endpointNote({ status: 'paid', checkedAt: '2026-11-13T08:00:00.000Z' }, now)).toBeUndefined();
  });
});

describe('the fake API\'s answers for a paid service with zero numbers', () => {
  it('keeps the service in the list with zeros, and its page lists every endpoint as paid with its link', () => {
    const row = list('?q=ocr22').services[0]!;
    expect(row).toMatchObject({ host: zeroPaidHost, status: 'paid', calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null, checkedAt: null });
    expect(row.trend).toHaveLength(30);
    expect(row.trend.every(value => value === 0)).toBe(true);
    const page = detail(zeroPaidHost)!;
    expect(page).toMatchObject({ status: 'paid', checkedAt: null, stats: { calls: 0, buyers: 0 }, daily: [], byPaidWith: [] });
    expect(page.endpoints).toHaveLength(page.paidEndpoints);
    for (const endpoint of page.endpoints)
      expect(endpoint).toMatchObject({ status: 'paid', calls: 0, volume: '0', checkedAt: null, link: expect.stringContaining(zeroPaidHost) });
  });

  it('has a busy service with one paid endpoint with no call, after those with calls', () => {
    const page = detail(quietEndpointHost)!;
    const last = page.endpoints.at(-1)!;

    expect(page.endpoints).toHaveLength(page.paidEndpoints);
    expect(last).toMatchObject({ status: 'paid', calls: 0, buyers: 0, volume: '0', successRate: null });
    expect(page.endpoints.slice(0, -1).every(endpoint => endpoint.calls > 0)).toBe(true);
  });

  it('answers 404 for the endpoint numbers of a hidden host, and the endpoint reader turns it into zeros', async () => {
    const url = new URL(`https://x.example.com/v1/endpoints/stats?host=${sampleCheckHosts.hidden}&path=/v1/x`);
    expect(answer(url, 'full', now)!.status).toBe(404);
    const read: Reader = async () => ({ ok: false, error: { status: 404, code: 'not_found', message: 'x' } });
    const result = await getEndpointStats(read, sampleCheckHosts.hidden, '/v1/x', '7d');

    expect(result.ok && result.value).toMatchObject({ host: sampleCheckHosts.hidden, path: '/v1/x', period: '7d', stats: { calls: 0, buyers: 0, volume: '0', successRate: null }, byPaidWith: [], exact: true });
    expect(result.ok && result.value.daily).toHaveLength(14);
    // Any other failure stays a failure
    const failing: Reader = async () => ({ ok: false, error: { status: 503, code: 'stats_unavailable', message: 'x' } });
    expect((await getEndpointStats(failing, 'a.example.com', '/x')).ok).toBe(false);
  });
});

describe('the sort', () => {
  it('offers Newest after the default, and keeps the default out of the address', () => {
    expect(sortChoices.map(choice => choice.label)).toEqual(['Most calls through Anyfare', 'Newest', 'Most buyers', 'Most volume', 'Most paid endpoints', 'Cheapest']);
    expect(parseServicesFilters(new URLSearchParams('sort=newest&page=2'))).toEqual({ sort: 'newest', page: 2 });
    expect(servicesHref({ sort: 'newest', page: 1 })).toBe('/services?sort=newest');
    expect(servicesHref({ sort: 'calls', page: 1 })).toBe('/services');
    expect(paths.services(apiServicesQuery({ q: 'fresh', sort: 'newest', page: 1 }))).toBe('/v1/services?q=fresh&sort=newest&page=1&size=20');
    expect(withSort({ q: 'geo', sort: 'calls', page: 3 }, 'newest')).toEqual({ q: 'geo', sort: 'newest', page: 1 });
  });
});

describe('the fake list of services', () => {
  it('mixes paid and checked services, and counts both kinds in its totals', () => {
    const page = list('?size=100');
    const checked = page.services.filter(row => row.status === 'checked');

    expect(page.services.filter(row => row.status === 'paid')).toHaveLength(27);
    expect(checked.map(row => row.host)).toEqual([...checkedHosts]);
    expect(page.totals).toMatchObject({ services: 31, paidServices: 27 });
    expect(page.totals.calls30d).toBe(page.services.reduce((sum, row) => sum + row.calls, 0));
  });

  it('gives a checked service zero calls, buyers and volume, no rates, a trend of zeros, and its times', () => {
    const row = list('?q=fresh02').services[0]!;

    expect(row).toMatchObject({ host: 'fresh02.example.net', status: 'checked', calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null, paidEndpoints: 2 });
    expect(row.trend).toHaveLength(30);
    expect(row.trend.every(value => value === 0)).toBe(true);
    expect(row.listedAt).not.toBeNull();
    expect(row.checkedAt).not.toBeNull();
  });

  it('sorts by calls with the paid first and then the checked, newest first', () => {
    const rows = list('?sort=calls&size=100').services;
    const firstChecked = rows.findIndex(row => row.status === 'checked');

    expect(firstChecked).toBe(27);
    expect(rows.slice(firstChecked).map(row => row.host)).toEqual([...checkedHosts]);
    expect(rows.slice(0, firstChecked).every(row => row.status === 'paid')).toBe(true);
  });

  it('sorts by newest: the most recently listed first, whatever the kind', () => {
    const rows = list('?sort=newest&size=100').services;
    const times = rows.map(row => Date.parse(row.listedAt!));

    expect(rows.slice(0, 4).map(row => row.host)).toEqual([...checkedHosts]);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('finds a checked service by a part of its host', () => {
    expect(list('?q=FRESH03').services.map(row => row.host)).toEqual([unpricedCheckedHost]);
    expect(list('?q=fresh').total).toBe(4);
  });

  it('has a mode with only checked services, and no paid call anywhere', () => {
    const page = list('', 'checked');

    expect(page.services.map(row => row.host)).toEqual([...checkedHosts]);
    expect(page.totals).toEqual({ services: 4, paidServices: 0, paidEndpoints: page.services.reduce((sum, row) => sum + row.paidEndpoints, 0), calls30d: 0 });
    expect((answer(new URL('https://x.example.com/v1/calls'), 'checked', now)!.body as CallsPage).total).toBe(0);
    expect(answer(new URL('https://x.example.com/v1/services/api.example.com'), 'checked', now)!.status).toBe(404);
    expect(answer(new URL(`https://x.example.com/v1/services/${checkedHosts[0]}`), 'checked', now)!.status).toBe(200);
    expect(list('', 'empty').totals).toEqual({ services: 0, paidServices: 0, paidEndpoints: 0, calls30d: 0 });
  });

  it('answers a checked host with 200 and zeros and empty lists, and a host not listed with 404', () => {
    const service = detail(checkedHosts[1]!)!;

    expect(service).toMatchObject({ host: checkedHosts[1], status: 'checked', paidEndpoints: 2, daily: [], byPaidWith: [], topBuyers: { share: 0, buyers: [] }, exact: true });
    expect(service.stats).toMatchObject({ calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null });
    expect(service.endpoints.map(endpoint => endpoint.status)).toEqual(['checked', 'checked']);
    expect(service.endpoints.every(endpoint => endpoint.calls === 0 && endpoint.checkedAt !== null)).toBe(true);
    expect(detail('nobody.example.com')).toBeUndefined();
  });

  it('lists the checked endpoints of a paid host after its paid ones', () => {
    const service = detail(mixedHost)!;

    expect(service.status).toBe('paid');
    expect(service.checkedAt).not.toBeNull();
    expect(service.endpoints.map(endpoint => endpoint.status)).toEqual(['paid', 'paid', 'paid', 'checked']);
    expect(service.paidEndpoints).toBe(4);
    expect(service.endpoints.at(-1)).toMatchObject({ path: '/v1/sample/preview', method: 'POST', calls: 0, buyers: 0, volume: '0', successRate: null });
    expect(service.stats.calls).toBeGreaterThan(0);
  });

  it('keeps every other host\'s service as it was: paid, never checked', () => {
    const service = detail('api.example.com')!;

    expect(service).toMatchObject({ status: 'paid', checkedAt: null });
    expect(service.endpoints.every(endpoint => endpoint.status === 'paid' && endpoint.checkedAt === null)).toBe(true);
  });
});

describe('the check\'s listed', () => {
  const read = (link: string) => {
    const answered = readCheckAnswer(sampleCheck(link, now).body);
    if (answered === undefined || !answered.payable)
      throw new Error(`not payable: ${link}`);

    return answered.check;
  };

  it('is read as true when the pay host says so, and false for a link a limit kept out', () => {
    expect(read('api.example.com/v1/sample/lookup').listed).toBe(true);
    expect(read(`${sampleCheckHosts.unlisted}/v1/x`).listed).toBe(false);
    expect(read(`${checkedHosts[0]}/v1/sample/lookup`).listed).toBe(true);
  });

  it('is false for an answer that does not say, so a button never leads to a page that may not exist', () => {
    const body = { ...sampleCheck('api.example.com/v1/x', now).body as Record<string, unknown> };
    delete body['listed'];

    expect(readCheckAnswer(body)).toMatchObject({ payable: true, check: { listed: false } });
    expect(readCheckAnswer({ ...body, listed: 'yes' })).toMatchObject({ check: { listed: false } });
  });

  const twin = async (link: string): Promise<string> => {
    const reader = (async (path: string) => {
      const found = answer(new URL(`https://fake.example.com${path}`), 'full', now);

      return found === undefined || found.status >= 400 ? { ok: false, error: { status: 404, code: 'not_found', message: 'x' } } : { ok: true, value: found.body };
    }) as Parameters<typeof loadCheckData>[0];
    const data = await loadCheckData(reader, reader, { url: link, method: 'GET', tab: 'overview', period: '30d', page: 1 });

    return checkMarkdown(settings, data).body;
  };

  it('puts the service page in the twin when listed, and says why there is none when not', async () => {
    expect(await twin('api.example.com/v1/sample/lookup')).toContain('Its service page: https://site.example.com/services/api.example.com');
    const unlisted = await twin(`${sampleCheckHosts.unlisted}/v1/x`);

    expect(unlisted).toContain(unlistedLine);
    expect(unlisted).not.toContain('/services/unlisted.example.com');
    expect(unlistedLine).toBe('This link isn\'t in the list of services yet.');
  });
});

describe('what stays paid-only on the home page', () => {
  it('keeps the services that were paid and drops the checked ones, even when the list holds both', () => {
    const page = list('?sort=calls&size=5');
    const mixed = list('?sort=newest&size=5');

    expect(page.services.every(row => row.status === 'paid')).toBe(true);
    expect(mixed.services.some(row => row.status === 'checked')).toBe(true);
    const kept = paidServicesOnly({ ok: true, value: mixed });

    expect(kept.ok && kept.value.services.every(row => row.status === 'paid')).toBe(true);
    expect(kept.ok && kept.value.services.length).toBeLessThan(5);
  });

  it('shows nothing when only checked services are listed, so the page shows its empty state', () => {
    const kept = paidServicesOnly({ ok: true, value: list('?sort=calls&size=5', 'checked') });

    expect(kept.ok && kept.value.services).toEqual([]);
  });

  it('leaves a failed read as it was', () => {
    const failed = { ok: false, error: { status: 503, code: 'api_unavailable', message: 'x' } } as const;

    expect(paidServicesOnly(failed)).toBe(failed);
  });
});

describe('the Services twin with both kinds', () => {
  const markdown = servicesMarkdown(settings, { ok: true, value: list('?size=100') }, filters, now);

  it('says the lead, the three numbers, and how to add a service', () => {
    expect(markdown).toContain(`\n${servicesLead}\n`);
    expect(markdown).toContain(`- ${servicesNumberLabels.listed}: 31\n- ${servicesNumberLabels.paid}: 27\n- ${servicesNumberLabels.calls}: `);
    expect(markdown).toContain(addServiceLine);
    expect(markdown).toContain('A paid link you check joins the list of services, as checked, until someone pays it.');
    expect(markdown).toContain('check a paid link');
  });

  it('gives each row its status, and a checked row "Not paid yet", dashes and the day it was checked', () => {
    expect(markdown).toContain('| [api.example.com](https://site.example.com/services/api.example.com) | paid | 4 | $0.001 | 612 |');
    expect(markdown).toContain(`| [fresh01.example.net](https://site.example.com/services/fresh01.example.net) | checked | 1 | $0.002 | ${notPaidYet} | - | - | - | - | Checked today |`);
    expect(markdown).toContain(`| [fresh02.example.net](https://site.example.com/services/fresh02.example.net) | checked | 2 | $0.004 | ${notPaidYet} | - | - | - | - | Checked today |`);
    expect(markdown).toContain(`| [fresh03.example.net](https://site.example.com/services/fresh03.example.net) | checked | 3 | - | ${notPaidYet} | - | - | - | - | Checked 11 Nov 2026 |`);
    expect(markdown).not.toMatch(/undefined|NaN|\bnull\b/);
  });

  it('is fixed for the same input and clock', () => {
    expect(servicesMarkdown(settings, { ok: true, value: list('?size=100') }, filters, now)).toBe(markdown);
  });

  it('lists the newest sort among the sorts', () => {
    expect(markdown).toContain('sort is calls, newest, buyers, volume, endpoints, price');
  });

  it('says only checked services are there, with no paid one', () => {
    const only = servicesMarkdown(settings, { ok: true, value: list('', 'checked') }, filters, now);

    expect(only).toContain(`- ${servicesNumberLabels.paid}: 0`);
    expect(only).toContain(`- ${servicesNumberLabels.listed}: 4`);
    expect(only).not.toContain('| paid |');
  });
});

describe('the Service twin for a checked service and for a mixed one', () => {
  it('says the status, "Not paid yet", the checked day, the endpoints with their pay links, and the empty states', () => {
    const service = detail(checkedHosts[2]!)!;
    const markdown = serviceMarkdown(settings, checkedHosts[2]!, { ok: true, value: service }, noCalls, now);

    expect(markdown).toMatch(/^# fresh03.example.net\n/);
    expect(markdown).toContain('3 paid endpoints.\n\nStatus: checked. Not paid yet. Checked 11 Nov 2026.');
    expect(markdown).toContain(nobodyPaidLine);
    expect(markdown).toContain('| Endpoint | Status | Price now | Paid calls | Buyers | Volume | 2xx | Median | Pay link | Checked |');
    expect(markdown).toContain('| GET /v1/sample/quotes/latest | checked | - | Not paid yet | - | - | - | - | https://pay.example.com/fresh03.example.net/v1/sample/quotes/latest | 11 Nov 2026 |');
    expect(markdown).toContain('| POST /v1/sample/lookup | checked | - |');
    expect(markdown).toContain('No paid calls yet. The numbers appear once someone pays this API through Anyfare.');
    expect(markdown).toContain('No buyers yet.');
    expect(markdown).not.toContain('Paid calls: 0');
    expect(markdown).not.toMatch(/undefined|NaN|\bnull\b/);
  });

  it('lists the checked endpoint of a paid service after the paid ones, marked the same way, with its numbers intact', () => {
    const service = detail(mixedHost)!;
    const markdown = serviceMarkdown(settings, mixedHost, { ok: true, value: service }, noCalls, now);

    expect(markdown).toContain('4 paid endpoints.\n\nStatus: paid. Checked today.');
    expect(markdown).not.toContain(nobodyPaidLine);
    expect(markdown).toContain('- Paid calls: 155');
    expect(markdown).toMatch(/\| POST \/v1\/sample\/preview \| checked \| \$0\.\d+ \| Not paid yet \| - \| - \| - \| - \| https:\/\/pay\.example\.com\/pdf06\.example\.org\/v1\/sample\/preview \| today \|/);
    const paid = markdown.indexOf('| paid |');
    const checked = markdown.indexOf('| checked |');

    expect(paid).toBeGreaterThan(-1);
    expect(paid).toBeLessThan(checked);
    expect(markdown).not.toMatch(/undefined|NaN|\bnull\b/);
  });

  it('is fixed for the same input and clock', () => {
    const service = detail(checkedHosts[0]!)!;

    expect(serviceMarkdown(settings, checkedHosts[0]!, { ok: true, value: service }, noCalls, now)).toBe(serviceMarkdown(settings, checkedHosts[0]!, { ok: true, value: service }, noCalls, now));
  });

  it('words a host nobody listed for both kinds of service', () => {
    expect(serviceMissingLine).toBe('No paid call or check has listed this service yet.');
    expect(sampleService('nobody.example.com', '30d', now)).toBeUndefined();
  });
});
