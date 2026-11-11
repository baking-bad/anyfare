import { setTimeout as sleep } from 'node:timers/promises';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret } from '@anyfare/common';
import { hashApiKey, loadPlatformConfig } from '@anyfare/core';
import { createLedger, createPaymentRepository, payments, type Ledger } from '@anyfare/db';
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
  clock = createFakeClock('2026-11-12T09:00:00.000Z');
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

const paymentKey = async (masterKey: string): Promise<string> => (await newKey(masterKey)).id;

// A payment key: its ID, and the key itself
const newKey = async (masterKey: string): Promise<{ readonly id: string; readonly key: string }> => {
  const response = await fetch(`${url}/v1/keys`, { method: 'POST', headers: { authorization: `Bearer ${masterKey}` } });

  return await response.json() as { id: string; key: string };
};

const hold = async (accountId: string, keyId: string, amount: bigint, targetHost = 'api.example.test'): Promise<string> => {
  counter += 1;
  const result = await ledger.hold({
    payment: {
      id: `pay_balance_${counter}`, requestId: undefined, rail: 'credits', buyerAccountId: accountId, keyId,
      targetHost, targetPath: '/v1/data', network: undefined, asset: undefined, atomicAmount: undefined, amount,
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
        keyId,
        targetHost: 'api.example.test',
        targetPath: '/v1/data',
        amount: '0.001',
        status: 'held',
        state: 'pending',
        upstreamStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      }],
      next: null,
    });
  });

  it('shows the key that paid, what the API answered, and the state: a paid Credits call, a failed one, and one in flight', async () => {
    const owner = await signup();
    await credit(owner.id, 1_000_000n);
    const keyId = await paymentKey(owner.masterKey);
    const recorder = createPaymentRepository({ db: database.db, clock });
    clock.advance(1_000);
    const paid = await hold(owner.id, keyId, 10_000n);
    await recorder.recordDecision({ paymentId: paid, decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 120 });
    // Charged: as a capture leaves it, without the API's leg a capture books
    await database.db.update(payments).set({ status: 'captured', fee: 0n }).where(eq(payments.id, paid));
    clock.advance(1_000);
    const failed = await hold(owner.id, keyId, 20_000n);
    await recorder.recordDecision({ paymentId: failed, decision: 'not_billable', upstreamStatus: 500, upstreamLatencyMs: 80 });
    await ledger.release({ paymentId: failed });
    clock.advance(1_000);
    const inFlight = await hold(owner.id, keyId, 30_000n);

    const listed = await get(owner.masterKey, '/v1/payments');

    const fields = (id: string, amount: string, status: string, state: string, upstreamStatus: number | null) => ({
      id, requestId: null, rail: 'credits', keyId, targetHost: 'api.example.test', targetPath: '/v1/data', amount, status, state, upstreamStatus,
      createdAt: expect.any(String), updatedAt: expect.any(String),
    });
    expect(listed).toEqual({
      status: 200,
      body: {
        payments: [fields(inFlight, '0.03', 'held', 'pending', null), fields(failed, '0.02', 'released', 'free', 500), fields(paid, '0.01', 'captured', 'paid', 200)],
        next: null,
      },
    });
    // Each payment's fields, in the order the route sends them
    expect(Object.keys((listed.body['payments'] as object[])[0]!)).toEqual([
      'id', 'requestId', 'rail', 'keyId', 'targetHost', 'targetPath', 'amount', 'status', 'state', 'upstreamStatus', 'createdAt', 'updatedAt',
    ]);
  });

  it('shows a payment on a chain that names the account, with no key', async () => {
    const owner = await signup();
    await database.db.insert(payments).values({
      id: `pay_balance_chain_${owner.id}`, rail: 'x402', buyerAccountId: owner.id, keyId: null, targetHost: 'api.example.test', targetPath: '/v1/data',
      network: 'eip155:84532', asset: 'base-usdc', atomicAmount: 10_000n, amount: 10_000n, status: 'settled', upstreamStatus: 201, needsReview: false,
      createdAt: clock.now(), updatedAt: clock.now(),
    });

    const listed = await get(owner.masterKey, '/v1/payments');

    expect(listed.body['payments']).toEqual([expect.objectContaining({ rail: 'x402', keyId: null, status: 'settled', state: 'paid', upstreamStatus: 201 })]);
  });

  describe('narrowed by state, key and service', () => {
    let owner: { readonly id: string; readonly masterKey: string };
    let other: { readonly id: string; readonly masterKey: string };
    let otherKey: { readonly id: string; readonly key: string };
    let first: { readonly id: string; readonly key: string };
    let second: { readonly id: string; readonly key: string };
    // By what each payment is: its key, host and state
    const made: Record<string, string> = {};

    beforeAll(async () => {
      [owner, other] = [await signup(), await signup()];
      await credit(owner.id, 1_000_000n);
      await credit(other.id, 1_000_000n);
      [first, second, otherKey] = [await newKey(owner.masterKey), await newKey(owner.masterKey), await newKey(other.masterKey)];
      for (const [name, key, host, end] of [
        ['first-one-free', first, 'api.one.test', 'release'],
        ['first-two-pending', first, 'api.two.test', undefined],
        ['second-one-pending', second, 'api.one.test', undefined],
        ['second-two-free', second, 'api.two.test', 'release'],
        ['first-one-pending', first, 'api.one.test', undefined],
      ] as const) {
        clock.advance(1_000);
        made[name] = await hold(owner.id, key.id, 1_000n, host);
        if (end === 'release')
          await ledger.release({ paymentId: made[name]! });
      }
      // The other account's, on the same host, with its own key
      await hold(other.id, otherKey.id, 1_000n, 'api.one.test');
    });

    const idsOf = async (query: string, key = owner.masterKey): Promise<unknown> => {
      const response = await get(key, `/v1/payments?${query}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      return (response.body['payments'] as { id: string }[]).map(payment => Object.keys(made).find(name => made[name] === payment.id) ?? payment.id);
    };

    it('by each filter alone, newest first', async () => {
      expect(await idsOf('')).toEqual(['first-one-pending', 'second-two-free', 'second-one-pending', 'first-two-pending', 'first-one-free']);
      expect(await idsOf('state=free')).toEqual(['second-two-free', 'first-one-free']);
      expect(await idsOf('state=pending')).toEqual(['first-one-pending', 'second-one-pending', 'first-two-pending']);
      expect(await idsOf('state=paid')).toEqual([]);
      expect(await idsOf(`keyId=${first.id}`)).toEqual(['first-one-pending', 'first-two-pending', 'first-one-free']);
      expect(await idsOf(`keyId=${second.id}`)).toEqual(['second-two-free', 'second-one-pending']);
      expect(await idsOf('service=api.two.test')).toEqual(['second-two-free', 'first-two-pending']);
    });

    it('by filters together, each one matching', async () => {
      expect(await idsOf(`state=pending&keyId=${first.id}`)).toEqual(['first-one-pending', 'first-two-pending']);
      expect(await idsOf(`state=free&service=api.one.test`)).toEqual(['first-one-free']);
      expect(await idsOf(`state=pending&keyId=${first.id}&service=api.one.test`)).toEqual(['first-one-pending']);
      expect(await idsOf(`state=free&keyId=${second.id}&service=api.one.test`)).toEqual([]);
    });

    it('matches the service without case, and exactly: a part of a host is no host', async () => {
      expect(await idsOf('service=API.Two.TEST')).toEqual(['second-two-free', 'first-two-pending']);
      expect(await idsOf('service=api.two')).toEqual([]);
      expect(await idsOf('service=two.test')).toEqual([]);
    });

    it('finds nothing by another account\'s key, and never another account\'s payment', async () => {
      expect(await idsOf(`keyId=${otherKey.id}`)).toEqual([]);
      expect(await idsOf('keyId=key_unknown')).toEqual([]);
      const theirs = await get(other.masterKey, `/v1/payments?keyId=${first.id}`);
      expect(theirs.body).toEqual({ payments: [], next: null });
      expect(await idsOf('service=api.one.test', other.masterKey)).toHaveLength(1);
    });

    it('pages with the filters, and a cursor goes on from where its page stopped under other filters', async () => {
      const page = await get(owner.masterKey, `/v1/payments?state=pending&limit=2`);
      expect((page.body['payments'] as { id: string }[]).map(payment => payment.id)).toEqual([made['first-one-pending'], made['second-one-pending']]);
      const next = page.body['next'] as string;
      expect(await idsOf(`state=pending&limit=2&after=${next}`)).toEqual(['first-two-pending']);
      // The same cursor with no filter: everything older than the second pending one
      expect(await idsOf(`after=${next}`)).toEqual(['first-two-pending', 'first-one-free']);
      expect(await idsOf(`after=${next}&keyId=${second.id}`)).toEqual([]);
    });

    it('answers no other account\'s ID, no key, no key\'s hash, and the path of a call without its query', async () => {
      const everything = JSON.stringify([
        (await get(owner.masterKey, '/v1/payments')).body,
        (await get(owner.masterKey, `/v1/payments?keyId=${first.id}&state=pending&service=api.one.test`)).body,
      ]);

      for (const secret of [other.id, otherKey.id, owner.masterKey, first.key, second.key, hashApiKey(Secret.from(first.key)), hashApiKey(Secret.from(owner.masterKey))])
        expect(everything).not.toContain(secret);
      // The buyer's own account is never named either: the key says who paid
      expect(everything).not.toContain(owner.id);
      expect(everything).not.toMatch(/\?/);
    });
  });

  it('lists nothing for an account without payments', async () => {
    const owner = await signup();

    expect(await get(owner.masterKey, '/v1/payments?state=paid&limit=5')).toEqual({ status: 200, body: { payments: [], next: null } });
  });

  it.each([
    ['a limit of 0', 'limit=0'],
    ['a limit over 100', 'limit=101'],
    ['a parameter it doesn\'t take', 'status=paid'],
    ['a misspelt filter beside a good one', 'limit=5&key=key_x'],
    ['a state it doesn\'t know', 'state=charged'],
    ['two states', 'state=paid&state=free'],
    ['an empty state', 'state='],
    ['a key ID over 64 characters', `keyId=key_${'a'.repeat(61)}`],
    ['a key ID with a character no ID has', 'keyId=key%20x'],
    ['an empty key ID', 'keyId='],
    ['a service over 255 characters', `service=${'a'.repeat(251)}.test`],
    ['a service with a NUL', 'service=api%00.test'],
    ['an empty service', 'service='],
    ['a cursor over 512 characters', `after=${'a'.repeat(513)}`],
  ])('refuses %s with 400 invalid_request', async (_case, query) => {
    const owner = await signup();

    const response = await get(owner.masterKey, `/v1/payments?${query}`);

    expect(response).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });

  it('takes a key ID of 64 characters and a service of 255', async () => {
    const owner = await signup();

    expect((await get(owner.masterKey, `/v1/payments?keyId=key_${'a'.repeat(60)}&service=${'a'.repeat(250)}.test`)).body).toEqual({ payments: [], next: null });
  });

  it('answers 503 stats_unavailable when the read can\'t finish in time', async () => {
    const owner = await signup();

    let answer: Awaited<ReturnType<typeof get>> | string | undefined;
    await database.db.transaction(async tx => {
      await tx.execute(sql`lock table payments in access exclusive mode`);
      answer = await Promise.race([get(owner.masterKey, '/v1/payments?state=paid'), sleep(5_000).then(() => 'still waiting')]);
    });

    expect(answer).toEqual({ status: 503, body: { error: { code: 'stats_unavailable', message: 'The payments can\'t be read right now: try again shortly' } } });
    expect((await get(owner.masterKey, '/v1/payments?state=paid')).status).toBe(200);
  });

  it.each([
    ['a cursor that is garbage', 'not-a-cursor'],
    ['a cursor whose time is out of range', Buffer.from('-271821-04-20T00:00:00.000Z|pay_x').toString('base64url')],
    ['a cursor from before 2000', Buffer.from('1999-12-31T00:00:00.000Z|pay_x').toString('base64url')],
  ])('refuses %s with 400 invalid_request', async (_case, after) => {
    const owner = await signup();

    const response = await get(owner.masterKey, `/v1/payments?after=${after}`);

    expect(response).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });

  it('needs the master key', async () => {
    const response = await fetch(`${url}/v1/payments`);
    const owner = await signup();
    const { key } = await newKey(owner.masterKey);

    expect(response.status).toBe(401);
    expect(await get(key, '/v1/payments?state=paid')).toMatchObject({ status: 401, body: { error: { code: 'wrong_key_type' } } });
  });
});
