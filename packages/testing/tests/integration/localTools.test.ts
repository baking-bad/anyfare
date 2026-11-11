import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, systemClock, type Server } from '@anyfare/common';
import type { PlatformConfig } from '@anyfare/core';
import {
  createCallRepository, createLedger, createPaymentRepository, createRoutingRepository, routedEndpoints, statsBuyers, checkedHosts, paidHosts,
} from '@anyfare/db';
import { createApp } from '@anyfare/api';

import { createFakeClock, createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '../../src/index.js';
import { loadLocalConfig } from '../../src/local/config.js';
import { countPublicNumbers, emptyLocal, seedLocal } from '../../src/local/seed.js';
import { allSeededHosts, checkedOnPaidHost, checkedServices, quietEndpoint, quietService } from '../../src/local/seedData.js';
import { createScratchDatabase, isScratchName } from '../../src/local/scratch.js';

// The seed's own options and the rows of a developer's own, on databases of their own, read through the
// Platform API's public answers

const slow = 180_000;

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let api: Server;
let url: string;

const read = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${url}${path}`);

  return { status: response.status, body: await response.json() };
};
const count = async (table: string): Promise<number> => Number((await database.db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]?.n);

// A paid call of a developer's own: another request marker than the seed's, so a wipe leaves it
const developerCall = async (): Promise<void> => {
  const clock = createFakeClock(new Date(Date.now() - 60_000));
  const ids = { next: () => `dev-${Math.random().toString(16).slice(2)}` };
  const payments = createPaymentRepository({ db: database.db, clock });
  const ledger = createLedger({ db: database.db, clock, ids });
  const asset = config.assets.find(candidate => candidate.network.chain === 'base')!;
  await payments.create({
    id: 'pay_dev-own-call', requestId: 'dev:1', targetHost: 'dev.example.com', targetPath: '/own', amount: 1_100n, rail: 'x402', buyerAccountId: undefined, keyId: undefined,
    network: asset.network.id, asset: asset.name, atomicAmount: 1_100n, status: 'verified',
  });
  await createCallRepository({ db: database.db }).recordDetails({ paymentId: 'pay_dev-own-call', method: 'GET', payer: `0x${'d'.repeat(40)}`, arrivedAt: new Date(Date.now() - 61_000) });
  await createRoutingRepository({ db: database.db, clock }).registerEndpoint({ host: 'dev.example.com', path: '/own', lastPrice: 1_100n });
  const routing = createRoutingRepository({ db: database.db, clock });
  await routing.recordSignature({
    id: 'sig_dev-own', requestId: 'dev:1', quoteId: 'pay_dev-own-call', protocol: 'x402', network: asset.network.id, asset: asset.name, atomicAmount: 1_000n, amount: 1_000n,
    payTo: `0x${'3'.repeat(40)}`, resource: 'https://dev.example.com/own', createdAt: clock.now(),
  });
  await routing.recordTargetPayment({
    paymentId: 'pay_dev-own-call', protocol: 'x402', network: asset.network.id, asset: asset.name, amount: 1_000n, atomicAmount: 1_000n, payTo: `0x${'3'.repeat(40)}`, signatureId: 'sig_dev-own',
  });
  await payments.recordDecision({ paymentId: 'pay_dev-own-call', decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 80 });
  await routing.updateTargetPayment('pay_dev-own-call', { status: 'settled', transactionHash: `0x${'f'.repeat(64)}`, receipt: 'made up' });
  await ledger.settle({ paymentId: 'pay_dev-own-call', asset: asset.name, transactionHash: `0x${'e'.repeat(64)}`, receipt: 'made up', needsReview: false });
};

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  config = await loadLocalConfig();
  api = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis });
  url = `http://127.0.0.1:${(await api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
}, slow);

