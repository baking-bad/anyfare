import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { routedEndpoints } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, fixtureTime, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
const servers: ApiServer[] = [];

const start = async (platform: PlatformConfig): Promise<string> => {
  const server = createApp({ config: platform, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock: createFakeClock() });
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
  readonly updatedAt: string;
  readonly link: string;
}

const list = async (url: string, query = '') => {
  const response = await fetch(`${url}/v1/catalog${query}`);

  return { status: response.status, headers: response.headers, body: await response.json() as { endpoints: Item[]; next: string | null } };
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

    expect(await list(url)).toMatchObject({ status: 200, body: { endpoints: [], next: null } });
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
      updatedAt: fixtureTime(0, 9, 8, 0, 0, 0),
      link: `${config.urls.pay.replace(/\/+$/, '')}/weather.example.com/v1/forecast`,
    });
    expect(all.body.endpoints[2]).toMatchObject({ priceFrom: '0', link: expect.stringContaining('/unquoted.example.com:8443/v1/x') });

    const first = await list(url, '?limit=2');
    const second = await list(url, `?limit=2&cursor=${first.body.next}`);
    expect(first.body.endpoints).toHaveLength(2);
    expect(first.body.next).toBe('2');
    expect(second.body.endpoints.map(item => item.host)).toEqual(['unquoted.example.com:8443']);
    expect(second.body.next).toBeNull();

    expect((await list(url, '?q=WEATHER')).body.endpoints.map(item => item.host)).toEqual(['weather.example.com']);
    // % and _ match themselves, not any text
    expect((await list(url, '?q=100%25_off')).body.endpoints.map(item => item.host)).toEqual(['quotes.example.com']);
    expect((await list(url, '?q=%25')).body.endpoints.map(item => item.host)).toEqual(['quotes.example.com']);
    expect((await list(url, '?q=v1_f')).body.endpoints).toEqual([]);
    expect((await list(url, '?maxPrice=0.5')).body.endpoints.map(item => item.host)).toEqual(['weather.example.com']);
    expect((await list(url, '?maxPrice=3&q=example.com')).body.endpoints).toHaveLength(2);
  });

  it('offers MPP only when the config has a recipient, and x402 only for a price an asset accepts', async () => {
    const withoutRecipient = await start({ ...config, mpp: { ...config.mpp, recipient: undefined } });
    const withRecipient = await start(config);

    expect((await list(withRecipient, '?q=weather')).body.endpoints[0]?.methods).toEqual(['credits', 'x402', 'mpp']);
    expect((await list(withoutRecipient, '?q=weather')).body.endpoints[0]?.methods).toEqual(['credits', 'x402']);
  });

  it('lists x402 for routed endpoints with config/production.yaml once NEAR mainnet\'s payTo is its only one: our facilitator settles there', async () => {
    const loaded = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/production.yaml' } });
    // A made-up account of ours on NEAR mainnet
    const production = { ...loaded, assets: loaded.assets.map(asset => asset.name === 'near-usdc' ? { ...asset, payTo: 'pay.anyfare.test.near' } : asset) };
    const withNear = await start(production);
    const without = await start(loaded);

    expect(production.facilitators.find(facilitator => facilitator.networks.includes('near:mainnet'))).toMatchObject({ name: 'near', enabled: true });
    expect((await list(withNear, '?q=weather')).body.endpoints[0]?.methods).toEqual(['credits', 'x402']);
    expect((await list(without, '?q=weather')).body.endpoints[0]?.methods).toEqual(['credits']);
  });

  it('refuses a limit outside 1 to 100, a bad cursor, a bad maxPrice, and a long q', async () => {
    const url = await start(config);

    for (const query of ['?limit=0', '?limit=101', '?cursor=-1', '?cursor=1234567890', '?maxPrice=free', `?q=${'a'.repeat(201)}`])
      expect((await list(url, query)).status, query).toBe(400);
    expect((await list(url, '?limit=100')).status).toBe(200);
  });
});
