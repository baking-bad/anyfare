import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createLogger, type Server } from '@anyfare/common';
import { loadPlatformConfig, type ApiKeyRepository, type PlatformConfig } from '@anyfare/core';
import { createApiKeyRepository } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, startFakeOneClick, type FakeOneClick, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiDependencies } from '../../src/app.js';

// The routes behind the master key answer CORS for the console's origin, and for no other, on every answer: the
// console's page calls them from the browser with the master key

const consoleOrigin = 'https://console.anyfare.test';
const clock = createFakeClock('2026-11-12T09:00:00.000Z');

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: any;
}

interface CallOptions {
  readonly origin?: string;
  readonly key?: string;
  readonly body?: unknown;
  readonly ip?: string;
  readonly headers?: Record<string, string>;
}

let database: TestDatabase;
let redis: TestRedis;
let oneClick: FakeOneClick;
let config: PlatformConfig;
let lookups: MockInstance<ApiKeyRepository['findActiveByHash']>;
const servers: Server[] = [];
// Every answer any test got, so none can be said to allow credentials
const answers: Answer[] = [];

// Top-ups on against the fake, at most 2 an hour per account, and sign-ups no test here reaches
let app: string;
// At most 3 sign-ups a minute per address, and top-ups off
let strict: string;
// No console origin at all
let bare: string;
// Whose key lookups fail, so a request with a well-formed master key answers 500
let broken: string;

const base64 = (yaml: string) => Buffer.from(yaml).toString('base64');
const configWith = (lines: readonly string[]) => loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml', CONFIG: base64(`${lines.join('\n')}\n`) } });

const start = async (platform: PlatformConfig, dependencies: Partial<ApiDependencies> = {}): Promise<string> => {
  const server = createApp({
    config: platform, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, trustProxy: '127.0.0.1', ...dependencies,
  });
  servers.push(server);
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return `http://127.0.0.1:${port}`;
};

beforeAll(async () => {
  [database, redis, oneClick] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeOneClick({ now: clock.now })]);
  config = await configWith([
    'rateLimits:',
    '  signup: { requests: 1000, windowSeconds: 60 }',
    '  documents: { requests: 1000, windowSeconds: 60 }',
    '  topups: { requests: 2, windowSeconds: 3600 }',
    'topups:',
    '  enabled: true',
    `  url: ${oneClick.url}`,
  ]);
  const apiKeys = createApiKeyRepository({ db: database.db });
  lookups = vi.spyOn(apiKeys, 'findActiveByHash');
  app = await start(config, { apiKeys });
  strict = await start(await configWith(['rateLimits:', '  signup: { requests: 3, windowSeconds: 60 }']));
  bare = await start({ ...config, urls: { website: config.urls.website, api: config.urls.api, pay: config.urls.pay } });
  broken = await start(config, { apiKeys: { findActiveByHash: async () => { throw new Error('The key store is down'); } } });
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await oneClick?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const call = async (base: string, method: string, path: string, { origin, key, body, ip, headers = {} }: CallOptions = {}): Promise<Answer> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...origin === undefined ? {} : { origin },
      ...key === undefined ? {} : { authorization: `Bearer ${key}` },
      ...ip === undefined ? {} : { 'x-forwarded-for': ip },
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const answer = { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
  answers.push(answer);

  return answer;
};

const preflight = (base: string, path: string, origin: string | undefined, headers: Record<string, string> = {}) => call(base, 'OPTIONS', path, {
  origin,
  headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type', ...headers },
});

// The strict app's sign-ups come from an address of their own: the counters are shared, and the others' are many
const signup = async (base = app): Promise<string> =>
  (await call(base, 'POST', '/v1/accounts', base === strict ? { ip: '198.51.100.22' } : {})).body.masterKey as string;

// The answer's Access-Control-* headers, by name
const corsOf = (answer: Answer): Record<string, string> => Object.fromEntries([...answer.headers].filter(([name]) => name.startsWith('access-control-')));

const allowed = { 'access-control-allow-origin': consoleOrigin, 'access-control-expose-headers': 'Retry-After, X-Request-Id' };
const allowedPreflight = {
  ...allowed,
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '600',
};

const expectConsole = (answer: Answer, label?: string): void => {
  expect(corsOf(answer), label).toEqual(allowed);
  expect(answer.headers.get('vary'), label).toBe('Origin');
};

// What an answer looks like: its fields and the type of each, without the values
const shapeOf = (value: unknown): unknown => {
  if (Array.isArray(value))
    return value.map(shapeOf);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, shapeOf(item)]));

  return value === null ? 'null' : typeof value;
};

