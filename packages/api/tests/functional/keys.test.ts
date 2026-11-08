import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger, randomIdGenerator, Secret } from '@anyfare/common';
import { hashApiKey, loadPlatformConfig, type InvalidationEvent, type PlatformConfig } from '@anyfare/core';
import { auditLog, createKeyStore, createLedger, createRedisInvalidationBus, type RedisInvalidationBus } from '@anyfare/db';
import {
  createFakeClock, createTestDatabase, createTestRedis, fixtureTime, type FakeClock, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp } from '../../src/app.js';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let bus: RedisInvalidationBus;
let url: string;
const events: InvalidationEvent[] = [];
const logs: string[] = [];

beforeAll(async () => {
  [database, redis, config] = await Promise.all([
    createTestDatabase(),
    createTestRedis(),
    loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from('rateLimits:\n  signup: { requests: 1000, windowSeconds: 60 }\n').toString('base64') } }),
  ]);
  clock = createFakeClock();
  const logger = createLogger({}, { write: (line: string) => logs.push(line) });
  server = createApp({ config, logger, postgres: database.postgres, redis, clock });
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  url = `http://127.0.0.1:${port}`;
  bus = createRedisInvalidationBus({ redis, logger: createLogger({ level: 'silent' }) });
  await bus.subscribe(event => {
    events.push(event);
  });
});

