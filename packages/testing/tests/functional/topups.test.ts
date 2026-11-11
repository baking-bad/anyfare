import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '../../src/index.js';
import { defaultStackPorts, startLocalStack, type LocalStack } from '../../src/local/stack.js';

// A top-up on the local stack, moved through the fake 1Click's control the way the printed commands do it. The
// workers ask 1Click about an open top-up every 10 seconds.

let database: TestDatabase;
let redis: TestRedis;
let stack: LocalStack;
let master: string;

const freePorts = Object.fromEntries(Object.keys(defaultStackPorts).map(name => [name, 0]));
const json = async (url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
  const response = await fetch(url, init);
  const text = await response.text();

  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
};
const authorized = { get authorization() { return `Bearer ${master}`; } };

const makeTopup = async (): Promise<{ id: string; address: string }> => {
  const created = await json(`${stack.urls.api}/v1/topups`, {
    method: 'POST', headers: { ...authorized, 'content-type': 'application/json' }, body: JSON.stringify({ network: 'base', token: 'USDC', amount: '1' }),
  });
  expect(created.status).toBe(201);

  return { id: created.body.id, address: created.body.depositAddress };
};
const move = (address: string, status: string) => json(`${stack.urls.oneClick}/_test/status`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ depositAddress: address, status }),
});
const show = async (id: string) => (await json(`${stack.urls.api}/v1/topups/${id}`, { headers: authorized })).body;
const balance = async (): Promise<number> => Number((await json(`${stack.urls.api}/v1/balance`, { headers: authorized })).body.available);

// Until the workers' next polls show the status
const until = async (id: string, status: string): Promise<Record<string, any>> => {
  const stop = Date.now() + 40_000;
  let shown = await show(id);
  while (shown.status !== status && Date.now() < stop) {
    await new Promise(resolve => setTimeout(resolve, 500));
    shown = await show(id);
  }

  return shown;
};

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  stack = await startLocalStack({ databaseUrl: database.url.expose(), redisUrl: redis.url.expose(), redisPrefix: redis.prefix, ports: freePorts });
  master = (await json(`${stack.urls.api}/v1/accounts`, { method: 'POST' })).body.masterKey;
}, 60_000);

afterAll(async () => {
  await stack?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('a top-up moved by the 1Click control', () => {
  it('lists the quote, and is credited once moved to SUCCESS', async () => {
    const before = await balance();
    const { id, address } = await makeTopup();

    expect((await json(`${stack.urls.oneClick}/_test/quotes`)).body).toContainEqual({ depositAddress: address, status: 'PENDING_DEPOSIT' });
    expect((await show(id)).status).toBe('waiting');
    expect(await move(address, 'PROCESSING')).toEqual({ status: 200, body: { depositAddress: address, status: 'PROCESSING' } });
    expect((await until(id, 'processing')).status).toBe('processing');
    await move(address, 'SUCCESS');
    const credited = await until(id, 'credited');

    expect(credited).toMatchObject({ status: 'credited', credited: '0.99938' });
    expect(await balance()).toBeCloseTo(before + 0.99938, 5);
  }, 90_000);

  it('is refunded, and credits nothing, once moved to REFUNDED', async () => {
    const before = await balance();
    const { id, address } = await makeTopup();

    await move(address, 'REFUNDED');
    const refunded = await until(id, 'refunded');

    expect(refunded).toMatchObject({ status: 'refunded', credited: null });
    expect(await balance()).toBe(before);
  }, 60_000);

  it('answers 404 for an address the fake does not know', async () => {
    expect((await move('0x0000000000000000000000000000000000000001', 'SUCCESS')).status).toBe(404);
  });
});