/** Every route behind the master key, with a new account, from one origin. The rotation last: it ends the key. */
const tour = async (origin: string | undefined): Promise<Record<string, Answer>> => {
  const tried: Record<string, Answer> = {};
  const record = async (name: string, answer: Promise<Answer>): Promise<Answer> => (tried[name] = await answer);

  const master = (await record('POST /v1/accounts', call(app, 'POST', '/v1/accounts', { origin }))).body.masterKey as string;
  const as = { origin, key: master };
  await record('GET /v1/account', call(app, 'GET', '/v1/account', as));
  const keyId = (await record('POST /v1/keys', call(app, 'POST', '/v1/keys', { ...as, body: { label: 'From the console', dailyBudget: '2' } }))).body.id as string;
  await record('GET /v1/keys', call(app, 'GET', '/v1/keys', as));
  await record('PATCH /v1/keys/:id', call(app, 'PATCH', `/v1/keys/${keyId}`, { ...as, body: { label: 'Renamed' } }));
  await record('DELETE /v1/keys/:id', call(app, 'DELETE', `/v1/keys/${keyId}`, as));
  await record('GET /v1/balance', call(app, 'GET', '/v1/balance', as));
  await record('GET /v1/payments', call(app, 'GET', '/v1/payments', as));
  const topupId = (await record('POST /v1/topups', call(app, 'POST', '/v1/topups', { ...as, body: { network: 'base', token: 'USDC', amount: '1' } }))).body.id as string;
  await record('GET /v1/topups/:id', call(app, 'GET', `/v1/topups/${topupId}`, as));
  await record('GET /v1/topups', call(app, 'GET', '/v1/topups?limit=5', as));
  await record('POST /v1/account/master-key/rotate', call(app, 'POST', '/v1/account/master-key/rotate', as));

  return tried;
};

const keyedUrls = [
  '/v1/accounts', '/v1/account', '/v1/account/master-key/rotate', '/v1/keys', '/v1/keys/key_any', '/v1/balance', '/v1/payments', '/v1/topups', '/v1/topups/top_any',
];

describe('a route behind the master key', () => {
  it('answers the console\'s origin with it, Vary and the headers it may read; another origin, null, or none get no CORS header and the same answer', async () => {
    const fromConsole = await tour(consoleOrigin);
    const others = { 'https://evil.example': await tour('https://evil.example'), 'null': await tour('null'), 'no origin': await tour(undefined) };

    expect(Object.fromEntries(Object.entries(fromConsole).map(([name, answer]) => [name, answer.status]))).toEqual({
      'POST /v1/accounts': 201,
      'GET /v1/account': 200,
      'POST /v1/keys': 201,
      'GET /v1/keys': 200,
      'PATCH /v1/keys/:id': 200,
      'DELETE /v1/keys/:id': 200,
      'GET /v1/balance': 200,
      'GET /v1/payments': 200,
      'POST /v1/topups': 201,
      'GET /v1/topups/:id': 200,
      'GET /v1/topups': 200,
      'POST /v1/account/master-key/rotate': 200,
    });
    for (const [name, answer] of Object.entries(fromConsole))
      expectConsole(answer, name);
    for (const [origin, tried] of Object.entries(others)) {
      for (const [name, answer] of Object.entries(tried)) {
        const label = `${name} from ${origin}`;
        expect(corsOf(answer), label).toEqual({});
        // Said whenever a console origin is set, so no cache gives one origin's answer to another
        expect(answer.headers.get('vary'), label).toBe('Origin');
        expect(answer.status, label).toBe(fromConsole[name]!.status);
        expect(shapeOf(answer.body), label).toEqual(shapeOf(fromConsole[name]!.body));
      }
    }
  });

  it('answers the console\'s preflight of each URL with 204, the methods and the headers it may send, before the key, a limit, or a handler', async () => {
    const master = await signup();
    const before = lookups.mock.calls.length;
    for (const path of keyedUrls) {
      // A preflight never carries the key, but one that did would still reach no lookup
      for (const headers of [{}, { authorization: `Bearer ${master}` }] as Record<string, string>[]) {
        const answer = await preflight(app, path, consoleOrigin, headers);

        expect(answer.status, path).toBe(204);
        expect(corsOf(answer), path).toEqual(allowedPreflight);
        expect(answer.headers.get('vary'), path).toBe('Origin');
        expect(answer.body, path).toBeUndefined();
      }
    }

    expect(lookups.mock.calls.length).toBe(before);
  });

  it('gives no allow header to another origin\'s preflight, null\'s, or one without an origin: 404, as without the preflight', async () => {
    for (const path of keyedUrls) {
      for (const origin of ['https://evil.example', 'null', undefined]) {
        const answer = await preflight(app, path, origin);
        const label = `${path} from ${origin}`;

        expect(answer.status, label).toBe(404);
        expect(corsOf(answer), label).toEqual({});
        expect(answer.body, label).toEqual({ error: { code: 'not_found', message: 'Not found' } });
      }
    }
  });

  it('never counts a preflight against the sign-up limit: many, then the 3 sign-ups the limit allows, then a 429 the console can read', async () => {
    for (let count = 0; count < 10; count++)
      expect((await call(strict, 'OPTIONS', '/v1/accounts', { origin: consoleOrigin, ip: '198.51.100.21' })).status).toBe(204);
    expect((await call(strict, 'OPTIONS', '/v1/accounts', { origin: 'https://evil.example', ip: '198.51.100.21' })).status).toBe(404);

    const statuses = [];
    for (let count = 0; count < 3; count++)
      statuses.push((await call(strict, 'POST', '/v1/accounts', { origin: consoleOrigin, ip: '198.51.100.21' })).status);
    const refused = await call(strict, 'POST', '/v1/accounts', { origin: consoleOrigin, ip: '198.51.100.21' });

    expect(statuses).toEqual([201, 201, 201]);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expectConsole(refused);
  });

  it('never counts a preflight against the top-up limit: many, then the 2 top-ups the limit allows, then a 429 the console can read', async () => {
    const master = await signup();
    for (let count = 0; count < 10; count++)
      expect((await preflight(app, '/v1/topups', consoleOrigin, { authorization: `Bearer ${master}` })).status).toBe(204);

    const topUp = () => call(app, 'POST', '/v1/topups', { origin: consoleOrigin, key: master, body: { network: 'base', token: 'USDC', amount: '1' } });
    const statuses = [(await topUp()).status, (await topUp()).status];
    const refused = await topUp();

    expect(statuses).toEqual([201, 201]);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expectConsole(refused);
  });

  it('answers the console\'s preflight of a top-up while top-ups are off, rather than 503', async () => {
    for (const path of ['/v1/topups', '/v1/topups/top_any']) {
      const answer = await preflight(strict, path, consoleOrigin);

      expect(answer.status).toBe(204);
      expect(corsOf(answer)).toEqual(allowedPreflight);
    }
  });
});

