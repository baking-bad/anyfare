import { describe, expect, it } from 'vitest';

import { deriveAgent, twinKeyOf, type AgentSource } from '../src/components/agentSource';
import { readSettings } from '../src/config';
import { checkAddress } from '../src/check/content';
import type { CheckState } from '../src/check/data';
import { callsHref } from '../src/calls/filters';
import { servicesHref } from '../src/services/filters';
import { linkHeader, pageLinks, twinLink } from '../src/seo/links';
import { twinHref, twinQuery } from '../src/seo/twin';
import { answer } from './support/fakeApi';

const settings = readSettings({ SITE_URL: 'https://site.example.com', API_URL: 'https://api.example.com', PAY_URL: 'https://pay.example.com', CONSOLE_URL: 'https://console.example.com' });
const now = Date.parse('2026-11-11T12:00:00.000Z');

describe('the address of a page\'s Markdown twin', () => {
  it.each([
    ['/', '', '/index.md'],
    ['/agents', '', '/agents.md'],
    ['/agents', '?x=1', '/agents.md'],
    ['/calls/pay_abc', '?page=2', '/calls/pay_abc.md'],
    ['/calls', '', '/calls.md'],
    ['/calls', '?paidWith=near&page=2', '/calls.md?paidWith=near&page=2'],
    ['/calls', '?page=2&paidWith=near', '/calls.md?paidWith=near&page=2'],
    ['/calls', '?service=api.example&status=paid&endpoint=%2Fv1%2Fx', '/calls.md?service=api.example&endpoint=%2Fv1%2Fx&status=paid'],
    ['/calls', '?paidWith=bogus&page=0&status=nope', '/calls.md'],
    ['/calls', '?page=1', '/calls.md'],
    ['/services', '?q=quotes&sort=newest', '/services.md?q=quotes&sort=newest'],
    ['/services', '?sort=calls', '/services.md'],
    ['/services', '?sort=price&page=3', '/services.md?sort=price&page=3'],
    ['/services', '?sort=bogus&q=%20%20', '/services.md'],
    ['/services/api.example.com', '', '/services/api.example.com.md'],
    ['/services/api.example.com', '?period=7d', '/services/api.example.com.md?period=7d'],
    ['/services/api.example.com', '?period=30d', '/services/api.example.com.md'],
    ['/services/api.example.com', '?period=bogus&from=check', '/services/api.example.com.md'],
    ['/services/fake-api.test%3A8186', '?period=all', '/services/fake-api.test%3A8186.md?period=all'],
    ['/check', '', '/check.md'],
    ['/check', '?url=api.example.com%2Fv1', '/check.md?url=api.example.com%2Fv1'],
    ['/check', '?url=api.example.com%2Fv1&method=POST&period=7d&page=2', '/check.md?url=api.example.com%2Fv1&method=POST&period=7d&page=2'],
    ['/check', '?url=api.example.com%2Fv1&tab=json', '/check.md?url=api.example.com%2Fv1'],
    ['/check', '?url=a.example.com&method=ANY&tab=code', '/check.md?url=a.example.com'],
    ['/check', '?url=a.example.com&method=PUT', '/check.md?url=a.example.com&method=PUT'],
    ['/check', '?page=2&period=today&url=a.example.com&method=GET', '/check.md?url=a.example.com&method=GET&period=today&page=2'],
  ])('for %s%s is %s', (path, query, twin) => {
    expect(twinHref(path, query)).toBe(twin);
    expect(twinHref(path, new URLSearchParams(query))).toBe(twin);
  });

  it('reads the object a page receives as well as the text', () => {
    expect(twinQuery('/calls', { paidWith: 'near', page: ['2', '3'] })).toBe('?paidWith=near&page=2');
    expect(twinQuery('/services', { q: undefined, sort: 'newest' })).toBe('?sort=newest');
  });

  it('is the page\'s own address with `.md` for every state the page writes itself', () => {
    expect(twinHref('/calls', callsHref({ paidWith: 'near', status: 'paid', page: 2 }).slice('/calls'.length))).toBe(callsHref({ paidWith: 'near', status: 'paid', page: 2 }, '/calls.md'));
    expect(twinHref('/services', servicesHref({ q: 'a', sort: 'newest', page: 2 }).slice('/services'.length))).toBe(servicesHref({ q: 'a', sort: 'newest', page: 2 }, '/services.md'));
    const params = { url: 'api.example.com/v1', method: 'POST', tab: 'overview', period: '7d', page: 2 } as const;
    expect(twinHref('/check', checkAddress(params).slice('/check'.length))).toBe(checkAddress(params, '/check.md'));
  });
});

