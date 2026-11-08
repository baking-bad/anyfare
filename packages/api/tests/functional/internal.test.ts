import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, createServer, randomIdGenerator, Secret } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { auditLog } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, type FakeClock, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';
import { errorStatuses } from '../../src/errors.js';
import { registerInternalRoutes } from '../../src/internal/routes.js';

const internalSecret = 'internal-secret-0123456789abcdef-xyz';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let clock: FakeClock;
let server: ApiServer;
let url: string;
let internalUrl: string;
let counter = 0;

beforeAll(async () => {
  [database, redis, config] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from('rateLimits:\n  signup: { requests: 1000, windowSeconds: 60 }\n').toString('base64') } }),
  ]);
  clock = createFakeClock();
  server = createApp({
    config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, internalSecret: Secret.from(internalSecret),
  });
  const { port, internalPort } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });
  url = `http://127.0.0.1:${port}`;
  internalUrl = `http://127.0.0.1:${internalPort!}`;
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const signup = async (): Promise<{ readonly id: string; readonly masterKey: string }> =>
  await (await fetch(`${url}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };

const balanceOf = async (masterKey: string): Promise<unknown> => {
  const response = await fetch(`${url}/v1/balance`, { headers: { authorization: `Bearer ${masterKey}` } });

  return response.json();
};

const credit = async (base: string, accountId: string, body: unknown, headers: Record<string, string> = { 'x-internal-secret': internalSecret }) => {
  const response = await fetch(`${base}/internal/v1/accounts/${accountId}/credits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
};

const nextReference = () => {
  counter += 1;

  return `ticket-${counter}`;
};

describe('POST /internal/v1/accounts/{id}/credits', () => {
  it('credits an account once per reference, writes the audit log for every call, and answers a replay with the first credit', async () => {
    const owner = await signup();
    const reference = nextReference();
    const creditedAt = clock.now().toISOString();

    const first = await credit(internalUrl, owner.id, { amount: '10.00', reference }, {
      'x-internal-secret': internalSecret, 'x-internal-caller': 'operator', 'x-request-id': `credit-${reference}`,
    });
    // The audit entries get different times, so their order is the calls'
    clock.advance(1_000);
    const replay = await credit(internalUrl, owner.id, { amount: '10.00', reference });

    expect(first).toMatchObject({
      status: 201,
      body: { transactionId: expect.any(String), accountId: owner.id, amount: '10', reference, replayed: false, createdAt: creditedAt },
    });
    expect(replay).toMatchObject({ status: 200, body: { transactionId: first.body['transactionId'], replayed: true } });
    expect(await balanceOf(owner.masterKey)).toEqual({ available: '10', held: '0' });
    const entries = await database.db.select().from(auditLog)
      .where(and(eq(auditLog.subjectId, owner.id), eq(auditLog.action, 'ledger.credit')))
      .orderBy(auditLog.occurredAt, auditLog.id);
    expect(entries).toEqual([
      expect.objectContaining({
        actorKind: 'internal_api',
        actorId: 'operator',
        requestId: `credit-${reference}`,
        details: { amount: '10000000', reference, transactionId: first.body['transactionId'], replayed: false },
      }),
      expect.objectContaining({ actorKind: 'internal_api', actorId: 'unknown', details: expect.objectContaining({ replayed: true }) }),
    ]);
  });

  it('answers a reference reused for another amount with 409 idempotency_conflict, and moves nothing', async () => {
    const owner = await signup();
    const reference = nextReference();
    await credit(internalUrl, owner.id, { amount: '1', reference });

    const conflict = await credit(internalUrl, owner.id, { amount: '2', reference });

    expect(conflict).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } });
    expect(await balanceOf(owner.masterKey)).toEqual({ available: '1', held: '0' });
  });

  it('answers a reference reused for another account with 409 idempotency_conflict, and moves nothing', async () => {
    const [owner, other] = [await signup(), await signup()];
    const reference = nextReference();
    await credit(internalUrl, owner.id, { amount: '1', reference });

    const conflict = await credit(internalUrl, other.id, { amount: '1', reference });

    expect(conflict).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } });
    expect(await balanceOf(other.masterKey)).toEqual({ available: '0', held: '0' });
  });

  it.each([
    ['no fields', {}],
    ['no reference', { amount: '1' }],
    ['no amount', { reference: 'r-1' }],
    ['an amount with 7 decimals', { amount: '0.0000001', reference: 'r-3' }],
    ['a negative amount', { amount: '-1', reference: 'r-4' }],
    ['a zero amount', { amount: '0', reference: 'r-5' }],
    ['an amount above the most one credit may be', { amount: '10000.000001', reference: 'r-5b' }],
    ['an amount that is a number', { amount: 10, reference: 'r' }],
    ['a reference that is a number', { amount: '1', reference: 12345678901234567890 }],
    ['an amount too large to hold', { amount: '99999999999999999999', reference: 'r-6' }],
    ['a reference with a space', { amount: '1', reference: 'a b' }],
    ['an empty reference', { amount: '1', reference: '' }],
    ['a reference over 128 characters', { amount: '1', reference: 'r'.repeat(129) }],
  ])('refuses %s with 400 invalid_request, and moves nothing', async (_case, body) => {
    const owner = await signup();

    const response = await credit(internalUrl, owner.id, body);

    expect(response).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await balanceOf(owner.masterKey)).toEqual({ available: '0', held: '0' });
  });

  it('credits exactly the most one credit may be', async () => {
    const owner = await signup();

    const response = await credit(internalUrl, owner.id, { amount: '10000', reference: nextReference() });

    expect(response.status).toBe(201);
    expect(await balanceOf(owner.masterKey)).toEqual({ available: '10000', held: '0' });
  });

  it('moves the money once when 8 calls race with one reference', async () => {
    const owner = await signup();
    const reference = nextReference();

    const responses = await Promise.all(Array.from({ length: 8 }, () => credit(internalUrl, owner.id, { amount: '3', reference })));

    const statuses = responses.map(response => response.status);
    expect(statuses.filter(status => status === 201)).toHaveLength(1);
    expect(statuses.every(status => [200, 201, 409].includes(status))).toBe(true);
    expect(await balanceOf(owner.masterKey)).toEqual({ available: '3', held: '0' });
  });

  it('rolls the credit back with its audit entry when the audit log fails', async () => {
    const owner = await signup();
    const failing = createServer({ logger: createLogger({ level: 'silent' }), errorStatuses });
    registerInternalRoutes(failing.app, {
      db: database.db,
      clock,
      ids: randomIdGenerator,
      secret: Secret.from(internalSecret),
      auditLog: () => ({ append: async () => { throw new Error('the audit log is down'); } }),
    });
    const reference = nextReference();

    const response = await failing.app.inject({
      method: 'POST',
      url: `/internal/v1/accounts/${owner.id}/credits`,
      headers: { 'x-internal-secret': internalSecret },
      payload: { amount: '5', reference },
    });
    await failing.close();

    expect(response.statusCode).toBe(500);
    expect(await balanceOf(owner.masterKey)).toEqual({ available: '0', held: '0' });
    const retried = await credit(internalUrl, owner.id, { amount: '1', reference });
    expect(retried).toMatchObject({ status: 201, body: { replayed: false } });
  });

  it('answers an unknown account with 404 not_found', async () => {
    const response = await credit(internalUrl, 'acc_unknown', { amount: '1', reference: nextReference() });

    expect(response).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });
});