describe('an error behind the master key', () => {
  it('carries the console\'s headers: 401 without a key, with a bad one, and with a payment key', async () => {
    const master = await signup();
    const paymentKey = (await call(app, 'POST', '/v1/keys', { key: master })).body.key as string;

    const answered = {
      unauthorized: await call(app, 'GET', '/v1/account', { origin: consoleOrigin }),
      invalid_key: await call(app, 'GET', '/v1/keys', { origin: consoleOrigin, key: 'afm_test_nope' }),
      wrong_key_type: await call(app, 'GET', '/v1/balance', { origin: consoleOrigin, key: paymentKey }),
    };

    for (const [code, answer] of Object.entries(answered)) {
      expect([answer.status, answer.body.error.code], code).toEqual([401, code]);
      expect(answer.headers.get('www-authenticate'), code).toBe('Bearer');
      expectConsole(answer, code);
    }
  });

  it('carries the console\'s headers: 404 for an unknown ID, 400 for a bad body or query, 415 for a body that isn\'t JSON', async () => {
    const master = await signup();
    const as = { origin: consoleOrigin, key: master };

    const answered = [
      [404, 'not_found', await call(app, 'PATCH', '/v1/keys/key_unknown', { ...as, body: { label: 'x' } })],
      [404, 'not_found', await call(app, 'DELETE', '/v1/keys/key_unknown', as)],
      [404, 'not_found', await call(app, 'GET', '/v1/topups/top_unknown', as)],
      [400, 'invalid_request', await call(app, 'POST', '/v1/keys', { ...as, body: { allowance: 5 } })],
      [400, 'invalid_request', await call(app, 'POST', '/v1/keys', { ...as, body: '{"label": ' })],
      [400, 'invalid_request', await call(app, 'POST', '/v1/accounts', { origin: consoleOrigin, body: { name: 'x' } })],
      [400, 'invalid_request', await call(app, 'POST', '/v1/topups', { ...as, body: {} })],
      [400, 'invalid_request', await call(app, 'GET', '/v1/payments?limit=0', as)],
      [400, 'invalid_request', await call(app, 'GET', '/v1/payments?state=charged', as)],
      [400, 'invalid_request', await call(app, 'GET', '/v1/topups?after=not-a-cursor', as)],
      [415, 'unsupported_media_type', await call(app, 'POST', '/v1/keys', { ...as, headers: { 'content-type': 'application/xml' }, body: '<label/>' })],
    ] as const;

    for (const [status, code, answer] of answered) {
      expect([answer.status, answer.body.error.code]).toEqual([status, code]);
      expectConsole(answer, `${status} ${code}`);
    }
  });

  it('carries the console\'s headers: 503 with top-ups off, answered before the handler', async () => {
    const master = await signup(strict);

    for (const answer of [
      await call(strict, 'POST', '/v1/topups', { origin: consoleOrigin, key: master, body: { network: 'base', token: 'USDC', amount: '1' } }),
      await call(strict, 'GET', '/v1/topups/top_any', { origin: consoleOrigin, key: master }),
      await call(strict, 'GET', '/v1/topups', { origin: consoleOrigin, key: master }),
    ]) {
      expect([answer.status, answer.body.error.code]).toEqual([503, 'topups_unavailable']);
      expectConsole(answer);
    }
  });

  it('carries the console\'s headers: 500 when the key can\'t be looked up', async () => {
    const answer = await call(broken, 'GET', '/v1/account', { origin: consoleOrigin, key: await signup() });

    expect([answer.status, answer.body.error.code]).toEqual([500, 'internal_error']);
    expectConsole(answer);
  });
});

