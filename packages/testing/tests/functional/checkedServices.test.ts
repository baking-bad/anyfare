import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemClock } from '@anyfare/common';
import { createRoutingRepository, routedEndpoints } from '@anyfare/db';

import { createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '../../src/index.js';
import { defaultStackPorts, startLocalStack, type LocalStack } from '../../src/local/stack.js';

// A link a check finds payable joins the services through the real apps: the proxy checks the fake paid API and
// lists it through the API's internal listener, and the API's public reads show it, until a paid call makes it
// paid, or the blocklist takes it out.

let database: TestDatabase;
let redis: TestRedis;
let stack: LocalStack;

const freePorts = Object.fromEntries(Object.keys(defaultStackPorts).map(name => [name, 0]));
const json = async (url: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const response = await fetch(url, init);
  const text = await response.text();

  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
};
const check = (target: string) => json(`${stack.urls.pay}/_/check?url=${encodeURIComponent(target)}`);
const service = () => json(`${stack.urls.api}/v1/services/${stack.paidApiHost}`);
const listed = async () => ((await json(`${stack.urls.api}/v1/services?q=fake-api`)).body.services as { host: string; status: string }[]);
const rows = () => database.db.select().from(routedEndpoints).where(eq(routedEndpoints.host, stack.paidApiHost));

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  stack = await startLocalStack({ databaseUrl: database.url.expose(), redisUrl: redis.url.expose(), redisPrefix: redis.prefix, ports: freePorts });
}, 60_000);

afterAll(async () => {
  await stack?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('a checked link through the real apps', () => {
  it('joins the services as checked within seconds of a payable check, with its host and path only', async () => {
    const checked = await check(`${stack.urls.paidApi}/base?token=secret-in-query`);

    expect(checked.body).toMatchObject({ payable: true, listed: true });
    await expect.poll(async () => (await service()).status, { timeout: 5_000, interval: 200 }).toBe(200);
    const page = await service();
    expect(page.body).toMatchObject({ host: stack.paidApiHost, status: 'checked', paidEndpoints: 1, stats: { calls: 0 } });
    expect(page.body.endpoints).toEqual([expect.objectContaining({
      path: '/base', status: 'checked', method: 'GET', priceNow: '0.0011', calls: 0, link: `${stack.urls.pay}/${stack.paidApiHost}/base`,
    })]);
    expect(await listed()).toEqual([expect.objectContaining({ host: stack.paidApiHost, status: 'checked', calls: 0 })]);
    const catalog = await json(`${stack.urls.api}/v1/catalog?q=fake-api`);
    expect(catalog.body.endpoints).toEqual([expect.objectContaining({ host: stack.paidApiHost, path: '/base', status: 'checked' })]);
    expect(JSON.stringify([page.body, catalog.body, await rows()], (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value))).not.toContain('secret-in-query');
  });

  it('adds no row for a second check of the same link', async () => {
    expect((await check(`${stack.urls.paidApi}/base`)).body).toMatchObject({ payable: true, listed: true });
    await new Promise(resolve => setTimeout(resolve, 300));

    expect((await rows()).map(row => [row.path, row.status])).toEqual([['/base', 'checked']]);
  });

  it('becomes paid at its first billable call', async () => {
    const account = await json(`${stack.urls.api}/v1/accounts`, { method: 'POST' });
    const created = await json(`${stack.urls.api}/v1/keys`, { method: 'POST', headers: { authorization: `Bearer ${account.body.masterKey}` } });

    const paid = await fetch(`${stack.urls.pay}/${stack.paidApiHost}/base`, { headers: { authorization: `Bearer ${created.body.key}` } });

    expect(paid.status).toBe(200);
    await expect.poll(async () => (await rows())[0]?.status, { timeout: 5_000, interval: 200 }).toBe('paid');
    await expect.poll(async () => (await service()).body.status, { timeout: 5_000, interval: 200 }).toBe('paid');
    // The list is kept 5 s in the API's process
    await expect.poll(async () => (await listed()).map(each => [each.host, each.status]), { timeout: 8_000, interval: 250 }).toEqual([[stack.paidApiHost, 'paid']]);
  }, 30_000);

  it('leaves the services, its page and the catalog once its host is on the blocklist', async () => {
    await createRoutingRepository({ db: database.db, clock: systemClock }).block({ host: 'fake-api.test', reason: 'abuse' });

    await expect.poll(async () => (await service()).status, { timeout: 5_000, interval: 200 }).toBe(404);
    // The list is kept 5 s, a page of the catalog 10 s, in the API's process
    await expect.poll(listed, { timeout: 8_000, interval: 250 }).toEqual([]);
    await expect.poll(async () => (await json(`${stack.urls.api}/v1/catalog?q=fake-api`)).body.endpoints, { timeout: 13_000, interval: 500 }).toEqual([]);
    expect((await check(`${stack.urls.paidApi}/near`)).body).toMatchObject({ payable: false, reason: 'host_not_allowed', detail: 'blocklisted' });
  }, 30_000);
});