describe('the Link header and the link tag', () => {
  const pages: readonly (readonly [string, string])[] = [
    ['/', ''], ['/agents', ''], ['/calls', ''], ['/calls', '?paidWith=near&page=2'], ['/calls/pay_abc', ''],
    ['/services', '?q=quotes&sort=newest'], ['/services/api.example.com', '?period=7d'],
    ['/check', ''], ['/check', '?url=api.example.com%2Fv1&method=POST&period=7d&page=2&tab=json'],
  ];

  it.each(pages)('carry the same twin, with the query, on %s%s', (path, query) => {
    const header = linkHeader(settings, path, new URLSearchParams(query))!;
    const tag = twinLink(settings, path, query)!;
    const fromHeader = /<([^>]+)>; rel="alternate"; type="text\/markdown"/.exec(header)![1];

    expect(fromHeader).toBe(tag.href);
    expect(fromHeader).toBe(`https://site.example.com${twinHref(path, query)}`);
    expect(pageLinks(settings, path, query)[0]).toEqual(tag);
  });

  it('points to the filtered twin, never to the empty one', () => {
    expect(linkHeader(settings, '/check', new URLSearchParams('url=api.example.com%2Fv1'))).toContain('<https://site.example.com/check.md?url=api.example.com%2Fv1>');
    expect(linkHeader(settings, '/calls', new URLSearchParams('paidWith=near'))).toContain('<https://site.example.com/calls.md?paidWith=near>');
    expect(linkHeader(settings, '/services', new URLSearchParams('sort=newest'))).toContain('<https://site.example.com/services.md?sort=newest>');
  });
});

describe('the Agent view follows the address', () => {
  const nowKey = (source: AgentSource, search: string): string => twinKeyOf(source, '/first.md', new URLSearchParams(search));

  it('builds the twin from the address as it is now, for each page', () => {
    expect(nowKey({ kind: 'calls' }, '?paidWith=near&page=2')).toBe('/calls.md?paidWith=near&page=2');
    expect(nowKey({ kind: 'calls' }, '')).toBe('/calls.md');
    expect(nowKey({ kind: 'services' }, '?q=a&sort=newest')).toBe('/services.md?q=a&sort=newest');
    expect(nowKey({ kind: 'service', host: 'API.example.com' }, '?period=7d')).toBe('/services/api.example.com.md?period=7d');
    expect(nowKey({ kind: 'service', host: 'api.example.com' }, '?period=today&from=check')).toBe('/services/api.example.com.md?period=today');
    expect(nowKey({ kind: 'check', state: { kind: 'empty' } }, '?url=a.example.com&period=7d&page=2&tab=code')).toBe('/check.md?url=a.example.com&period=7d&page=2');
    expect(nowKey({ kind: 'static' }, '?page=2')).toBe('/first.md');
  });

  const read = (path: string) => ({ ok: true as const, value: answer(new URL(path, 'http://fake.example.com'), 'full', now)!.body });
  const reader = (async (path: string) => read(path)) as never;
  const hosts = { apiUrl: 'https://api.example.com', payUrl: 'https://pay.example.com' };

  it('reads the data again for the filters of the address, and lists the requests for them', async () => {
    const calls = await deriveAgent({ kind: 'calls' }, reader, hosts, new URLSearchParams('paidWith=near&page=2'));
    expect(calls!.requests.map(request => request.url)).toContain('https://api.example.com/v1/calls?paidWith=near&page=2&size=20');
    expect((calls!.json as { calls: { page: number } }).calls.page).toBe(2);

    const services = await deriveAgent({ kind: 'services' }, reader, hosts, new URLSearchParams('q=quotes&sort=newest'));
    expect(services!.requests[0]!.url).toContain('sort=newest');
    expect(services!.requests[0]!.url).toContain('q=quotes');

    const service = await deriveAgent({ kind: 'service', host: 'api.example.com' }, reader, hosts, new URLSearchParams('period=7d'));
    expect(service!.requests[0]!.url).toContain('period=7d');
    expect((service!.json as { service: { period: string } }).service.period).toBe('7d');
  });

  it('keeps the check as it was made and reads the endpoint\'s numbers again for the period and the page', async () => {
    const state: CheckState = {
      kind: 'payable',
      raw: { payable: true },
      check: { host: 'api.example.com', path: '/v1/sample/quotes/latest' } as never,
    };
    const derived = await deriveAgent({ kind: 'check', state }, reader, hosts, new URLSearchParams('url=api.example.com%2Fv1%2Fsample%2Fquotes%2Flatest&period=7d&page=2'));
    const urls = derived!.requests.map(request => request.url);

    expect(urls.some(url => url.includes('/v1/endpoints/stats') && url.includes('period=7d'))).toBe(true);
    expect(urls.some(url => url.includes('/v1/calls?') && url.includes('page=2'))).toBe(true);
    expect((derived!.json as { check: unknown }).check).toEqual({ payable: true });
    expect((derived!.json as { stats: { period: string } }).stats.period).toBe('7d');
  });

  it('has nothing to read again for a page that doesn\'t change', async () => {
    expect(await deriveAgent({ kind: 'static' }, reader, hosts, new URLSearchParams())).toBeUndefined();
  });
});
