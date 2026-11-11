import fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createLedger, createPaymentRepository, createRoutingRepository, payments, routedEndpoints, topups } from '@anyfare/db';
import {
  createFakeClock, createTestDatabase, createTestRedis, startFakeOneClick, type FakeClock, type FakeOneClick, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';

// A response schema drops every field it doesn't name, and turns a value into its type. Each route that got one
// answers here, with the nulls and the values its fields can hold, while every answer a schema serializes is
// recorded beside what the route sent without one: `JSON.stringify` of the same value, which is what Fastify sends
// for a route without a response schema. The two must be the same bytes.

interface Answer {
  readonly method: string;
  readonly url: string;
  readonly status: string | undefined;
  readonly before: string;
  readonly after: string;
}

const noon = '2026-11-12T12:00:00.000Z';

let database: TestDatabase;
let redis: TestRedis;
let clock: FakeClock;
let oneClick: FakeOneClick;
let config: PlatformConfig;
const servers: ApiServer[] = [];
const answers: Answer[] = [];
let url: string;

const base64 = (yaml: string) => Buffer.from(yaml).toString('base64');

/** Fastify's own serializer compiler, as an app builds it for its first response schema, recording each answer it serializes. */
const recordAnswers = async (app: FastifyInstance): Promise<void> => {
  const probe = fastify();
  probe.get('/', { schema: { response: { 200: { type: 'object' } } } }, async () => ({}));
  await probe.ready();
  const compile = probe.serializerCompiler!;
  await probe.close();
  app.setSerializerCompiler(definition => {
    const serialize = compile(definition);

    return (data: unknown) => {
      const after = serialize(data);
      // A public read's route takes GET and OPTIONS
      answers.push({ method: [definition.method].flat().join(','), url: definition.url, status: definition.httpStatus, before: JSON.stringify(data), after });

      return after;
    };
  });
};

const start = async (platform: PlatformConfig): Promise<string> => {
  const server = createApp({ config: platform, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, trustProxy: '127.0.0.1' });
  servers.push(server);
  await recordAnswers(server.app);

  return `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
};

const topupsConfig = (oneClickUrl: string) => base64([
  'rateLimits:',
  '  signup: { requests: 1000, windowSeconds: 60 }',
  '  topups: { requests: 1000, windowSeconds: 3600 }',
  '  documents: { requests: 1000, windowSeconds: 60 }',
  'freeCredits: { enabled: true, perIp: { requests: 1, windowSeconds: 86400 } }',
  'topups:',
  '  enabled: true',
  `  url: ${oneClickUrl}`,
  '  timeoutMs: 500',
  '',
].join('\n'));

beforeAll(async () => {
  clock = createFakeClock(noon);
  [database, redis, oneClick] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeOneClick({ now: clock.now })]);
  config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml', CONFIG: topupsConfig(oneClick.url) } });
  url = await start(config);
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await oneClick?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const call = async (method: string, path: string, { key, body, ip, at = url }: { key?: string; body?: unknown; ip?: string; at?: string } = {}) => {
  const response = await fetch(`${at}${path}`, {
    method,
    headers: {
      ...key === undefined ? {} : { authorization: `Bearer ${key}` },
      ...ip === undefined ? {} : { 'x-forwarded-for': ip },
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

let signups = 0;
const signup = async (): Promise<{ readonly id: string; readonly masterKey: string }> => {
  signups += 1;

  return (await call('POST', '/v1/accounts', { ip: `198.51.100.${signups}` })).body as { id: string; masterKey: string };
};

/** Every answer the route's schemas serialized, each the same as without them, and the statuses among them. */
const expectUnchanged = (method: string, route: string, statuses: readonly string[]): void => {
  const seen = answers.filter(answer => answer.method.split(',').includes(method) && answer.url === route);

  expect(new Set(seen.map(answer => answer.status)), `${method} ${route}`).toEqual(new Set(statuses));
  for (const answer of seen)
    expect(answer.after, `${method} ${route} ${answer.status}`).toBe(answer.before);
};

describe('the answers of the routes with a response schema are what they sent without one', () => {
  it('POST /v1/accounts, with free Credits and without', async () => {
    const ip = '203.0.113.20';
    const first = await call('POST', '/v1/accounts', { ip });
    const second = await call('POST', '/v1/accounts', { ip });

    expect([first.status, first.body['freeCredits'], second.status, second.body['freeCredits']]).toEqual([201, '0.1', 201, '0']);
    expectUnchanged('POST', '/v1/accounts', ['201']);
  });

  it('GET /v1/account and POST /v1/account/master-key/rotate', async () => {
    const owner = await signup();
    expect((await call('GET', '/v1/account', { key: owner.masterKey })).status).toBe(200);
    expect((await call('POST', '/v1/account/master-key/rotate', { key: owner.masterKey })).status).toBe(200);

    expectUnchanged('GET', '/v1/account', ['200']);
    expectUnchanged('POST', '/v1/account/master-key/rotate', ['200']);
  });

  it('the payment keys: made with limits and without, listed, changed, cleared and revoked', async () => {
    const owner = await signup();
    const bare = await call('POST', '/v1/keys', { key: owner.masterKey });
    const limited = await call('POST', '/v1/keys', {
      key: owner.masterKey, body: { label: 'research', allowance: '20', dailyBudget: '5.5', maxPrice: '0.05', expiresAt: '2026-12-31T00:00:00.000Z' },
    });
    expect([bare.status, limited.status]).toEqual([201, 201]);
    expect((await call('PATCH', `/v1/keys/${String(bare.body['id'])}`, { key: owner.masterKey, body: { label: 'n8n', maxPrice: '0.01' } })).status).toBe(200);
    expect((await call('PATCH', `/v1/keys/${String(limited.body['id'])}`, { key: owner.masterKey, body: { label: null, allowance: null, expiresAt: null } })).status)
      .toBe(200);
    expect((await call('DELETE', `/v1/keys/${String(bare.body['id'])}`, { key: owner.masterKey })).status).toBe(200);
    const listed = await call('GET', '/v1/keys', { key: owner.masterKey });
    expect((listed.body['keys'] as { revokedAt: string | null }[]).map(key => key.revokedAt === null).sort()).toEqual([false, true]);

    expectUnchanged('POST', '/v1/keys', ['201']);
    expectUnchanged('PATCH', '/v1/keys/:id', ['200']);
    expectUnchanged('DELETE', '/v1/keys/:id', ['200']);
    expectUnchanged('GET', '/v1/keys', ['200']);
  });

  it('GET /v1/balance and GET /v1/payments, a page with more after it and the last one, with a key and an API status and without', async () => {
    const owner = await signup();
    const keyId = String((await call('POST', '/v1/keys', { key: owner.masterKey })).body['id']);
    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
    await ledger.credit({ accountId: owner.id, amount: 2_000_000n, reference: `answers-${owner.id}` });
    for (const [index, requestId] of [undefined, 'req-answers-2'].entries()) {
      const held = await ledger.hold({
        payment: {
          id: `pay_answers_${owner.id}_${index}`, requestId, rail: 'credits', buyerAccountId: owner.id, keyId, targetHost: 'api.example.test',
          targetPath: '/v1/data', network: undefined, asset: undefined, atomicAmount: undefined, amount: 10_000n,
        },
        dailyBudget: 5_000_000n,
        allowance: undefined,
      });
      expect(held.ok).toBe(true);
    }
    await createPaymentRepository({ db: database.db, clock }).recordDecision({
      paymentId: `pay_answers_${owner.id}_1`, decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 40,
    });
    // A payment on a chain that names the account: no key
    await database.db.insert(payments).values({
      id: `pay_answers_${owner.id}_chain`, rail: 'x402', buyerAccountId: owner.id, keyId: null, targetHost: 'api.example.test', targetPath: '/v1/data',
      network: 'eip155:84532', asset: 'base-usdc', atomicAmount: 10_000n, amount: 10_000n, status: 'settled', upstreamStatus: 200, needsReview: false,
      createdAt: new Date('2026-11-12T11:00:00.000Z'), updatedAt: new Date('2026-11-12T11:00:00.000Z'),
    });

    // The credit, and the free Credits of the sign-up, less the holds
    expect((await call('GET', '/v1/balance', { key: owner.masterKey })).body).toEqual({ available: '2.08', held: '0.02' });
    const first = await call('GET', '/v1/payments?limit=1', { key: owner.masterKey });
    const last = await call('GET', `/v1/payments?limit=1&after=${String(first.body['next'])}`, { key: owner.masterKey });
    expect([first.body['next'] === null, last.body['next'] === null]).toEqual([false, false]);
    const all = (await call('GET', '/v1/payments?limit=100', { key: owner.masterKey })).body['payments'] as { keyId: string | null; upstreamStatus: number | null; state: string }[];
    expect(all.map(payment => [payment.keyId === null, payment.upstreamStatus, payment.state])).toEqual([[false, 200, 'pending'], [false, null, 'pending'], [true, 200, 'paid']]);
    expect((await call('GET', `/v1/payments?state=pending&keyId=${keyId}&service=api.example.test`, { key: owner.masterKey })).body['payments']).toHaveLength(2);

    expectUnchanged('GET', '/v1/balance', ['200']);
    expectUnchanged('GET', '/v1/payments', ['200']);
  });

  it('GET /v1/topups/options, with the tokens, with and without an address, and without them when 1Click can\'t be read', async () => {
    const options = await call('GET', '/v1/topups/options');
    const blind = await start(await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml', CONFIG: topupsConfig('http://127.0.0.1:9') } }));
    const without = await call('GET', '/v1/topups/options', { at: blind });

    const networks = options.body['networks'] as { tokens?: { address?: string }[] }[];
    expect(networks.flatMap(network => network.tokens ?? []).some(token => token.address === undefined)).toBe(true);
    expect(networks.flatMap(network => network.tokens ?? []).some(token => token.address !== undefined)).toBe(true);
    expect((without.body['networks'] as { tokens?: unknown }[]).every(network => network.tokens === undefined)).toBe(true);
    expectUnchanged('GET', '/v1/topups/options', ['200']);
  });

  it('POST /v1/topups and GET /v1/topups/{id}, waiting, credited and refused', async () => {
    const owner = await signup();
    const created = await call('POST', '/v1/topups', { key: owner.masterKey, body: { network: 'base', token: 'USDC', amount: '1' } });
    expect(created.status).toBe(201);
    const row = {
      accountId: owner.id, requestId: null, network: 'base', blockchain: 'base', tokenSymbol: 'USDC', originAsset: 'nep141:base-usdc.omft.near', tokenDecimals: 6,
      amount: 1_500_000n, destinationAsset: 'near-usdc', recipient: 'treasury.anyfare.testnet', refundTo: 'treasury.anyfare.testnet',
      payBy: new Date('2026-11-12T13:00:00.000Z'), quoteRequest: {}, originTxHashes: [] as string[], needsReview: false,
      createdAt: new Date(noon), updatedAt: new Date('2026-11-12T12:30:00.000Z'),
    };
    await database.db.insert(topups).values([
      {
        ...row, id: `top_credited-${owner.id.slice(4)}`, status: 'credited' as const, depositAddress: `0xanswers${owner.id.slice(4)}`, depositMemo: 'memo-7',
        addressExpiresAt: new Date('2026-11-12T13:00:00.000Z'), sendAmount: 1_500_000n, sendAtLeast: 1_490_000n, estimatedCredits: 1_490_000n,
        depositedAmount: 1_500_000n, creditedAmount: 1_490_000n, deliveryTxHash: 'delivery-hash-1', refundedAmount: 10_000n, refundReason: 'Partly refunded',
      },
      { ...row, id: `top_failed-${owner.id.slice(4)}`, status: 'quote_failed' as const, quoteError: 'refused' },
    ]);

    for (const id of [String(created.body['id']), `top_credited-${owner.id.slice(4)}`, `top_failed-${owner.id.slice(4)}`])
      expect((await call('GET', `/v1/topups/${id}`, { key: owner.masterKey })).status).toBe(200);
    const credited = await call('GET', `/v1/topups/top_credited-${owner.id.slice(4)}`, { key: owner.masterKey });
    const failed = await call('GET', `/v1/topups/top_failed-${owner.id.slice(4)}`, { key: owner.masterKey });
    expect(Object.values(credited.body).every(value => value !== null)).toBe(true);
    expect(Object.values(failed.body).filter(value => value === null).length).toBe(11);
    // The list of them: a page with more after it, and the last one, holding the three as GET gives each
    const first = await call('GET', '/v1/topups?limit=2', { key: owner.masterKey });
    const last = await call('GET', `/v1/topups?limit=2&after=${String(first.body['next'])}`, { key: owner.masterKey });
    expect([first.body['next'] === null, last.body['next'] === null]).toEqual([false, true]);
    expect([...first.body['topups'] as unknown[], ...last.body['topups'] as unknown[]]).toEqual(expect.arrayContaining([credited.body, failed.body]));

    expectUnchanged('POST', '/v1/topups', ['201']);
    expectUnchanged('GET', '/v1/topups/:id', ['200']);
    expectUnchanged('GET', '/v1/topups', ['200']);
  });

  it('GET /v1/catalog, paid with a price and without, checked, a page with more after it and the last one', async () => {
    await database.db.insert(routedEndpoints).values([
      { host: 'answers.example.com', path: '/v1/priced', lastPrice: 10_000n, status: 'paid', createdAt: new Date('2026-11-12T08:00:00.000Z') },
      { host: 'answers.example.com', path: '/v1/unpriced', status: 'paid', createdAt: new Date('2026-11-12T08:01:00.000Z') },
    ]);
    await createRoutingRepository({ db: database.db, clock }).registerEndpoint({
      host: 'checked.answers.example.com', path: '/v1/checked', lastPrice: 20_000n, checked: { method: 'POST', mayAddHost: true },
    });

    const all = await call('GET', '/v1/catalog?limit=100');
    const page = await call('GET', '/v1/catalog?limit=1');
    expect((all.body['endpoints'] as { status: string }[]).map(endpoint => endpoint.status)).toEqual(['paid', 'paid', 'checked']);
    expect([page.body['next'] === null, all.body['next'] === null]).toEqual([false, true]);

    expectUnchanged('GET', '/v1/catalog', ['200']);
  });

  it('GET /_/health', async () => {
    expect((await call('GET', '/_/health')).body).toEqual({ status: 'ok' });

    expectUnchanged('GET', '/_/health', ['200']);
  });
});
