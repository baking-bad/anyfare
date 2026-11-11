import { afterEach, describe, expect, it } from 'vitest';

import { getEndpointStats, getReceipt, getService, getStats, listCalls, listServices } from '../src/api/endpoints';
import { createReader } from '../src/api/reader';
import { parseFilters, withFilter, withoutControls } from '../src/calls/filters';
import { paidWithFilterName, paidWithName } from '../src/content/home';
import { usdOf } from '../src/format';
import { parseServicesFilters, withSearch } from '../src/services/filters';
import { inexactHost, startFakeApi, unavailableHost, unpricedHost, type FakeApi } from './support/fakeApi';

let fake: FakeApi | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const readerOf = async (mode: Parameters<typeof startFakeApi>[0]) => {
  fake = await startFakeApi(mode);

  return createReader({ apiUrl: fake.url });
};

describe('the fake API answers in the real shapes', () => {
  it('gives the two times of the platform numbers, and null for both when nothing is counted', async () => {
    const full = await getStats(await readerOf('full'));
    expect(full.ok && typeof full.value.allUpdatedAt).toBe('string');
    expect(full.ok && full.value.allUpdatedAt).not.toBe(full.ok && full.value.updatedAt);
    await fake!.close();
    const empty = await getStats(await readerOf('empty'));
    expect(empty.ok && [empty.value.updatedAt, empty.value.allUpdatedAt]).toEqual([null, null]);
  });

  it('has a service with no price: null in the list and on its page', async () => {
    const read = await readerOf('full');
    const list = await listServices(read, { q: unpricedHost });
    const service = await getService(read, unpricedHost);

    expect(list.ok && list.value.services[0]!.priceFrom).toBeNull();
    expect(service.ok && service.value.endpoints.length).toBeGreaterThan(0);
    expect(service.ok && service.value.endpoints.every(endpoint => endpoint.priceNow === null)).toBe(true);
    expect(usdOf(null, 3)).toBe('-');
  });

  it('puts a service with no price last when the list is sorted by price', async () => {
    const read = await readerOf('full');
    const sorted = await listServices(read, { sort: 'price', size: 100 });

    expect(sorted.ok && sorted.value.services.at(-1)!.priceFrom).toBeNull();
    expect(sorted.ok && sorted.value.services.filter(service => service.priceFrom === null)).toHaveLength(1);
  });

  it('has one service and one endpoint whose numbers stopped at their cap', async () => {
    const read = await readerOf('full');
    const inexact = await getService(read, inexactHost);
    const exact = await getService(read, 'api.example.com');
    const endpoint = await getEndpointStats(read, inexactHost, '/v1/sample/lookup');

    expect(inexact.ok && inexact.value.exact).toBe(false);
    expect(exact.ok && exact.value.exact).toBe(true);
    expect(endpoint.ok && endpoint.value.exact).toBe(false);
    expect(exact.ok && exact.value.paidEndpoints).toBeGreaterThan(0);
  });

  it('answers 503 stats_unavailable for one host, on its service and its endpoint', async () => {
    const read = await readerOf('full');
    const service = await getService(read, unavailableHost);
    const endpoint = await getEndpointStats(read, unavailableHost, '/v1/sample/lookup');

    expect(service).toMatchObject({ ok: false, error: { status: 503, code: 'stats_unavailable' } });
    expect(endpoint).toMatchObject({ ok: false, error: { status: 503, code: 'stats_unavailable' } });
    expect(await getService(read, 'api.example.com')).toMatchObject({ ok: true });
  });

  it('says the list is capped in its own mode only', async () => {
    const capped = await listServices(await readerOf('capped'));
    expect(capped.ok && capped.value.totalCapped).toBe(true);
    await fake!.close();
    const full = await listServices(await readerOf('full'));
    expect(full.ok && full.value.totalCapped).toBe(false);
  });

  it('answers a receipt whose payment is still settling: no fee, no settled step, and `received` first', async () => {
    const read = await readerOf('full');
    const settling = await getReceipt(read, 'pay_settling');
    const free = await getReceipt(read, 'pay_freenoapi');

    expect(settling.ok && [settling.value.fee, settling.value.buyer.settledAt, settling.value.steps.map(step => step.step)]).toEqual([null, null, ['received', 'authorized', 'api_signed', 'api_answered']]);
    expect(settling.ok && settling.value.api?.status).toBe('signed');
    expect(free.ok && [free.value.api, free.value.apiPrice]).toEqual([null, null]);
  });

  it('refuses a NUL in a filter with 400, as the API does', async () => {
    const read = await readerOf('full');

    expect(await listCalls(read, { service: 'a\u0000b' })).toMatchObject({ ok: false, error: { status: 400, code: 'invalid_request' } });
    expect(await listServices(read, { q: 'a\u0000b' })).toMatchObject({ ok: false, error: { status: 400 } });
  });
});

describe('the shape checks of the reads', () => {
  const answerWith = (body: unknown) => createReader({ apiUrl: 'http://api.example.com', fetch: async () => Response.json(body) });

  it('turn an answer that lacks a field the page needs into an error value', async () => {
    const page = { services: [], page: 1, size: 20, total: 0, totals: { services: 0, paidEndpoints: 0, calls30d: 0 }, updatedAt: null };

    expect(await listServices(answerWith(page))).toMatchObject({ ok: false, error: { code: 'unexpected_answer' } });
    expect(await listServices(answerWith({ ...page, totalCapped: false }))).toMatchObject({ ok: true });
    expect(await getService(answerWith({ host: 'a.example.com', stats: {}, endpoints: [], daily: [], byPaidWith: [], topBuyers: { buyers: [] } }), 'a.example.com')).toMatchObject({ ok: false, error: { code: 'unexpected_answer' } });
    expect(await getEndpointStats(answerWith({ stats: {}, daily: [], byPaidWith: [] }), 'a.example.com', '/x')).toMatchObject({ ok: false, error: { code: 'unexpected_answer' } });
  });
});

describe('the filters the page sends', () => {
  it('drop control characters, a NUL included, from the service and the endpoint', () => {
    expect(withoutControls('api\u0000.exa\u001fmple\u007f')).toBe('api.example');
    expect(parseFilters(new URLSearchParams('service=api%00.example&endpoint=/v1/a%00b'))).toEqual({ service: 'api.example', endpoint: '/v1/ab', page: 1 });
    expect(withFilter({ page: 3 }, 'service', 'a\u0000b')).toEqual({ service: 'ab', page: 1 });
    expect(parseFilters(new URLSearchParams('service=%00'))).toEqual({ page: 1 });
  });

  it('drop them from the Services search as well', () => {
    expect(parseServicesFilters(new URLSearchParams('q=a%00b')).q).toBe('ab');
    expect(withSearch({ sort: 'calls', page: 2 }, 'a\u0000b')).toEqual({ q: 'ab', sort: 'calls', page: 1 });
  });
});

describe('the name of a way to pay', () => {
  it('reads the same in the filter and the bar lists, but for Tempo, as the mockups have it', () => {
    for (const way of ['near', 'base', 'solana', 'credits'] as const)
      expect(paidWithFilterName(way)).toBe(paidWithName(way));
    expect(paidWithFilterName('tempo')).toBe('USDC.e on Tempo');
    expect(paidWithName('tempo')).toBe('MPP on Tempo');
    expect(paidWithFilterName('bitcoin')).toBe('bitcoin');
  });
});
