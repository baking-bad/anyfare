import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import { createBlocklistMatcher, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { catalogScanBudget, createRoutingRepository, hostBlocklist, routedEndpoints } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, fixtureTime, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';
import { catalogCacheMs } from '../../src/catalog/routes.js';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
const servers: ApiServer[] = [];

const clock = createFakeClock('2026-11-12T10:00:00.000Z');

const start = async (platform: PlatformConfig): Promise<string> => {
  const server = createApp({ config: platform, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock });
  servers.push(server);

  return `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
};

interface Item {
  readonly id: string;
  readonly host: string;
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly priceFrom: string;
  readonly currency: string;
  readonly methods: readonly string[];
  readonly verified: boolean;
  readonly status: string;
  readonly updatedAt: string;
  readonly link: string;
}

const list = async (url: string, query = '') => {
  const response = await fetch(`${url}/v1/catalog${query}`);

  return { status: response.status, headers: response.headers, body: await response.json() as { endpoints: Item[]; next: string | null; partial: boolean } };
};

beforeAll(async () => {
  [database, redis, config] = await Promise.all([
    createTestDatabase(), createTestRedis(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }),
  ]);
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('GET /v1/catalog', () => {
  it('limits calls per client IP under the documents limit', async () => {
    const limited = await start({ ...config, rateLimits: { ...config.rateLimits, documents: { requests: 2, windowSeconds: 60 } } });
    const statuses = [await list(limited), await list(limited), await list(limited)].map(response => response.status);

    expect(statuses).toEqual([200, 200, 429]);
  });

  it('answers an empty list without a key', async () => {
    const url = await start(config);

    expect(await list(url)).toMatchObject({ status: 200, body: { endpoints: [], next: null, partial: false } });
  });

  it('lists routed endpoints oldest first, pages them, and filters by q and maxPrice', async () => {
    const url = await start(config);
    await database.db.insert(routedEndpoints).values([
      { host: 'weather.example.com', path: '/v1/forecast', lastPrice: 10_000n, createdAt: new Date(fixtureTime(0, 9, 8, 0, 0, 0)) },
      { host: 'quotes.example.com', path: '/v1/100%_off', lastPrice: 2_500_000n, createdAt: new Date(fixtureTime(0, 9, 9, 0, 0, 0)) },
      { host: 'unquoted.example.com:8443', path: '/v1/x', createdAt: new Date(fixtureTime(0, 9, 10, 0, 0, 0)) },
    ]);

    const all = await list(url);
    expect(all.headers.get('cache-control')).toBe('public, max-age=60');
    expect(all.body.next).toBeNull();
    expect(all.body.endpoints.map(item => item.id)).toEqual([
      'routed:weather.example.com/v1/forecast', 'routed:quotes.example.com/v1/100%_off', 'routed:unquoted.example.com:8443/v1/x',
    ]);
    expect(all.body.endpoints[0]).toEqual({
      id: 'routed:weather.example.com/v1/forecast',
      host: 'weather.example.com',
      path: '/v1/forecast',
      title: 'weather.example.com/v1/forecast',
      summary: 'A paid API that Anyfare routes payments to. Unverified: its owner hasn\'t registered it.',
      priceFrom: '0.01',
      currency: 'USD',
      methods: ['credits', 'x402', 'mpp'],
      verified: false,
      status: 'paid',
      updatedAt: fixtureTime(0, 9, 8, 0, 0, 0),
      link: `${config.urls.pay.replace(/\/+$/, '')}/weather.example.com/v1/forecast`,
    });
    expect(all.body.endpoints[2]).toMatchObject({ priceFrom: '0', link: expect.stringContaining('/unquoted.example.com:8443/v1/x') });

    const first = await list(url, '?limit=2');
    const second = await list(url, `?limit=2&cursor=${first.body.next}`);
    expect(first.body.endpoints).toHaveLength(2);
    // Opaque: where the page goes on from, not an offset
    expect(first.body.next).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(second.body.endpoints.map(item => item.host)).toEqual(['unquoted.example.com:8443']);
    expect([second.body.next, second.body.partial]).toEqual([null, false]);

    expect((await list(url, '?q=WEATHER')).body.endpoints.map(item => item.host)).toEqual(['weather.example.com']);
    // % and _ match themselves, not any text
    expect((await list(url, '?q=100%25_off')).body.endpoints.map(item => item.host)).toEqual(['quotes.example.com']);
    expect((await list(url, '?q=%25')).body.endpoints.map(item => item.host)).toEqual(['quotes.example.com']);
    expect((await list(url, '?q=v1_f')).body.endpoints).toEqual([]);
    expect((await list(url, '?maxPrice=0.5')).body.endpoints.map(item => item.host)).toEqual(['weather.example.com']);
    expect((await list(url, '?maxPrice=3&q=example.com')).body.endpoints).toHaveLength(2);
  });

  it('lists an endpoint a check found payable as checked, and leaves out a blocked host\'s at once, with its port too', async () => {
    const url = await start(config);
    const routing = createRoutingRepository({ db: database.db, clock: createFakeClock('2026-11-12T10:00:00.000Z') });
    await routing.registerEndpoint({ host: 'checked.example.dev', path: '/v1/found', lastPrice: 1_100n, checked: { method: 'POST', mayAddHost: true } });
    await routing.registerEndpoint({ host: 'spam.example.dev', path: '/v1/x', lastPrice: 1_100n, checked: { method: 'GET', mayAddHost: true } });
    await routing.registerEndpoint({ host: 'spam.example.dev:8443', path: '/v1/paid', lastPrice: 1_100n });

    const before = await list(url, '?q=example.dev');
    await routing.block({ host: 'spam.example.dev', reason: 'abuse' });
    const cached = await list(url, '?q=EXAMPLE.dev');
    // Past the 10 seconds a page is kept in the process
    clock.advance(catalogCacheMs);
    const after = await list(url, '?q=example.dev');
    // A parent domain's entry covers its subdomains
    await routing.registerEndpoint({ host: 'a.parent.example.dev', path: '/v1/x', checked: { method: 'GET', mayAddHost: true } });
    await routing.registerEndpoint({ host: 'parent.example.dev', path: '/v1/x', lastPrice: 1_000n });
    await routing.block({ host: 'parent.example.dev', reason: 'abuse' });
    clock.advance(catalogCacheMs);
    const parentBlocked = await list(url, '?q=parent.example.dev');

    expect(before.body.endpoints.map(item => [item.host, item.status])).toEqual([
      ['checked.example.dev', 'checked'], ['spam.example.dev', 'checked'], ['spam.example.dev:8443', 'paid'],
    ]);
    expect(before.body.endpoints[0]).toMatchObject({ path: '/v1/found', priceFrom: '0.0011', verified: false, summary: expect.stringContaining('No paid call has reached it yet') });
    // The same page, whatever the search's case, from the process until it is stale
    expect(cached.body).toEqual(before.body);
    expect(after.body.endpoints.map(item => item.host)).toEqual(['checked.example.dev']);
    expect(parentBlocked.body.endpoints).toEqual([]);
  });

  it('offers MPP only when the config has a recipient, and x402 only for a price an asset accepts', async () => {
    const withoutRecipient = await start({ ...config, mpp: { ...config.mpp, recipient: undefined } });
    const withRecipient = await start(config);

    expect((await list(withRecipient, '?q=weather')).body.endpoints[0]?.methods).toEqual(['credits', 'x402', 'mpp']);
    expect((await list(withoutRecipient, '?q=weather')).body.endpoints[0]?.methods).toEqual(['credits', 'x402']);
  });

  it('lists every way to pay for routed endpoints with config/production.yaml: x402 on each chain with a payTo, and MPP to our Tempo recipient', async () => {
    const production = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/production.yaml' } });
    // The same without a receiving address at all, nor an MPP recipient
    const noPayTo = { ...production, assets: production.assets.map(asset => ({ ...asset, payTo: undefined })), mpp: { ...production.mpp, recipient: undefined } };
    const withWallets = await start(production);
    const without = await start(noPayTo);

    expect(production.facilitators.find(facilitator => facilitator.networks.includes('near:mainnet'))).toMatchObject({ name: 'near', enabled: true });
    expect((await list(withWallets, '?q=weather')).body.endpoints[0]?.methods).toEqual(['credits', 'x402', 'mpp']);
    expect((await list(without, '?q=weather')).body.endpoints[0]?.methods).toEqual(['credits']);
  });

  it('refuses a limit outside 1 to 100, a cursor no page gave, an offset as pages gave before, a bad maxPrice, and a long q', async () => {
    const url = await start(config);

    for (const query of ['?limit=0', '?limit=101', '?cursor=-1', '?cursor=1234567890', '?cursor=2', '?cursor=10000', '?cursor=a%2Bb', '?maxPrice=free', `?q=${'a'.repeat(201)}`])
      expect((await list(url, query)).status, query).toBe(400);
    expect(await list(url, '?cursor=20')).toMatchObject({ status: 400, body: { error: { code: 'invalid_request', message: expect.stringContaining('first page') } } });
    expect((await list(url, '?limit=100')).status).toBe(200);
  });

  it('goes on past 10,000 endpoints to the newest, a page from where the last stopped, and a search reaches them a budget at a time', async () => {
    const url = await start({ ...config, rateLimits: { ...config.rateLimits, documents: { requests: 100_000, windowSeconds: 60 } } });
    // 10,050 more, all of one time but the newest, a paid call's: the cursor holds its place among those of one time
    const at = new Date('2026-11-12T09:30:00.000Z');
    for (let index = 0; index < 10_050; index += 1_000) {
      await database.db.insert(routedEndpoints).values(Array.from({ length: Math.min(1_000, 10_050 - index) }, (_, offset) => ({
        host: `bulk-${String(index + offset).padStart(5, '0')}.deep.example`, path: '/v1/x', lastPrice: 1_000n, createdAt: at, status: 'paid' as const,
      })));
    }
    await database.db.insert(routedEndpoints).values({ host: 'newest.deep.example', path: '/v1/last', lastPrice: 1_000n, createdAt: new Date('2026-11-12T11:00:00.000Z') });
    // Every endpoint but those of the hosts blocked above
    const isBlocked = createBlocklistMatcher((await database.db.select({ host: hostBlocklist.host }).from(hostBlocklist)).map(entry => entry.host));
    const total = (await database.db.select({ host: routedEndpoints.host }).from(routedEndpoints)).filter(row => !isBlocked(row.host)).length;
    clock.advance(catalogCacheMs);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 200; pages += 1) {
      const page: Awaited<ReturnType<typeof list>> = await list(url, `?limit=100${cursor === null ? '' : `&cursor=${cursor}`}`);
      seen.push(...page.body.endpoints.map(item => item.id));
      expect(page.body.partial).toBe(false);
      cursor = page.body.next;
      if (cursor === null)
        break;
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen.at(-1)).toBe('routed:newest.deep.example/v1/last');
    // A search past the budget: pages that found nothing say so, and go on from where they stopped
    const found: string[] = [];
    const partial: boolean[] = [];
    cursor = null;
    for (let pages = 0; pages < 50; pages += 1) {
      const page: Awaited<ReturnType<typeof list>> = await list(url, `?q=newest.deep&limit=10${cursor === null ? '' : `&cursor=${cursor}`}`);
      found.push(...page.body.endpoints.map(item => item.id));
      partial.push(page.body.partial);
      cursor = page.body.next;
      if (cursor === null)
        break;
    }

    expect(found).toEqual(['routed:newest.deep.example/v1/last']);
    // At most 1,000 endpoints read a page: some pages stopped at the budget with nothing found
    expect(partial.filter(Boolean).length).toBeGreaterThanOrEqual(Math.floor(total / catalogScanBudget) - 1);
    expect(partial.at(-1)).toBe(false);
    await database.db.delete(routedEndpoints).where(sql`${routedEndpoints.host} like '%.deep.example'`);
  });

  it('answers 503 when its read can\'t finish in its 2 s, never kept by a cache, and reads again at the next request', async () => {
    const url = await start({ ...config, rateLimits: { ...config.rateLimits, documents: { requests: 100_000, windowSeconds: 60 } } });
    clock.advance(catalogCacheMs);

    // Another session holds the table: the read waits for it until its statement gives up
    const stalled = await database.db.transaction(async tx => {
      await tx.execute(sql`lock table routed_endpoints in access exclusive mode`);
      const started = performance.now();
      const answer = await list(url, '?limit=7');

      return { answer, tookMs: performance.now() - started };
    });
    const after = await list(url, '?limit=7');

    expect(stalled.answer).toMatchObject({ status: 503, body: { error: { code: 'stats_unavailable' } } });
    expect(stalled.answer.headers.get('cache-control')).toBe('no-store');
    expect(stalled.tookMs).toBeGreaterThanOrEqual(1_900);
    expect(stalled.tookMs).toBeLessThan(4_000);
    expect(after.status).toBe(200);
    expect(after.headers.get('cache-control')).toBe('public, max-age=60');
  });
});