afterAll(async () => {
  await api?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('the seed with services a check listed', () => {
  it('lists 6 checked hosts and 2 checked endpoints of a paid one, through the repository, and counts none as a call', async () => {
    const summary = await seedLocal({ postgres: database.postgres, config, calls: 300 });

    expect(summary.checkedServices).toBe(6);
    expect(summary.checkedEndpoints).toBe(checkedServices.reduce((sum, service) => sum + service.endpoints.length, 0) + checkedOnPaidHost.endpoints.length);
    const services = (await read('/v1/services?size=50')).body.services as { host: string; status: string; calls: number; paidEndpoints: number }[];
    for (const service of checkedServices) {
      expect(services.find(item => item.host === service.host), service.host).toMatchObject({ status: 'checked', calls: 0, paidEndpoints: service.endpoints.length });
    }
    const paid = services.filter(item => item.status === 'paid').map(item => item.host);
    expect(paid).toContain('api.example.com');
    expect(paid).not.toContain('invoices.example.com');
    // Every seeded paid endpoint is marked paid, and carries no check
    expect(await count(`routed_endpoints where status = 'paid' and check_method is null and last_price is not null`)).toBe(summary.endpoints - 1);
    const page = (await read(`/v1/services/${checkedOnPaidHost.host}?period=all`)).body;
    expect(page.status).toBe('paid');
    expect(page.endpoints.filter((endpoint: { status: string }) => endpoint.status === 'checked').map((endpoint: { path: string; method: string }) => [endpoint.path, endpoint.method]).sort())
      .toEqual(checkedOnPaidHost.endpoints.map(endpoint => [endpoint.path, endpoint.method]).sort());
    // Checked today, yesterday and 5 days ago, with both methods and different prices
    const rows = await database.db.select().from(routedEndpoints).where(sql`status = 'checked'`);
    expect(new Set(rows.map(row => row.checkMethod))).toEqual(new Set(['GET', 'POST']));
    expect(new Set(rows.map(row => row.lastPrice)).size).toBeGreaterThan(8);
    expect(Math.max(...rows.map(row => Date.now() - row.checkedAt!.getTime()))).toBeGreaterThan(5 * 86_400_000);
    // No call count holds any of them
    const stats = (await read('/v1/stats')).body;
    expect((await read('/v1/calls?size=1')).body.total).toBe(await count('payments'));
    expect(stats.calls.all).toBeLessThanOrEqual(await count('payments'));
    expect(JSON.stringify((await read('/v1/stats/top?period=all')).body)).not.toContain('invoices.example.com');
  }, slow);

  it('--empty takes them away too, with their hosts', async () => {
    await emptyLocal({ postgres: database.postgres, config });

    expect(await count('routed_endpoints')).toBe(0);
    expect(await database.db.select().from(checkedHosts)).toEqual([]);
    // The API keeps the list 5 s
    await expect.poll(async () => (await read('/v1/services')).body.services, { timeout: 15_000, interval: 500 }).toEqual([]);
  }, slow);

  it('--checked-only seeds the checked services and no call', async () => {
    const summary = await seedLocal({ postgres: database.postgres, config, checkedOnly: true });

    expect(summary).toMatchObject({ calls: 0, accounts: 0, topups: 0, checkedServices: 6 });
    for (const table of ['payments', 'accounts', 'topups', 'ledger_transactions'])
      expect(await count(table), table).toBe(0);
    // The API keeps the list 5 s
    await expect.poll(async () => (await read('/v1/services?size=49')).body.services.map((item: { host: string }) => item.host).sort(), { timeout: 15_000, interval: 500 })
      .toEqual(checkedServices.map(service => service.host).sort());
    const services = (await read('/v1/services?size=49')).body;
    expect(new Set(services.services.map((item: { status: string }) => item.status))).toEqual(new Set(['checked']));
    expect((await read('/v1/calls')).body.total).toBe(0);
    expect((await read('/v1/stats')).body.calls).toEqual({ today: 0, '7d': 0, '30d': 0, all: 0 });
    await emptyLocal({ postgres: database.postgres, config });
    await expect.poll(async () => (await read('/v1/services')).body.services, { timeout: 15_000, interval: 500 }).toEqual([]);
  }, slow);
});

describe('the paid service and the paid endpoint with no call in 30 days', () => {
  it('are paid, in the list and on their pages with zero numbers, beside a busy service whose other endpoints have calls', async () => {
    await seedLocal({ postgres: database.postgres, config, calls: 300 });

    // Only calls 40 days old: the service is in the list, paid, with zero numbers for the 30 days
    // The API keeps the services it read for a few seconds, whatever the query: the read before the seed may still be held
    const readListed = async () => (await read(`/v1/services?q=${quietService.host}`)).body.services as { host: string; status: string; calls: number; buyers: number; volume: string; paidEndpoints: number; trend: number[] }[];
    await expect.poll(async () => (await readListed()).map(item => item.host), { timeout: 15_000, interval: 500 }).toEqual([quietService.host]);
    const listed = await readListed();
    expect(listed).toEqual([expect.objectContaining({ host: quietService.host, status: 'paid', calls: 0, buyers: 0, volume: '0', paidEndpoints: quietService.endpoints.length })]);
    expect(listed[0]!.trend.every(value => value === 0)).toBe(true);
    // Each page is held by its own key too: wait for the seeded rows, not for time
    await expect.poll(async () => (await read(`/v1/services/${quietService.host}`)).status, { timeout: 15_000, interval: 500 }).toBe(200);
    const page = (await read(`/v1/services/${quietService.host}`)).body;
    expect(page).toMatchObject({ status: 'paid', stats: { calls: 0, buyers: 0 }, paidEndpoints: quietService.endpoints.length });
    expect(page.endpoints.map((endpoint: { path: string }) => endpoint.path).sort()).toEqual(quietService.endpoints.map(endpoint => endpoint.path).sort());
    for (const endpoint of page.endpoints)
      expect(endpoint).toMatchObject({ status: 'paid', calls: 0, volume: '0', link: expect.stringContaining(quietService.host) });
    // Its calls are there, in all time
    await expect.poll(async () => (await read(`/v1/services/${quietService.host}?period=all`)).body.stats?.calls, { timeout: 15_000, interval: 500 }).toBe(quietService.endpoints.length);

    // A busy service with one paid endpoint that has no call in the 30 days: listed with zeros after those with calls
    await expect.poll(async () => ((await read(`/v1/services/${quietEndpoint.host}`)).body.endpoints ?? []).map((endpoint: { path: string }) => endpoint.path), { timeout: 15_000, interval: 500 })
      .toContain(quietEndpoint.endpoint.path);
    const busy = (await read(`/v1/services/${quietEndpoint.host}`)).body;
    const paths = busy.endpoints.map((endpoint: { path: string }) => endpoint.path);
    const quiet = busy.endpoints.find((endpoint: { path: string }) => endpoint.path === quietEndpoint.endpoint.path);
    expect(busy.stats.calls).toBeGreaterThan(0);
    expect(quiet).toMatchObject({ status: 'paid', calls: 0, buyers: 0, volume: '0', link: expect.stringContaining(quietEndpoint.endpoint.path) });
    expect(busy.endpoints.filter((endpoint: { status: string; calls: number }) => endpoint.status === 'paid' && endpoint.calls > 0).length).toBeGreaterThan(0);
    for (const endpoint of busy.endpoints.slice(0, paths.indexOf(quietEndpoint.endpoint.path)))
      expect(endpoint.calls > 0 || endpoint.path === quietEndpoint.endpoint.path).toBe(true);
    expect(await count(`routed_endpoints where host = '${quietService.host}' and status = 'paid'`)).toBe(quietService.endpoints.length);

    await emptyLocal({ postgres: database.postgres, config });
  }, slow);
});

describe('--empty', () => {
  it('leaves no row of a seeded host in the paid and checked hosts, and keeps those of a host the seed did not write', async () => {
    await seedLocal({ postgres: database.postgres, config, calls: 300 });
    // A developer's own paid host and checked host, on names the seed does not write
    const routing = createRoutingRepository({ db: database.db, clock: createFakeClock(new Date(Date.now() - 30_000)) });
    expect(await routing.registerEndpoint({ host: 'dev-paid.example.com', path: '/own', lastPrice: 900n })).toBe('created');
    expect(await routing.registerEndpoint({ host: 'dev-checked.example.com', path: '/own', lastPrice: 900n, checked: { method: 'GET', mayAddHost: true } })).toBe('created');
    const hostsOf = async (table: typeof paidHosts | typeof checkedHosts): Promise<string[]> => (await database.db.select({ host: table.host }).from(table)).map(row => row.host).sort();

    try {
      // Before: the seed's hosts are in both tables, the quiet service among them
      expect((await hostsOf(paidHosts)).filter(host => allSeededHosts.includes(host))).toContain(quietService.host);
      expect((await hostsOf(checkedHosts)).filter(host => allSeededHosts.includes(host)).length).toBeGreaterThan(5);

      await emptyLocal({ postgres: database.postgres, config });

      expect(await hostsOf(paidHosts)).toEqual(['dev-paid.example.com']);
      expect(await hostsOf(checkedHosts)).toEqual(['dev-checked.example.com']);
      expect((await database.db.select().from(routedEndpoints)).map(row => row.host).sort()).toEqual(['dev-checked.example.com', 'dev-paid.example.com']);
    }
    finally {
      // This test's own rows, by their exact hosts
      for (const host of ['dev-paid.example.com', 'dev-checked.example.com']) {
        await database.db.execute(sql`delete from routed_endpoints where host = ${host}`);
        await database.db.execute(sql`delete from checked_hosts where host = ${host}`);
        await database.db.execute(sql`delete from paid_hosts where host = ${host}`);
      }
    }
  }, slow);

  it('leaves a truly empty state, and keeps and counts the rows of a developer\'s own call', async () => {
    await seedLocal({ postgres: database.postgres, config, calls: 400 });
    await developerCall();
    await countPublicNumbers({ postgres: database.postgres, config });
    expect((await read('/v1/stats/live')).body.today.buyers).toBeGreaterThan(1);
    expect(await database.db.select().from(statsBuyers)).not.toHaveLength(1);

    await emptyLocal({ postgres: database.postgres, config });

    // The seed's rows are gone from every table it wrote
    for (const table of ['topups', 'accounts', 'api_keys', 'checked_hosts'])
      expect(await count(table), table).toBe(0);
    for (const table of ['payments', 'call_details', 'target_payments', 'signatures'])
      expect(await count(table), table).toBe(1);
    expect(await count('ledger_transactions')).toBe(1);
    expect(await count('routed_endpoints')).toBe(1);
    // The counted numbers say what remains
    expect(await database.db.select().from(statsBuyers)).toHaveLength(1);
    const stats = (await read('/v1/stats')).body;
    expect(stats.calls).toEqual({ today: 1, '7d': 1, '30d': 1, all: 1 });
    // The API keeps the live numbers a few seconds
    await expect.poll(async () => (await read('/v1/stats/live')).body.today, { timeout: 15_000, interval: 500 }).toMatchObject({ calls: 1, buyers: 1 });
    // The API keeps the list 5 s
    await expect.poll(async () => (await read('/v1/services')).body.services, { timeout: 15_000, interval: 500 }).toEqual([
      expect.objectContaining({ host: 'dev.example.com', calls: 1, status: 'paid' }),
    ]);
    expect((await read('/v1/calls')).body.total).toBe(1);
  }, slow);
});

describe('a scratch database', () => {
  it('is a new empty database next to the local one: migrated, named as a scratch one, and gone once dropped', async () => {
    const before = await count('payments');
    const scratch = await createScratchDatabase(database.url.expose());

    expect(isScratchName(scratch.name)).toBe(true);
    expect(scratch.url.expose()).toContain(scratch.name);
    const names = async () => (await database.db.execute<{ datname: string }>(sql`select datname from pg_database where datname = ${scratch.name}`)).rows;
    expect(await names()).toHaveLength(1);
    await scratch.drop();
    await scratch.drop();
    expect(await names()).toHaveLength(0);
    expect(await count('payments')).toBe(before);
    expect(isScratchName('anyfare')).toBe(false);
    expect(isScratchName('anyfare_test_abc_0123456789ab')).toBe(false);
  });
});
