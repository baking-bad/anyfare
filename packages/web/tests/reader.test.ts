import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { getLiveStats, getStats, listCalls, listServices, paths } from '../src/api/endpoints';
import { createReader } from '../src/api/reader';
import { serverReader, visitorAddress } from '../src/api/server';
import { readSettings } from '../src/config';
import { refusedUrl, startFakeApi, type FakeApi } from './support/fakeApi';

let fake: FakeApi | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('reading the public API', () => {
  it('reads each endpoint a page needs, with the filters in the query', async () => {
    fake = await startFakeApi('full');
    const read = createReader({ apiUrl: fake.url });

    const [stats, live, calls, services] = await Promise.all([getStats(read), getLiveStats(read), listCalls(read, { size: 6, status: 'paid' }), listServices(read, { sort: 'calls', size: 5 })]);

    expect(stats.ok && stats.value.daily).toHaveLength(30);
    expect(live.ok && live.value.last24h.volume).toBe('18.42');
    expect(calls.ok && calls.value.calls).toHaveLength(6);
    expect(services.ok && services.value.services.map(service => service.host)[0]).toBe('api.example.com');
    expect(fake.requests.map(request => request.path)).toContain('/v1/calls?status=paid&size=6');
    expect(fake.requests.map(request => request.path)).toContain('/v1/services?sort=calls&size=5');
  });

  it('builds paths without empty parameters', () => {
    expect(paths.calls()).toBe('/v1/calls');
    expect(paths.calls({ service: '', size: 6 })).toBe('/v1/calls?size=6');
    expect(paths.callStream({ paidWith: 'near' })).toBe('/v1/calls/stream?paidWith=near');
  });

  it('gives an error value, not an exception, when the API answers 500', async () => {
    fake = await startFakeApi('down');

    const result = await getStats(createReader({ apiUrl: fake.url }));

    expect(result).toEqual({ ok: false, error: { status: 500, code: 'internal_error', message: 'Internal server error' } });
  });

  it('gives an error value when the connection is refused', async () => {
    const result = await listCalls(createReader({ apiUrl: await refusedUrl() }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('api_unavailable');
  });

  it('gives an error value when the API is slower than the timeout', async () => {
    const slow = createServer(() => undefined);
    await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', resolve));
    const failures: string[] = [];
    try {
      const result = await getLiveStats(createReader({ apiUrl: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`, timeoutMs: 100, onFailure: failure => failures.push(`${failure.code} ${failure.cause}`) }));

      expect(!result.ok && result.error.code).toBe('api_unavailable');
      expect(failures).toEqual(['api_unavailable timeout']);
    }
    finally {
      slow.closeAllConnections();
      await new Promise<void>(resolve => slow.close(() => resolve()));
    }
  });

  it('gives an error value for an answer that isn\'t the shape the page reads', async () => {
    const read = createReader({ apiUrl: 'http://api.example.com', fetch: async () => new Response('<html>not json</html>', { status: 200 }) });
    const wrong = createReader({ apiUrl: 'http://api.example.com', fetch: async () => Response.json({ calls: 'many' }) });

    expect(await getStats(read)).toMatchObject({ ok: false, error: { code: 'unexpected_answer' } });
    expect(await listCalls(wrong)).toMatchObject({ ok: false, error: { code: 'unexpected_answer' } });
  });

  it('forwards the visitor\'s address from a server read, and sends nothing without one', async () => {
    fake = await startFakeApi('full');
    const settings = readSettings({ API_INTERNAL_URL: fake.url });

    await getStats(serverReader(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }), settings));
    await getStats(serverReader(new Headers(), settings));

    expect(fake.requests[0]!.headers['x-forwarded-for']).toBe('203.0.113.7, 10.0.0.1');
    expect(fake.requests[1]!.headers['x-forwarded-for']).toBeUndefined();
    expect(visitorAddress(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });
});