describe('the internal listener', () => {
  it.each([
    ['without the shared secret', {}],
    ['with the wrong shared secret', { 'x-internal-secret': `${internalSecret}-wrong` }],
    ['with a secret that only shares its start', { 'x-internal-secret': internalSecret.slice(0, 10) }],
    ['with an empty secret', { 'x-internal-secret': '' }],
  ])('answers a call %s with 401 unauthorized and WWW-Authenticate, and moves nothing', async (_case, headers) => {
    const owner = await signup();

    const response = await credit(internalUrl, owner.id, { amount: '1', reference: nextReference() }, headers);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(response.body).toEqual({ error: { code: 'unauthorized', message: 'The internal API needs the x-internal-secret header' } });
    expect(await balanceOf(owner.masterKey)).toEqual({ available: '0', held: '0' });
  });

  it('never answers on the public port, even with the shared secret', async () => {
    const owner = await signup();

    const response = await credit(url, owner.id, { amount: '1', reference: nextReference() });

    expect(response).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    expect(await balanceOf(owner.masterKey)).toEqual({ available: '0', held: '0' });
  });

  it('refuses every call when the API has no shared secret configured', async () => {
    const bare = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock });
    const { internalPort } = await bare.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });
    try {
      const owner = await signup();

      const response = await credit(`http://127.0.0.1:${internalPort!}`, owner.id, { amount: '1', reference: nextReference() });

      expect(response.status).toBe(401);
      expect(await balanceOf(owner.masterKey)).toEqual({ available: '0', held: '0' });
    }
    finally {
      await bare.close();
    }
  });

  it('answers an unknown account without the secret with 401, not 404', async () => {
    const response = await credit(internalUrl, 'acc_unknown', { amount: '1', reference: nextReference() }, {});

    expect(response.status).toBe(401);
  });

  it('does not listen unless it is given a port', async () => {
    const quiet = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock });
    try {
      const addresses = await quiet.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

      expect(addresses.internalPort).toBeUndefined();
    }
    finally {
      await quiet.close();
    }
  });
});
