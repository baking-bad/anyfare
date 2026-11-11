import { describe, expect, it } from 'vitest';

import { shortAddress } from '../src/calls/address';
import { callsRequests, type CallsData } from '../src/calls/data';
import { apiFilter, apiQuery, callsHref, filtersQuery, isFiltered, parseFilters, withFilter } from '../src/calls/filters';
import { readSettings } from '../src/config';
import { callsMarkdown } from '../src/markdown/calls';
import { answer, matchesCall, sampleCall } from './support/fakeApi';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const settings = readSettings({ SITE_URL: 'https://site.example.com', API_URL: 'https://api.example.com', PAY_URL: 'https://pay.example.com', CONSOLE_URL: 'https://console.example.com' });

describe('the filters and the page in the URL', () => {
  it('reads every filter and the page from a query', () => {
    expect(parseFilters(new URLSearchParams('paidWith=near&service=quotes&endpoint=/v1/a&status=free&page=3')))
      .toEqual({ paidWith: 'near', service: 'quotes', endpoint: '/v1/a', status: 'free', page: 3 });
  });

  it('reads the server\'s search params, which may hold a list', () => {
    expect(parseFilters({ paidWith: ['base', 'near'], page: '2', status: undefined })).toEqual({ paidWith: 'base', page: 2 });
  });

  it('drops what the page doesn\'t know and counts from the first page', () => {
    expect(parseFilters(new URLSearchParams('paidWith=bitcoin&status=failed&endpoint=no-slash&page=0'))).toEqual({ page: 1 });
    expect(parseFilters(new URLSearchParams('page=abc')).page).toBe(1);
    expect(parseFilters(new URLSearchParams('page=2.5')).page).toBe(1);
    expect(parseFilters(new URLSearchParams('service=%20%20'))).toEqual({ page: 1 });
    expect(parseFilters(new URLSearchParams(`service=${'a'.repeat(150)}`)).service).toHaveLength(100);
  });

  it('writes a query in a fixed order, without what is empty or the first page', () => {
    expect(filtersQuery({ page: 1 })).toBe('');
    expect(callsHref({ page: 1 })).toBe('/calls');
    expect(callsHref({ page: 2, status: 'paid', paidWith: 'near' })).toBe('/calls?paidWith=near&status=paid&page=2');
    expect(callsHref({ page: 1, service: 'a b&c' })).toBe('/calls?service=a+b%26c');
    expect(callsHref({ page: 2 }, '/calls.md')).toBe('/calls.md?page=2');
  });

  it('reads back what it wrote', () => {
    const filters = { paidWith: 'tempo', service: 'api.example', endpoint: '/v1/x', status: 'paid', page: 4 } as const;

    expect(parseFilters(new URLSearchParams(filtersQuery(filters)))).toEqual(filters);
  });

  it('sets one filter from a control and goes back to the first page', () => {
    const base = { paidWith: 'near', page: 3 } as const;

    expect(withFilter(base, 'status', 'free')).toEqual({ paidWith: 'near', status: 'free', page: 1 });
    expect(withFilter(base, 'paidWith', '')).toEqual({ page: 1 });
    expect(withFilter(base, 'service', '  quotes ')).toEqual({ paidWith: 'near', service: 'quotes', page: 1 });
    expect(withFilter(base, 'status', 'nonsense')).toEqual({ paidWith: 'near', page: 1 });
  });

  it('tells whether a filter is set, and gives the API its query and the stream its filters', () => {
    expect(isFiltered({ page: 5 })).toBe(false);
    expect(isFiltered({ page: 1, endpoint: '/v1/a' })).toBe(true);
    expect(apiQuery({ page: 2, paidWith: 'base' })).toEqual({ paidWith: 'base', page: 2, size: 20 });
    expect(apiFilter({ page: 2, status: 'paid' })).toEqual({ status: 'paid' });
  });
});

describe('a buyer\'s address in the grid', () => {
  it('keeps a short address whole', () => {
    expect(shortAddress('scout7.near')).toBe('scout7.near');
    expect(shortAddress('')).toBe('');
  });

  it('keeps the start and the end of a long one, with an ellipsis in the middle', () => {
    const address = `0x${'ab12'.repeat(10)}`;
    const short = shortAddress(address);

    expect(short).toBe('0xab12ab12ab…2ab12');
    expect(short).toHaveLength(18);
    expect(short.startsWith('0x')).toBe(true);
    expect(address.endsWith(short.split('…')[1]!)).toBe(true);
  });
});

const read = (path: string) => ({ ok: true as const, value: answer(new URL(path, 'http://fake.example.com'), 'full', now)!.body });

const dataFrom = (path: string, mode: 'full' | 'empty' = 'full'): CallsData => {
  const get = (at: string) => ({ ok: true as const, value: answer(new URL(at, 'http://fake.example.com'), mode, now)!.body });

  return { live: get('/v1/stats/live') as CallsData['live'], calls: get(path) as CallsData['calls'], top: get('/v1/stats/top?period=30d') as CallsData['top'] };
};

