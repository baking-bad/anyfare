import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '../../src/index.js';
import { defaultStackPorts, startLocalStack, type LocalStack } from '../../src/local/stack.js';

// The local stack on free ports, driven over HTTP the way its printed commands are

let database: TestDatabase;
let redis: TestRedis;
let stack: LocalStack;
let master: string;
let key: string;

const freePorts = Object.fromEntries(Object.keys(defaultStackPorts).map(name => [name, 0]));
const json = async (url: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: any }> => {
  const response = await fetch(url, init);
  const text = await response.text();

  return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
};
const check = (target: string) => json(`${stack.urls.pay}/_/check?url=${encodeURIComponent(target)}`);

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  stack = await startLocalStack({ databaseUrl: database.url.expose(), redisUrl: redis.url.expose(), redisPrefix: redis.prefix, ports: freePorts });
}, 60_000);

afterAll(async () => {
  await stack?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('the local stack', () => {
  it('opens an account with free Credits, and a payment key', async () => {
    const account = await json(`${stack.urls.api}/v1/accounts`, { method: 'POST' });
    master = account.body.masterKey;
    const created = await json(`${stack.urls.api}/v1/keys`, { method: 'POST', headers: { authorization: `Bearer ${master}` } });
    key = created.body.key;

    expect(account.status).toBe(201);
    expect(account.body.freeCredits).toBe('0.5');
    expect(master).toMatch(/^afm_test_/);
    expect(created.status).toBe(201);
    expect(key).toMatch(/^af_test_/);
  });

  it.each([
    ['/base', 'x402', 'base-usdc', 'eip155:84532'],
    ['/near', 'x402', 'near-usdc', 'near:testnet'],
    ['/tempo', 'mpp', 'tempo-pathusd', 'eip155:42431'],
  ])('checks %s: payable, with a price and a quote', async (path, protocol, asset, network) => {
    const checked = await check(`${stack.urls.paidApi}${path}`);

    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({
      payable: true, protocol, price: { amount: '0.001', currency: 'USD', asset, network }, quote: { amount: '0.0011', fee: '0.0001', currency: 'USD' },
    });
    expect(checked.body.link).toBe(`${stack.urls.pay}/${stack.paidApiHost}${path}`);
  });

  it.each([
    ['an endpoint that asks for no payment', () => `${stack.urls.paidApi}/free`, 'not_payable'],
    ['an endpoint that asks only for a payment we do not make', () => `${stack.urls.paidApi}/unpayable`, 'unsupported_payment'],
    ['a dead port', () => 'https://fake-api.test:1/base', 'upstream_unavailable'],
    ['a private address', () => 'https://10.0.0.5/prices', 'host_not_allowed'],
  ])('refuses %s, with its reason', async (_name, target, reason) => {
    const checked = await check(target());

    expect(checked.body).toMatchObject({ payable: false, reason });
    expect(typeof checked.body.message).toBe('string');
  });

  it.each([
    ['/base', 'base'],
    ['/near', 'near'],
    ['/tempo', 'tempo'],
  ])('pays %s for a buyer with a key: 200, and the call is public, with a receipt', async (path, apiPaidWith) => {
    const response = await fetch(`${stack.urls.pay}/${stack.paidApiHost}${path}`, { headers: { authorization: `Bearer ${key}` } });
    const receipt = /^id="(pay_[^"]+)"/.exec(response.headers.get('anyfare-receipt') ?? '')?.[1];

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path });
    expect(receipt).toBeDefined();
    // In the public list within a second of the answer
    await expect.poll(async () => (await json(`${stack.urls.api}/v1/calls?size=10`)).body.calls.some((call: { id: string }) => call.id === receipt), { timeout: 1_000, interval: 100 })
      .toBe(true);
    const found = await json(`${stack.urls.api}/v1/calls/${receipt}`);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      id: receipt, status: 'paid', service: stack.paidApiHost, path, buyer: { paidWith: 'credits' }, api: { paidWith: apiPaidWith },
    });
    expect(found.body.steps.map((step: { step: string }) => step.step)).toEqual(expect.arrayContaining(['authorized', 'api_signed', 'settled']));
  });

  it('charges the account for the three calls, and the free Credits cover them', async () => {
    const calls = (await json(`${stack.urls.api}/v1/calls?size=10`)).body;

    expect(calls.total).toBe(3);
    expect(new Set(calls.calls.map((call: { paidWith: string }) => call.paidWith))).toEqual(new Set(['credits']));
  });

  it('stops everything when closed: the ports answer no more', async () => {
    await stack.close();

    await expect(fetch(`${stack.urls.api}/_/health`)).rejects.toThrow();
    await expect(fetch(`${stack.urls.pay}/_/health`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${stack.ports.workers}/_/health`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${stack.ports.signer}/_/health`)).rejects.toThrow();
    await expect(fetch(stack.urls.facilitator)).rejects.toThrow();
  });
});
