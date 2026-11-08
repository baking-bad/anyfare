import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator } from '@anyfare/common';
import { loadPlatformConfig } from '@anyfare/core';
import { createLedger, type Ledger } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, type FakeClock, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp } from '../../src/app.js';

let database: TestDatabase;
let redis: TestRedis;
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let ledger: Ledger;
let url: string;
let counter = 0;

beforeAll(async () => {
  let config;
  [database, redis, config] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from('rateLimits:\n  signup: { requests: 1000, windowSeconds: 60 }\n').toString('base64') } }),
  ]);
  clock = createFakeClock();
  server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock });
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  url = `http://127.0.0.1:${port}`;
  ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const signup = async (): Promise<{ readonly id: string; readonly masterKey: string }> =>
  await (await fetch(`${url}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };

const get = async (masterKey: string, path: string) => {
  const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${masterKey}` } });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const credit = async (accountId: string, amount: bigint): Promise<void> => {
  counter += 1;
  await ledger.credit({ accountId, amount, reference: `balance-credit-${counter}` });
};

const paymentKey = async (masterKey: string): Promise<string> => {
  const response = await fetch(`${url}/v1/keys`, { method: 'POST', headers: { authorization: `Bearer ${masterKey}` } });

  return (await response.json() as { id: string }).id;
};

const hold = async (accountId: string, keyId: string, amount: bigint): Promise<string> => {
  counter += 1;
  const result = await ledger.hold({
    payment: {
      id: `pay_balance_${counter}`, requestId: undefined, rail: 'credits', buyerAccountId: accountId, keyId,
      targetHost: 'api.example.test', targetPath: '/v1/data', network: undefined, asset: undefined, atomicAmount: undefined, amount,
    },
    dailyBudget: 5_000_000n,
    allowance: undefined,
  });
  if (!result.ok)
    throw new Error(result.refusal);

  return result.payment.id;
};

describe('GET /v1/balance', () => {
  it('starts at zero', async () => {
    const owner = await signup();

    expect((await get(owner.masterKey, '/v1/balance')).body).toEqual({ available: '0', held: '0' });
  });

  it('shows the balance after a credit, and after a hold', async () => {
    const owner = await signup();
    await credit(owner.id, 2_500_000n);
    expect((await get(owner.masterKey, '/v1/balance')).body).toEqual({ available: '2.5', held: '0' });
    const keyId = await paymentKey(owner.masterKey);

    await hold(owner.id, keyId, 500_000n);

    expect((await get(owner.masterKey, '/v1/balance')).body).toEqual({ available: '2', held: '0.5' });
  });
});

describe('GET /v1/payments', () => {
  it('pages the caller\'s payments, newest first, and never shows another buyer\'s', async () => {
    const [owner, other] = [await signup(), await signup()];
    await credit(owner.id, 1_000_000n);
    await credit(other.id, 1_000_000n);
    const [keyId, otherKey] = [await paymentKey(owner.masterKey), await paymentKey(other.masterKey)];
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      clock.advance(1_000);
      ids.push(await hold(owner.id, keyId, 1_000n));
    }
    await hold(other.id, otherKey, 1_000n);

    const first = await get(owner.masterKey, '/v1/payments?limit=2');
    const second = await get(owner.masterKey, `/v1/payments?limit=2&after=${first.body['next'] as string}`);

    expect((first.body['payments'] as { id: string }[]).map(item => item.id)).toEqual([ids[2], ids[1]]);
    expect(second.body).toEqual({
      payments: [{
        id: ids[0],
        requestId: null,
        rail: 'credits',
        targetHost: 'api.example.test',
        targetPath: '/v1/data',
        amount: '0.001',
        status: 'held',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      }],
      next: null,
    });
  });

  it.each([
    ['a limit of 0', 'limit=0'],
    ['a limit over 100', 'limit=101'],
  ])('refuses %s with 400', async (_case, query) => {
    const owner = await signup();

    const response = await get(owner.masterKey, `/v1/payments?${query}`);

    expect(response.status).toBe(400);
  });

  it('needs the master key', async () => {
    const response = await fetch(`${url}/v1/payments`);

    expect(response.status).toBe(401);
  });
});