describe('the Calls page as Markdown', () => {
  const filters = parseFilters(new URLSearchParams('status=paid&page=2'));
  const markdown = callsMarkdown(settings, dataFrom('/v1/calls?status=paid&page=2'), filters);

  it('says today\'s numbers and what a call shows', () => {
    expect(markdown).toMatch(/^# Calls\n/);
    expect(markdown).toContain('- Paid calls: 213\n- Volume: $2.31\n- Buyers: 38\n- Paid from NEAR: 35%');
    expect(markdown).toContain('- The service host and path. Never the query string');
    expect(markdown).toContain('A Credits buyer is never named.');
  });

  it('lists the current page with its filters, and says how to get the next page', () => {
    expect(markdown).toContain('Filters:\n\n- Status: Paid');
    expect(markdown).toContain('| When | Service | Path | Paid with | API paid with | Buyer | Amount | Status | Time |');
    expect(markdown).toContain('| 2026-11-11T11:57:02.000Z | api.example.com | /v1/sample/lookup | USDC on NEAR | USDC on NEAR | sample.near | $0.006 | Paid | 895 ms |');
    expect(markdown).toContain('Page 2, calls 21–40 of 48. Next page: https://site.example.com/calls.md?status=paid&page=3');
    expect(markdown).toContain('/calls.md?paidWith=near&service=<part of the host>&status=paid&page=2');
  });

  it('says the last page is the last', () => {
    const last = callsMarkdown(settings, dataFrom('/v1/calls?paidWith=near'), { paidWith: 'near', page: 1 });

    expect(last).toContain('Page 1, calls 1–12 of 12. This is the last page.');
  });

  it('lists the top 5 and holds no undefined, NaN or null', () => {
    expect(markdown).toContain('- [api.example.com](https://site.example.com/services/api.example.com): 612 calls');
    expect(markdown).toContain('- [api.example.com/v1/sample/quotes/latest](https://site.example.com/check?url=api.example.com/v1/sample/quotes/latest): 402 calls');
    expect(markdown).toContain('- USDC on NEAR: 662 calls');
    expect(markdown).toContain('- USDC on Base: 7');
    expect(markdown).not.toMatch(/undefined|NaN|null/);
  });

  it('says so for no calls, with filters and without', () => {
    expect(callsMarkdown(settings, dataFrom('/v1/calls', 'empty'), { page: 1 })).toContain('No calls yet.');
    expect(callsMarkdown(settings, dataFrom('/v1/calls?paidWith=near', 'empty'), { paidWith: 'near', page: 1 })).toContain('No calls match these filters yet.');
    expect(callsMarkdown(settings, dataFrom('/v1/calls', 'empty'), { page: 1 })).not.toMatch(/undefined|NaN|null/);
  });

  it('says a part is not available when its read failed, and keeps the others', () => {
    const failed = { ok: false as const, error: { status: 503, code: 'api_unavailable', message: 'The Platform API didn\'t answer.' } };
    const partial = callsMarkdown(settings, { ...dataFrom('/v1/calls'), live: failed, calls: failed }, { page: 1 });

    expect(partial).toContain('Not available right now.');
    expect(partial).toContain('## Top 5, 30 days');
    expect(partial).toContain('- [api.example.com]');
  });
});

describe('the requests behind the page', () => {
  it('lists the stream, the list with the current filters, and the top lists', () => {
    const requests = callsRequests(settings, { paidWith: 'near', status: 'paid', page: 2 });

    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      'SSE https://api.example.com/v1/calls/stream?paidWith=near&status=paid',
      'GET https://api.example.com/v1/calls?paidWith=near&status=paid&page=2&size=20',
      'GET https://api.example.com/v1/stats/live',
      'GET https://api.example.com/v1/stats/top?period=30d',
    ]);
  });
});

describe('the fake API\'s filters', () => {
  it('filters the list by each filter and pages it', () => {
    const list = (query: string) => read(`/v1/calls?${query}`).value as { calls: { id: string }[]; total: number; page: number };

    expect(list('').total).toBe(60);
    expect(list('page=3').calls).toHaveLength(20);
    expect(list('page=4').calls).toHaveLength(0);
    expect(list('status=free').total).toBe(12);
    expect(list('paidWith=credits').total).toBe(12);
    expect(list('service=QUOTES').total).toBe(12);
    expect(list('endpoint=/v1/sample/lookup').total).toBe(40);
  });

  it('matches a call the way the stream does', () => {
    const call = sampleCall(1, now);

    expect(matchesCall(call, new URLSearchParams('paidWith=base&service=data.&status=paid'))).toBe(true);
    expect(matchesCall(call, new URLSearchParams('paidWith=near'))).toBe(false);
  });
});