afterAll(async () => {
  await server?.close();
  await bus?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const signup = async (): Promise<{ readonly id: string; readonly masterKey: string }> =>
  await (await fetch(`${url}/v1/accounts`, { method: 'POST' })).json() as { id: string; masterKey: string };

const call = async (masterKey: string, method: string, path: string, body?: unknown, requestId?: string) => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${masterKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();

  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
};

const keyEvents = (id: string) => events.filter(event => event.kind === 'key' && event.id === id);
const auditFor = async (keyId: string) => database.db.select().from(auditLog).where(eq(auditLog.subjectId, keyId)).orderBy(auditLog.occurredAt, auditLog.id);

describe('POST /v1/keys', () => {
  it('creates a payment key with its limits, returns it once, and publishes and audits the creation without the key', async () => {
    const owner = await signup();
    const expiresAt = fixtureTime(2, 31, 0, 0, 0, 0);

    const created = await call(owner.masterKey, 'POST', '/v1/keys', {
      label: 'n8n', allowance: '20.00', dailyBudget: '5.00', maxPrice: '0.05', expiresAt,
    }, 'create-key-1');

    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(created.body).toEqual({
      id: expect.stringMatching(/^key_/),
      key: expect.stringMatching(/^af_test_[0-9A-Za-z]{43}$/),
      label: 'n8n',
      allowance: '20',
      dailyBudget: '5',
      maxPrice: '0.05',
      expiresAt,
      createdAt: clock.now().toISOString(),
      revokedAt: null,
      spent: { today: '0', total: '0' },
      remaining: { allowance: '20', dailyBudget: '5' },
    });
    const id = created.body['id'] as string;
    const key = created.body['key'] as string;
    // The proxy's key store finds it by hash, with its limits
    expect(await createKeyStore({ db: database.db }).findByHash(hashApiKey(Secret.from(key)))).toMatchObject({ id, accountId: owner.id, dailyBudget: 5_000_000n });
    await vi.waitFor(() => expect(keyEvents(id)).toHaveLength(1));
    const entries = await auditFor(id);
    expect(entries).toEqual([expect.objectContaining({ action: 'payment_key.create', actorId: owner.id, requestId: 'create-key-1' })]);
    expect(JSON.stringify(entries)).not.toContain(key);
    expect(JSON.stringify(entries)).not.toContain(key.slice(8));
    expect(logs.join('\n')).not.toContain(key);
  });

  it('gives a key without limits the daily budget from platform config, and nothing else', async () => {
    const owner = await signup();

    const created = await call(owner.masterKey, 'POST', '/v1/keys');

    expect(created.body).toMatchObject({ label: null, allowance: null, dailyBudget: '5', maxPrice: null, expiresAt: null, remaining: { allowance: null, dailyBudget: '5' } });
  });

  it.each([
    ['an amount that isn\'t a USD decimal', () => ({ dailyBudget: '5.0000001' })],
    ['a negative amount', () => ({ allowance: '-1' })],
    ['an amount too large to hold', () => ({ maxPrice: '99999999999999999999' })],
    ['an expiry in the past', () => ({ expiresAt: new Date(clock.now().getTime() - 60_000).toISOString() })],
    ['an expiry that isn\'t a date', () => ({ expiresAt: 'tomorrow' })],
    ['an expiry that passes the format but is no time', () => ({ expiresAt: '2030-12-31T23:59:60Z' })],
    ['a label over 60 characters', () => ({ label: 'x'.repeat(61) })],
    ['an amount that is a number', () => ({ dailyBudget: 3 })],
    ['an unknown field', () => ({ accountId: 'acc_other' })],
  ])('refuses %s with 400 invalid_request', async (_case, makeBody) => {
    const owner = await signup();

    const created = await call(owner.masterKey, 'POST', '/v1/keys', makeBody());

    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({ error: { code: 'invalid_request' } });
    expect((await call(owner.masterKey, 'GET', '/v1/keys')).body).toEqual({ keys: [] });
  });
});

describe('GET /v1/keys', () => {
  it('lists the account\'s payment keys newest first, without the key, with what\'s left of each limit', async () => {
    const owner = await signup();
    const first = await call(owner.masterKey, 'POST', '/v1/keys', { label: 'first', allowance: '1', dailyBudget: '0.5' });
    clock.advance(1_000);
    const second = await call(owner.masterKey, 'POST', '/v1/keys', { label: 'second' });
    const other = await signup();
    await call(other.masterKey, 'POST', '/v1/keys', { label: 'not mine' });
    // Spend through the ledger, as a paid call would
    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
    await ledger.credit({ accountId: owner.id, amount: 1_000_000n, reference: `credit-${owner.id}` });
    await ledger.hold({
      payment: {
        id: `pay_${owner.id}`, requestId: undefined, rail: 'credits', buyerAccountId: owner.id, keyId: first.body['id'] as string,
        targetHost: 'api.example.test', targetPath: '/v1/data', network: undefined, asset: undefined, atomicAmount: undefined, amount: 200_000n,
      },
      dailyBudget: 500_000n,
      allowance: 1_000_000n,
    });

    const listed = await call(owner.masterKey, 'GET', '/v1/keys');

    expect((listed.body['keys'] as { label: string }[]).map(key => key.label)).toEqual(['second', 'first']);
    expect((listed.body['keys'] as unknown[])[1]).toMatchObject({
      id: first.body['id'], spent: { today: '0.2', total: '0.2' }, remaining: { allowance: '0.8', dailyBudget: '0.3' },
    });
    expect(listed.text).not.toContain(first.body['key'] as string);
    expect(listed.text).not.toContain(second.body['key'] as string);
    expect(listed.text).not.toMatch(/key_hash|keyHash/);
  });
});

describe('PATCH /v1/keys/{id}', () => {
  it('changes limits and the label, clears one with null, and publishes and audits the change', async () => {
    const owner = await signup();
    const created = await call(owner.masterKey, 'POST', '/v1/keys', { label: 'n8n', allowance: '20', maxPrice: '0.05' });
    const id = created.body['id'] as string;
    await vi.waitFor(() => expect(keyEvents(id)).toHaveLength(1));
    clock.advance(1_000);

    const patched = await call(owner.masterKey, 'PATCH', `/v1/keys/${id}`, { label: 'cron', allowance: null, dailyBudget: '2.5' }, 'patch-key-1');

    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id, label: 'cron', allowance: null, dailyBudget: '2.5', maxPrice: '0.05', remaining: { allowance: null, dailyBudget: '2.5' } });
    await vi.waitFor(() => expect(keyEvents(id)).toHaveLength(2));
    const entries = await auditFor(id);
    expect(entries.map(entry => entry.action)).toEqual(['payment_key.create', 'payment_key.update']);
    expect(entries[1]).toMatchObject({ requestId: 'patch-key-1', details: { keyId: id, changes: { label: 'cron', allowance: null, dailyBudget: '2500000' } } });
  });

  it.each([
    ['an expiry in the past', () => ({ expiresAt: new Date(clock.now().getTime() - 60_000).toISOString() })],
    ['an expiry that passes the format but is no time', () => ({ expiresAt: '2030-12-31T23:59:60Z' })],
  ])('refuses %s with 400 invalid_request, changing nothing', async (_case, makeBody) => {
    const owner = await signup();
    const created = await call(owner.masterKey, 'POST', '/v1/keys', { label: 'mine' });

    const patched = await call(owner.masterKey, 'PATCH', `/v1/keys/${created.body['id'] as string}`, makeBody());

    expect(patched.status).toBe(400);
    expect(patched.body).toMatchObject({ error: { code: 'invalid_request' } });
    expect((await call(owner.masterKey, 'GET', '/v1/keys')).body).toMatchObject({ keys: [{ label: 'mine', expiresAt: null }] });
  });

  it.each([
    ['an unknown field', { label: 'x', accountId: 'acc_other' }],
    ['an amount that is a number', { dailyBudget: 3 }],
  ])('refuses %s with 400 invalid_request', async (_case, body) => {
    const owner = await signup();
    const created = await call(owner.masterKey, 'POST', '/v1/keys', { label: 'mine' });

    const patched = await call(owner.masterKey, 'PATCH', `/v1/keys/${created.body['id'] as string}`, body);

    expect(patched.status).toBe(400);
    expect(patched.body).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('answers another account\'s key, or an unknown one, with 404, changing nothing', async () => {
    const [owner, other] = [await signup(), await signup()];
    const created = await call(owner.masterKey, 'POST', '/v1/keys', { label: 'mine' });

    const foreign = await call(other.masterKey, 'PATCH', `/v1/keys/${created.body['id'] as string}`, { label: 'stolen' });
    const unknown = await call(owner.masterKey, 'PATCH', '/v1/keys/key_unknown', { label: 'x' });

    expect([foreign.status, unknown.status]).toEqual([404, 404]);
    expect(foreign.body).toMatchObject({ error: { code: 'not_found' } });
    expect((await call(owner.masterKey, 'GET', '/v1/keys')).body).toMatchObject({ keys: [{ label: 'mine' }] });
  });
});

describe('DELETE /v1/keys/{id}', () => {
  it('revokes the key at once: the key store no longer finds it, and the revocation is published and audited', async () => {
    const owner = await signup();
    const created = await call(owner.masterKey, 'POST', '/v1/keys');
    const id = created.body['id'] as string;
    const hash = hashApiKey(Secret.from(created.body['key'] as string));
    clock.advance(1_000);
    const revokedAt = clock.now().toISOString();

    const revoked = await call(owner.masterKey, 'DELETE', `/v1/keys/${id}`, undefined, 'revoke-key-1');
    const again = await call(owner.masterKey, 'DELETE', `/v1/keys/${id}`);

    expect(revoked).toMatchObject({ status: 200, body: { id, revokedAt } });
    expect(again.status).toBe(404);
    expect(await createKeyStore({ db: database.db }).findByHash(hash)).toBeUndefined();
    await vi.waitFor(() => expect(keyEvents(id)).toHaveLength(2));
    expect((await auditFor(id)).map(entry => [entry.action, entry.requestId])).toEqual([['payment_key.create', expect.any(String)], ['payment_key.revoke', 'revoke-key-1']]);
    expect((await call(owner.masterKey, 'PATCH', `/v1/keys/${id}`, { label: 'x' })).status).toBe(404);
    expect((await call(owner.masterKey, 'GET', '/v1/keys')).body).toMatchObject({ keys: [{ id, revokedAt }] });
  });

  it.each([
    ['POST', '/v1/keys'],
    ['GET', '/v1/keys'],
    ['PATCH', '/v1/keys/key_any'],
    ['DELETE', '/v1/keys/key_any'],
  ])('needs the master key: a payment key on %s %s gets 401 wrong_key_type', async (method, path) => {
    const owner = await signup();
    const created = await call(owner.masterKey, 'POST', '/v1/keys');

    const response = await call(created.body['key'] as string, method, path, method === 'PATCH' ? { label: 'x' } : undefined);

    expect(response).toMatchObject({ status: 401, body: { error: { code: 'wrong_key_type' } } });
  });
});

describe('a failing invalidation bus', () => {
  it('still answers 201, keeps the key, and logs the failure', async () => {
    const lines: string[] = [];
    const failing = createApp({
      config,
      logger: createLogger({}, { write: (line: string) => lines.push(line) }),
      postgres: database.postgres,
      redis,
      clock,
      invalidation: { publish: async () => { throw new Error('redis is down'); } },
    });
    const { port } = await failing.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
    try {
      const owner = await (await fetch(`http://127.0.0.1:${port}/v1/accounts`, { method: 'POST' })).json() as { masterKey: string };

      const response = await fetch(`http://127.0.0.1:${port}/v1/keys`, { method: 'POST', headers: { authorization: `Bearer ${owner.masterKey}` } });
      const body = await response.json() as { id: string; key: string };

      expect(response.status).toBe(201);
      expect(await createKeyStore({ db: database.db }).findByHash(hashApiKey(Secret.from(body.key)))).toMatchObject({ id: body.id });
      expect(lines.map(line => JSON.parse(line) as Record<string, unknown>)).toContainEqual(expect.objectContaining({
        level: 50, msg: 'Failed to publish an invalidation event', event: { kind: 'key', id: body.id },
      }));
      expect(lines.join('\n')).not.toContain(body.key);
    }
    finally {
      await failing.close();
    }
  });
});
