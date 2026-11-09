import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp as createApi, type ApiServer } from '@anyfare/api';
import { createLogger } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import {
  createFakeClock, createTestDatabase, createTestRedis, startFakeOneClick, type FakeClock, type FakeOneClick, type TestDatabase, type TestRedis,
} from '@anyfare/testing';
import { createOneClickClient } from '@anyfare/topups';

import { createApp, type WorkersServer } from '../../src/app.js';

// The whole top-up: the Platform API makes the deposit address, 1Click swaps what arrives, and the
// workers' status job adds it to the balance. Both apps on one database, against the fake 1Click.

const noon = '2026-11-09T12:00:00.000Z';
const silent = createLogger({ level: 'silent' });

let database: TestDatabase;
let redis: TestRedis;
let oneClick: FakeOneClick;
let clock: FakeClock;
let config: PlatformConfig;
let api: ApiServer;
let apiUrl: string;
let workers: WorkersServer;
const workerLines: Record<string, unknown>[] = [];

beforeAll(async () => {
  clock = createFakeClock(noon);
  [database, redis, oneClick] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeOneClick({ now: clock.now })]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({ topups: { enabled: true, url: oneClick.url, timeoutMs: 2_000 } })).toString('base64'),
    },
  });
  api = createApi({ config, logger: silent, postgres: database.postgres, redis, clock });
  const { port } = await api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  apiUrl = `http://127.0.0.1:${port}`;
  // Runs its jobs only when a test asks: it never listens, so nothing is scheduled
  workers = createApp({
    config,
    logger: createLogger({}, { write: (line: string) => workerLines.push(JSON.parse(line) as Record<string, unknown>) }),
    postgres: database.postgres,
    clock,
    oneClick: createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 }),
  });
});

afterAll(async () => {
  await api?.close();
  await oneClick?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const call = async (method: string, path: string, { key, body }: { key?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe('a top-up from end to end', () => {
  it('adds 1 USDC sent on Base to the balance once 1Click swapped it, and a second run adds nothing', async () => {
    const signedUp = await call('POST', '/v1/accounts');
    expect(signedUp.status).toBe(201);
    const { id: accountId, masterKey } = signedUp.body as { id: string; masterKey: string };

    const created = await call('POST', '/v1/topups', { key: masterKey, body: { network: 'base', token: 'USDC', amount: '1' } });
    expect(created).toMatchObject({ status: 201, body: { status: 'waiting', estimatedCredits: '0.99938', credited: null, transaction: null } });
    const { id, depositAddress } = created.body as { id: string; depositAddress: string };

    // The person sends the USDC; 1Click swaps it and delivers USDC on NEAR to the treasury account
    oneClick.setStatus(depositAddress, 'SUCCESS');
    const delivery = (await createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 }).status({ depositAddress })).swapDetails.destinationChainTxHashes[0]!.hash;
    clock.advance(10_000);

    expect(await workers.scheduler.runNow('topup_status')).toBe('success');

    const credited = await call('GET', `/v1/topups/${id}`, { key: masterKey });
    expect(credited).toMatchObject({
      status: 200,
      body: { id, status: 'credited', message: 'Added to your balance', deposited: '1', credited: '0.99938', transaction: delivery, refunded: null },
    });
    expect(await call('GET', '/v1/balance', { key: masterKey })).toEqual({ status: 200, body: { available: '0.99938', held: '0' } });
    expect(workerLines.filter(line => line['msg'] === 'A top-up was credited')).toEqual([expect.objectContaining({ topupId: id, accountId, amount: '0.99938' })]);
    expect(workerLines.find(line => line['msg'] === 'A job ran' && line['job'] === 'topup_status')).toMatchObject({
      level: 30, counts: { polled: 1, credited: 1, review: 0, errors: 0 },
    });

    clock.advance(60_000);
    expect(await workers.scheduler.runNow('topup_status')).toBe('success');

    expect(await call('GET', `/v1/topups/${id}`, { key: masterKey })).toEqual(credited);
    expect(await call('GET', '/v1/balance', { key: masterKey })).toEqual({ status: 200, body: { available: '0.99938', held: '0' } });
    expect(workerLines.filter(line => line['msg'] === 'A top-up was credited')).toHaveLength(1);
  });

  it('still credits an open top-up after top-ups are switched off', async () => {
    const { masterKey } = (await call('POST', '/v1/accounts')).body as { masterKey: string };
    const created = await call('POST', '/v1/topups', { key: masterKey, body: { network: 'base', token: 'USDC', amount: '1' } });
    const { id, depositAddress } = created.body as { id: string; depositAddress: string };
    // The operator switches new top-ups off; the workers restart with that config
    const off = { ...config, topups: { ...config.topups, enabled: false } };
    const restarted = createApp({ config: off, logger: silent, postgres: database.postgres, clock, oneClick: createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 }) });
    oneClick.setStatus(depositAddress, 'SUCCESS');
    clock.advance(10_000);

    expect(restarted.jobs).toContain('topup_status');
    expect(await restarted.scheduler.runNow('topup_status')).toBe('success');

    expect(await call('GET', `/v1/topups/${id}`, { key: masterKey })).toMatchObject({ status: 200, body: { status: 'credited', credited: '0.99938' } });
    expect(await call('GET', '/v1/balance', { key: masterKey })).toEqual({ status: 200, body: { available: '0.99938', held: '0' } });
  });
});
