import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, type Server } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp } from '../../src/app.js';
import { startApi } from '../../src/start.js';

// The Platform API's events: IDs and codes only, never a key

const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const generous = { requests: 1000, windowSeconds: 60 };

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let api: Server;
let url: string;
// Every line the API writes, debug included
const lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  config = await loadPlatformConfig({
    env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ rateLimits: { signup: generous } })).toString('base64') },
  });
  api = createApp({
    config,
    logger: createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }),
    postgres: database.postgres,
    redis,
  });
  url = `http://127.0.0.1:${(await api.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await api?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

let counter = 0;
const call = async (method: string, path: string, { key, body, requestId = `api-logs-${++counter}` }: { key?: string; body?: unknown; requestId?: string } = {}) => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      'x-request-id': requestId,
      ...key === undefined ? {} : { authorization: `Bearer ${key}` },
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() as Record<string, any>, requestId };
};

const lineOf = (requestId: string, msg: string) => lines.find(line => line['requestId'] === requestId && line['msg'] === msg);

describe('accounts and keys', () => {
  it('logs a signup with the account\'s ID, never the key', async () => {
    const signup = await call('POST', '/v1/accounts');

    expect(signup.status).toBe(201);
    expect(lineOf(signup.requestId, 'An account was created')).toMatchObject({ level: 30, accountId: signup.body['id'] });
    expect(JSON.stringify(lines)).not.toContain(signup.body['masterKey']);
  });

  it('logs a master key rotation with the revoked key\'s ID', async () => {
    const before = await call('POST', '/v1/accounts');
    const rotated = await call('POST', '/v1/account/master-key/rotate', { key: before.body['masterKey'] });

    expect(rotated.status).toBe(200);
    expect(lineOf(rotated.requestId, 'A master key was rotated')).toMatchObject({
      level: 30, accountId: before.body['id'], revokedKeyId: expect.stringMatching(/^key_/),
    });
  });

  it('logs payment keys created, changed, and revoked, with their IDs and the limits\' names, never the key', async () => {
    const owner = await call('POST', '/v1/accounts');
    const masterKey = owner.body['masterKey'] as string;
    const created = await call('POST', '/v1/keys', { key: masterKey, body: { label: 'agent', dailyBudget: '2' } });
    const keyId = created.body['id'] as string;
    const changed = await call('PATCH', `/v1/keys/${keyId}`, { key: masterKey, body: { maxPrice: '0.01' } });
    const revoked = await call('DELETE', `/v1/keys/${keyId}`, { key: masterKey });

    expect(created.status).toBe(201);
    expect(lineOf(created.requestId, 'A payment key was created')).toMatchObject({ level: 30, accountId: owner.body['id'], keyId, limits: ['label', 'dailyBudget'] });
    expect(lineOf(changed.requestId, 'A payment key was changed')).toMatchObject({ level: 30, accountId: owner.body['id'], keyId, changed: ['maxPrice'] });
    expect(lineOf(revoked.requestId, 'A payment key was revoked')).toMatchObject({ level: 30, accountId: owner.body['id'], keyId });
    expect(JSON.stringify(lines)).not.toContain(created.body['key']);
  });

  it('logs a domain error\'s 4xx code on its request line, at info', async () => {
    const refused = await call('GET', '/v1/account', { key: 'af_test_not-a-master-key-at-all-0000000000000' });

    expect(refused.status).toBe(401);
    expect(lineOf(refused.requestId, 'Request completed')).toMatchObject({ level: 30, status: 401, code: 'wrong_key_type' });
  });
});

describe('the API\'s lines carry no key', () => {
  it('never logs a master key, the old one or the new one, or the Authorization header', async () => {
    const signup = await call('POST', '/v1/accounts');
    const rotated = await call('POST', '/v1/account/master-key/rotate', { key: signup.body['masterKey'] });
    await call('GET', '/v1/account', { key: rotated.body['masterKey'] });
    await call('GET', '/v1/account', { key: signup.body['masterKey'] });

    const logged = JSON.stringify(lines);
    for (const secret of [signup.body['masterKey'], rotated.body['masterKey'], 'Bearer '])
      expect(logged).not.toContain(secret);
  });
});

describe('the API\'s startup', () => {
  it('logs one line with the commit, the environment, the URLs, the assets\' names and networks, at LOG_LEVEL, and no secret', async () => {
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });
    const env = {
      CONFIG_PATH: 'config/example.yaml', DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose(),
      HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0', INTERNAL_PORT: '0', INTERNAL_API_SECRET: internalSecret, LOG_LEVEL: 'debug', GIT_SHA: 'abcdef1',
    };

    const app = await startApi({ env, logger });
    await app.close();

    expect(logger.level).toBe('debug');
    expect(startLines.filter(line => line['msg'] === 'Started')).toEqual([expect.objectContaining({
      level: 30,
      app: 'api',
      commit: 'abcdef1',
      logLevel: 'debug',
      environment: 'staging',
      urls: { website: 'https://anyfare.test', api: 'https://api.anyfare.test', pay: 'https://pay.anyfare.test', console: 'https://console.anyfare.test' },
      assets: [
        { name: 'base-usdc', network: 'eip155:84532' },
        { name: 'solana-usdc', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
        { name: 'tempo-pathusd', network: 'eip155:42431' },
        { name: 'near-usdc', network: 'near:testnet' },
      ],
    })]);
    const logged = JSON.stringify(startLines);
    for (const secret of [database.url.expose(), redis.url.expose(), internalSecret, '0x1111111111111111111111111111111111111111'])
      expect(logged).not.toContain(secret);
  });
});