describe('an origin that only looks like the console\'s', () => {
  it.each([
    ['another port', 'https://console.anyfare.test:8443'],
    ['the default port written out', 'https://console.anyfare.test:443'],
    ['http for https', 'http://console.anyfare.test'],
    ['a suffix', 'https://console.anyfare.test.evil.test'],
    ['a subdomain', 'https://evil.console.anyfare.test'],
    ['a trailing slash', 'https://console.anyfare.test/'],
    ['upper case, which no browser sends', 'HTTPS://CONSOLE.ANYFARE.TEST'],
    ['the website', 'https://anyfare.test'],
    ['two origins', `${consoleOrigin}, https://evil.example`],
  ])('is refused: %s', async (_name, origin) => {
    const master = await signup();
    const answer = await call(app, 'GET', '/v1/account', { origin, key: master });
    const asked = await preflight(app, '/v1/account', origin);

    expect(answer.status).toBe(200);
    expect(corsOf(answer)).toEqual({});
    expect(asked.status).toBe(404);
    expect(corsOf(asked)).toEqual({});
  });
});

describe('without a console origin', () => {
  it('a route behind the master key answers no CORS header, no Vary, and no preflight, from any origin', async () => {
    const master = await signup(bare);

    for (const origin of [consoleOrigin, 'https://evil.example', undefined]) {
      const label = String(origin);
      const read = await call(bare, 'GET', '/v1/account', { origin, key: master });
      const signedUp = await call(bare, 'POST', '/v1/accounts', { origin });
      const refused = await call(bare, 'GET', '/v1/balance', { origin });
      const asked = await preflight(bare, '/v1/keys', origin);

      expect([read.status, signedUp.status, refused.status, asked.status], label).toEqual([200, 201, 401, 404]);
      for (const answer of [read, signedUp, refused, asked]) {
        expect(corsOf(answer), label).toEqual({});
        expect(answer.headers.get('vary'), label).toBeNull();
      }
    }
  });

  it('answers a request without an origin with the headers an API with one gives it, but Vary', async () => {
    const names = async (base: string) => [...(await call(base, 'GET', '/v1/account', { key: await signup(base) })).headers.keys()];

    expect((await names(app)).filter(name => name !== 'vary')).toEqual(await names(bare));
  });
});

describe('a public read', () => {
  it('still answers any origin with *, the console\'s too', async () => {
    for (const path of ['/v1/catalog', '/v1/topups/options', '/openapi.json']) {
      const read = await call(app, 'GET', path, { origin: consoleOrigin });
      const asked = await preflight(app, path, consoleOrigin);

      expect([read.status, read.headers.get('access-control-allow-origin')], path).toEqual([200, '*']);
      expect([asked.status, asked.headers.get('access-control-allow-origin'), asked.headers.get('access-control-allow-methods')], path).toEqual([204, '*', 'GET, OPTIONS']);
    }
  });
});

describe('any answer', () => {
  it('never allows credentials', () => {
    expect(answers.length).toBeGreaterThan(150);
    expect(answers.filter(answer => answer.headers.has('access-control-allow-credentials'))).toEqual([]);
  });
});
