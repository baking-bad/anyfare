import { createHash, randomUUID } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { eq, sql } from 'drizzle-orm';
import { Challenge } from 'mppx';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, systemClock, type Server } from '@anyfare/common';
import { endpointNumbersOf, findAsset, generateApiKey, hashApiKey, loadPlatformConfig, type PlatformConfig, type StoredEndpoint } from '@anyfare/core';
import {
  createAccountRepository, createLedger, createPaymentKeyRepository, createPostgres, createRedisReplayStore, createRoutingRepository, createStatsRepository,
  payments, targetPayments, type Redis, type RedisReplayStore,
} from '@anyfare/db';
import { createFacilitators, initializeMpp, initializeX402, type MppSetup, type X402Setup } from '@anyfare/payments';
import { createApp as createSigner } from '@anyfare/signer';
import {
  createFakeResolver, createTestDatabase, createTestRedis, encodeBase58, nearFacilitatorOff, startFakeFacilitator, startFakeTempoRpc, startFakeUpstream,
  type FakeFacilitator, type FakeTempoRpc, type FakeUpstream, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp, type ProxyDependencies, type ProxyServer } from '../../src/app.js';
import { createSignerClient } from '../../src/routing/support.js';

// `GET /_/check` through the real proxy: the target's 402 as it came, what it asks, the ways we take the
// quote, the endpoint's numbers, and why a link isn't payable, under the limits of a routed call

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const tempoNetwork = 'eip155:42431';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const mppSecretKey = 'mpp-secret-key-for-the-check-tests!!!!';
// Made-up addresses: the target's on Base and on Tempo, and one of ours that a target's name resolves to
const targetPayTo = '0x3333333333333333333333333333333333333333';
const targetRecipient = '0x5555555555555555555555555555555555555555';
const ourAddress = '203.0.113.7';
const targetHosts = [
  'api.target.test', 'optout.target.test', 'blocked.target.test', 'private.target.test', 'refused.target.test', 'slow.target.test', 'ours.target.test',
  'nowhere.target.test',
];
const generous = { requests: 100_000, windowSeconds: 60 };
// What the target sends beside its challenge, that a check never echoes
const cookie = 'session=target-cookie-7';
const secret = 'target-secret-value-9';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let target: FakeUpstream;
let facilitator: FakeFacilitator;
let rpc: FakeTempoRpc;
let store: RedisReplayStore;
let http: OutboundHttp;
let x402: X402Setup;
let mpp: MppSetup;
let signer: Server;
let signerUrl: string;
let proxy: ProxyServer;
let proxyUrl: string;
let usdc: string;
let pathUsd: string;
// A port nobody listens on
let closedPort: number;
// The MPP challenge the target sent last
let lastMppChallenge = '';
const signerWallet = privateKeyToAccount(generatePrivateKey());

/** The target's x402 challenge: a Gateway option we don't pay, and a plain USDC one at 0.001. */
const required = (url: string, path: string) => ({
  x402Version: 2, error: 'Payment required', resource: { url, description: `Pools at ${path}`, mimeType: 'application/json' },
  accepts: [
    { scheme: 'exact', network: base, amount: '100', asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'GatewayWalletBatched', version: '1' } },
    { scheme: 'exact', network: base, amount: '1000', asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } },
  ] as PaymentRequirements[],
});

/** The target's MPP challenge: a Tempo charge of 0.002 in pull mode, for five minutes. */
const mppChallenge = (realm: string): string => Challenge.serialize(Challenge.from({
  id: `check-${randomUUID()}`, realm, method: 'tempo', intent: 'charge', description: 'Quotes', expires: new Date(systemClock.now().getTime() + 5 * 60_000).toISOString(),
  request: { amount: '2000', currency: pathUsd, recipient: targetRecipient, methodDetails: { chainId: 42_431, supportedModes: ['pull'] } },
} as never));

beforeAll(async () => {
  [database, redis, target, facilitator, rpc] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: targetHosts }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }), startFakeTempoRpc(),
  ]);
  const loaded = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        urls: { website: 'https://www.anyfare.test', api: 'https://api.anyfare.test', pay: 'https://pay.anyfare.test' },
        ownHosts: [ourAddress],
        routingFeeBps: 1000,
        rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous },
        facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff],
        signer: { maxPerCall: '0.5', maxPerNetworkPerDay: '100' },
      })).toString('base64'),
    },
  });
  // Solana USDC only from a cent: the combined 402 leaves it out at our quotes, and so must the check
  config = { ...loaded, assets: loaded.assets.map(asset => asset.name === 'solana-usdc' ? { ...asset, minPrice: 10_000n as typeof asset.minPrice } : asset) };
  usdc = findAsset(config, 'base-usdc')!.address;
  pathUsd = findAsset(config, 'tempo-pathusd')!.address;

  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    const self = `https://${request.servername}:${target.port}`;
    const extras = { 'set-cookie': cookie, 'x-secret': secret, 'x-powered-by': 'target' };
    if (path === '/.well-known/anyfare.json') {
      response.writeHead(request.servername === 'optout.target.test' ? 200 : 404, { 'content-type': 'application/json' }).end('{"routing":false}');
      return;
    }
    if (path === '/v1/free') {
      response.writeHead(200, { 'content-type': 'application/json', ...extras }).end('{"free":true}');
      return;
    }
    if (path === '/v1/no-challenge') {
      response.writeHead(402, { 'content-type': 'application/json' }).end('{"error":"pay"}');
      return;
    }
    if (path === '/v1/gateway-only') {
      const gatewayOnly = { ...required(`${self}${path}`, path), accepts: required(`${self}${path}`, path).accepts.slice(0, 1) };
      response.writeHead(402, { 'payment-required': encodePaymentRequiredHeader(gatewayOnly as never) }).end('{}');
      return;
    }
    if (path === '/v1/huge-headers') {
      response.writeHead(402, { 'x-filler': 'f'.repeat(40_000) }).end('{}');
      return;
    }
    // Answers a probe with what the buyer sent: its key and its body, in the 402's description and challenge
    if (path.startsWith('/v1/echo') && typeof request.headers['payment-signature'] !== 'string') {
      const echoed = `${String(request.headers['x-api-key'] ?? '')} ${request.body.toString('utf8')}`.trim() || 'anyone';
      const challenge = required(`${self}${path}`, path);
      response.writeHead(402, {
        'payment-required': encodePaymentRequiredHeader({ ...challenge, resource: { ...challenge.resource, description: `For ${echoed}` } } as never),
        'www-authenticate': `Bearer realm="${echoed}"`, 'content-type': 'application/json',
      }).end(JSON.stringify({ echoed }));
      return;
    }
    if (path === '/v1/hangs') {
      setTimeout(() => response.end(), 1_500);
      return;
    }
    if (path.startsWith('/v1/mpp')) {
      lastMppChallenge = mppChallenge(request.servername ?? '');
      response.writeHead(402, { 'www-authenticate': lastMppChallenge, 'content-type': 'application/json', ...extras }).end('{"body":"never read"}');
      return;
    }
    // Paid only with POST: any other method is refused
    if (path.startsWith('/v1/post-only') && request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (typeof request.headers['payment-signature'] !== 'string') {
      response.writeHead(402, {
        'payment-required': encodePaymentRequiredHeader(required(`${self}${path}`, path) as never), 'content-type': 'application/json', 'cache-control': 'no-store',
        ...extras,
      }).end('{"body":"never read"}');
      return;
    }
    const settled = encodePaymentResponseHeader({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: base, payer: signerWallet.address } as never);
    response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled }).end(JSON.stringify({ paid: path }));
  });

  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver({
      ...Object.fromEntries(targetHosts.filter(host => host !== 'nowhere.target.test').map(host => [host, '127.0.0.1'])),
      'private.target.test': '10.0.0.1', 'ours.target.test': ourAddress,
    }),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca,
    connectTimeoutMs: 2_000,
    totalTimeoutMs: 5_000,
  });
  const closed = createNetServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  closedPort = (closed.address() as AddressInfo).port;
  await new Promise<void>(resolve => closed.close(() => resolve()));

  store = createRedisReplayStore({ redis });
  signer = createSigner({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet } });
  signerUrl = `http://127.0.0.1:${(await signer.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
  x402 = await initializeX402({
    config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: systemClock }), timeoutMs: 5_000,
  });
  mpp = await initializeMpp({ config, secretKey: Secret.from(mppSecretKey), store, timeoutMs: 5_000, rpcUrl: rpc.url });
  proxy = createApp({
    config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, http, x402, mpp, claims: store,
    signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
  });
  proxyUrl = `http://127.0.0.1:${(await proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await Promise.all([proxy?.close(), signer?.close()]);
  await Promise.all([http?.close(), target?.close(), facilitator?.close(), rpc?.close(), store?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const at = (host: string): string => `${host}:${target.port}`;
const checkUrl = (link: string, query = '', url = proxyUrl): string => `${url}/_/check?url=${encodeURIComponent(link)}${query}`;
// A POST check sends the check's header
const checkHeaders = (query: string): Record<string, string> => query.includes('method=POST') ? { 'x-anyfare-check': '1' } : {};
const checkOf = async (link: string, query = '', url = proxyUrl, headers: Record<string, string> = {}): Promise<Record<string, unknown>> => {
  const response = await fetch(checkUrl(link, query, url), { headers: { ...checkHeaders(query), ...headers } });
  expect(response.status).toBe(200);

  return await response.json() as Record<string, unknown>;
};
const requestsTo = (path: string) => target.requests.filter(request => request.path.split('?')[0] === path);
const paymentOf = async (accountId: string) => (await database.db.select().from(payments).where(eq(payments.buyerAccountId, accountId)))[0];
const legOf = async (paymentId: string) => (await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, paymentId)))[0];

/** A buyer account with a payment key and $1 of credits, written as the Platform API writes them. */
const buyer = async (): Promise<{ readonly accountId: string; readonly key: string }> => {
  const accountId = `acc_${randomUUID()}`;
  await createAccountRepository({ db: database.db }).create({ id: accountId, createdAt: systemClock.now() });
  const key = generateApiKey('payment', config.keyPrefixes);
  await createPaymentKeyRepository({ db: database.db }).insert({
    id: `key_${randomUUID()}`, accountId, keyHash: hashApiKey(key), label: undefined, createdAt: systemClock.now(), allowance: undefined, dailyBudget: 5_000_000n,
    maxPrice: undefined, expiresAt: undefined,
  });
  await createLedger({ db: database.db, clock: systemClock, ids: randomIdGenerator }).credit({ accountId, amount: 1_000_000n, reference: `credit-${accountId}` });

  return { accountId, key: key.expose() };
};
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');

/** Another proxy, on the same database, target, and Signer, with some dependencies of its own. */
const withProxy = async (overrides: Partial<ProxyDependencies>, work: (url: string) => Promise<void>): Promise<void> => {
  const other = createApp({
    config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, http, x402, mpp, claims: store,
    signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 }), ...overrides,
  });
  const { port } = await other.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  try {
    await work(`http://127.0.0.1:${port}`);
  }
  finally {
    await other.close();
  }
};

// A Redis of its own, so the caches are cold and the counters start at 0
const withOwnRedis = async (limits: Partial<PlatformConfig['rateLimits']>, work: (url: string) => Promise<void>): Promise<void> => {
  const own = await createTestRedis();
  try {
    await withProxy({ config: { ...config, rateLimits: { ...config.rateLimits, ...limits } }, redis: own }, work);
  }
  finally {
    await own.cleanup();
  }
};

describe('GET /_/check of a payable link', () => {
  it('answers an x402 link with what it asks, its 402 as it came with the shown headers only, the ways we take the quote, and its numbers', async () => {
    const link = `https://${at('api.target.test')}/v1/pools?limit=5`;
    const before = Date.now();

    const answer = await checkOf(link);

    expect(answer).toMatchObject({
      payable: true, method: 'GET', target: link,
      price: { amount: '0.001', currency: 'USD', asset: 'base-usdc', network: base },
      quote: { amount: '0.0011', fee: '0.0001', currency: 'USD' },
      link: `${config.urls.pay}/${at('api.target.test')}/v1/pools?limit=5`,
      protocol: 'x402',
    });
    expect(answer['asks']).toEqual({
      amount: '0.001', asset: 'USDC', network: base, paidWith: 'base', payTo: targetPayTo, scheme: 'exact', x402Version: 2, maxTimeoutSeconds: 60,
      description: 'Pools at /v1/pools', mimeType: 'application/json',
    });
    const upstream = answer['upstream'] as { status: number; headers: Record<string, string>; x402: unknown };
    expect(upstream.status).toBe(402);
    expect(Object.keys(upstream.headers).sort()).toEqual(['cache-control', 'content-type', 'date', 'payment-required']);
    expect(upstream.headers).toMatchObject({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    expect(upstream.x402).toEqual(required(`https://${at('api.target.test')}/v1/pools`, '/v1/pools'));
    expect(upstream).not.toHaveProperty('mpp');
    // At our quote: x402 on Base, MPP on Tempo, and credits. Solana's minimum is above it.
    expect(answer['payWith']).toEqual([
      { paidWith: 'base', protocol: 'x402', asset: 'USDC', amount: '0.0011', currency: 'USD' },
      { paidWith: 'tempo', protocol: 'mpp', asset: 'pathUSD', amount: '0.0011', currency: 'USD' },
      { paidWith: 'credits', protocol: 'credits', asset: 'Credits', amount: '0.0011', currency: 'USD' },
    ]);
    expect(answer['stats']).toEqual({ calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null });
    expect(Date.parse(answer['checkedAt'] as string)).toBeGreaterThanOrEqual(before - 1_000);
    expect(answer['ms']).toEqual(expect.any(Number));
    // Nothing else of the target's answer: not its other headers, not its body
    const text = JSON.stringify(answer);
    for (const kept of [cookie, secret, 'x-powered-by', 'never read'])
      expect(text).not.toContain(kept);
  });

  it('offers what the combined 402 of the same link offers, no more', async () => {
    const answer = await checkOf(`${at('api.target.test')}/v1/offered`);
    const unpaid = await fetch(`${proxyUrl}/${at('api.target.test')}/v1/offered`);
    const offered = JSON.parse(Buffer.from(unpaid.headers.get('payment-required')!, 'base64').toString('utf8')) as { accepts: { network: string; amount: string }[] };

    expect(unpaid.status).toBe(402);
    expect(offered.accepts.map(option => option.network)).toEqual([base]);
    expect(unpaid.headers.get('www-authenticate')).toMatch(/^Payment /);
    expect(((await unpaid.json()) as { credits: { price: string } }).credits.price).toBe('0.0011');
    expect((answer['payWith'] as { paidWith: string }[]).map(way => way.paidWith)).toEqual(['base', 'tempo', 'credits']);
  });

  it('answers an MPP link with the Tempo charge it asks for and its challenge decoded', async () => {
    const link = `https://${at('api.target.test')}/v1/mpp-quotes`;

    const answer = await checkOf(link);
    const sent = Challenge.deserialize(lastMppChallenge);

    expect(answer).toMatchObject({
      payable: true, method: 'GET', protocol: 'mpp',
      price: { amount: '0.002', currency: 'USD', asset: 'tempo-pathusd', network: tempoNetwork },
      quote: { amount: '0.0022', fee: '0.0002', currency: 'USD' },
    });
    expect(answer['asks']).toEqual({
      amount: '0.002', asset: 'pathUSD', network: tempoNetwork, paidWith: 'tempo', method: 'tempo', intent: 'charge', realm: 'api.target.test',
      recipient: targetRecipient, expires: sent.expires, description: 'Quotes',
    });
    const upstream = answer['upstream'] as { status: number; headers: Record<string, string>; mpp: unknown };
    expect(upstream.status).toBe(402);
    expect(Object.keys(upstream.headers).sort()).toEqual(['content-type', 'date', 'www-authenticate']);
    expect(upstream.headers['www-authenticate']).toBe(lastMppChallenge);
    expect(upstream.mpp).toEqual([JSON.parse(JSON.stringify(sent))]);
    expect(upstream).not.toHaveProperty('x402');
    expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it.each([
    ['an x402 link', '/v1/cached-x402'],
    ['an MPP link', '/v1/mpp-cached'],
  ])('answers a second check of %s from the cached quote, with the same asks and 402', async (_case, path) => {
    const link = `${at('api.target.test')}${path}`;

    const first = await checkOf(link);
    const second = await checkOf(link);

    expect(requestsTo(path)).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second['upstream']).toMatchObject({ status: 402 });
  });

  it('shows the endpoint\'s 30 days as the workers counted them, and zeros for one they keep no row for', async () => {
    const host = at('api.target.test');
    const numbers = endpointNumbersOf({ calls: 402, volume: 4_020_000n, buyers: 33, free: 4, p50Ms: 340, p95Ms: 800, ways: [{ paidWith: 'base', calls: 402 }] });
    const counted: StoredEndpoint = {
      hostHash: md5(host), pathHash: md5('/v1/counted'), path: '/v1/counted', method: 'GET', price: 1_100n,
      recent: { today: endpointNumbersOf(undefined), '7d': endpointNumbersOf(undefined), '30d': numbers }, daily: Array.from({ length: 14 }, () => 0),
    };
    await createStatsRepository({ db: database.db }).putEndpoints({ hostHashes: [md5(host)], endpoints: [counted], countedAt: systemClock.now(), timeoutMs: 5_000 });

    expect((await checkOf(`${host}/v1/counted?page=2`))['stats']).toEqual({ calls: 402, buyers: 33, volume: '4.02', successRate: numbers.successRate, p50Ms: 340 });
    expect((await checkOf(`${host}/v1/uncounted`))['stats']).toEqual({ calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null });
  });

  it('still answers the quote when the numbers can\'t be read: without them; the read has a statement timeout of its own', async () => {
    const asked: unknown[][] = [];
    const failing = async (...args: unknown[]): Promise<never> => {
      asked.push(args);
      throw new Error('Connection terminated unexpectedly');
    };
    await withProxy({ stats: { endpoint: failing } }, async url => {
      const answer = await checkOf(`${at('api.target.test')}/v1/no-numbers`, '', url);

      expect(answer).toMatchObject({ payable: true, stats: null });
    });
    expect(asked).toEqual([[at('api.target.test'), '/v1/no-numbers', { timeoutMs: 1_000 }]]);
  });

  it('lets a paid call after a check pay and settle on the check\'s quote, without a probe of its own', async () => {
    const { accountId, key } = await buyer();

    expect(await checkOf(`${at('api.target.test')}/v1/after-check`)).toMatchObject({ payable: true, quote: { amount: '0.0011' } });
    const paid = await fetch(`${proxyUrl}/${at('api.target.test')}/v1/after-check`, { headers: { authorization: `Bearer ${key}` } });

    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ paid: '/v1/after-check' });
    expect(paid.headers.get('anyfare-receipt')).toContain('amount="0.0011"');
    // The check's probe, and the paid retry
    expect(requestsTo('/v1/after-check').map(request => request.headers['payment-signature'] === undefined)).toEqual([true, false]);
    await expect.poll(async () => (await database.db.select().from(payments).where(eq(payments.buyerAccountId, accountId)))[0]?.status).toBe('captured');
    const [row] = await database.db.select().from(payments).where(eq(payments.buyerAccountId, accountId));
    expect((await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, row!.id)))[0])
      .toMatchObject({ status: 'settled', amount: 1_000n, payTo: targetPayTo });
  });
});

describe('GET /_/check and another buyer\'s call', () => {
  // What a buyer sends with a routed call, that its target echoes into the 402 of its probe
  const apiKey = 'buyer-key-5f3a9c';
  const bodyText = 'buyer-body-7d2e1b';
  const buyerSends = (method: string) => ({
    method, headers: { 'x-api-key': apiKey, ...method === 'POST' ? { 'content-type': 'text/plain' } : {} }, ...method === 'POST' ? { body: bodyText } : {},
  });
  // Calls from two IPs, as the proxies in front tell them
  const fromIp = (ip: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...init.headers as Record<string, string>, 'x-forwarded-for': ip } });

  it.each(['GET', 'POST'])('never shows the 402 a routed %s made for its buyer: the check probes on its own, with nothing of the buyer\'s', async method => {
    const path = `/v1/echo-routed-${method.toLowerCase()}`;
    const link = `${at('api.target.test')}${path}`;
    await withProxy({ trustProxy: '127.0.0.1' }, async url => {
      const routed = await fetch(`${url}/${link}`, fromIp('198.51.100.1', buyerSends(method)));
      expect(routed.status).toBe(402);
      expect(requestsTo(path)[0]!.headers['x-api-key']).toBe(apiKey);

      const response = await fetch(checkUrl(link, `&method=${method}`, url), fromIp('198.51.100.2', { headers: checkHeaders(`&method=${method}`) }));
      const answer = await response.json() as Record<string, unknown>;

      expect(answer).toMatchObject({ payable: true, method, asks: { description: 'For anyone' } });
      const text = JSON.stringify(answer);
      for (const secret of [apiKey, bodyText])
        expect(text).not.toContain(secret);
      // The check's own probe: no buyer header, no body
      const probes = requestsTo(path);
      expect(probes).toHaveLength(2);
      expect(probes[1]!.headers['x-api-key']).toBeUndefined();
      expect(probes[1]!.body.length).toBe(0);
    });
  });

  it('leaves a paid call after a check with the quote and payment it has without one', async () => {
    const baseline = await buyer();
    const after = await buyer();
    const paidCall = (path: string, key: string) => fetch(`${proxyUrl}/${at('api.target.test')}${path}`, {
      ...buyerSends('POST'), headers: { ...buyerSends('POST').headers, authorization: `Bearer ${key}` },
    });

    const without = await paidCall('/v1/echo-baseline', baseline.key);
    expect(await checkOf(`${at('api.target.test')}/v1/echo-checked`, '&method=POST')).toMatchObject({ payable: true });
    const withCheck = await paidCall('/v1/echo-checked', after.key);

    expect([without.status, withCheck.status]).toEqual([200, 200]);
    expect(withCheck.headers.get('anyfare-receipt')?.replace(/id="[^"]+"/, '')).toBe(without.headers.get('anyfare-receipt')?.replace(/id="[^"]+"/, ''));
    await expect.poll(async () => [(await paymentOf(baseline.accountId))?.status, (await paymentOf(after.accountId))?.status]).toEqual(['captured', 'captured']);
    const [one, two] = [await paymentOf(baseline.accountId), await paymentOf(after.accountId)];
    expect({ amount: two!.amount, fee: two!.fee }).toEqual({ amount: one!.amount, fee: one!.fee });
    const legs = [await legOf(one!.id), await legOf(two!.id)].map(leg => ({ amount: leg!.amount, payTo: leg!.payTo, status: leg!.status, protocol: leg!.protocol }));
    expect(legs[1]).toEqual(legs[0]);
    // The paid retry still carries the buyer's own key and body
    const retry = requestsTo('/v1/echo-checked').at(-1)!;
    expect([retry.headers['x-api-key'], retry.body.toString('utf8')]).toEqual([apiKey, bodyText]);
  });

  it('leaves a paid call unaffected when the check can\'t cache its quote', async () => {
    const paying = await buyer();
    const refusingCheckWrites: Redis = {
      ...redis,
      client: new Proxy(redis.client, {
        get: (client, name) => {
          if (name === 'set') {
            return async (key: string, value: string, options?: { readonly condition?: string }) => {
              if (key.startsWith(`${redis.prefix}check:`) || options?.condition === 'NX')
                throw new Error('READONLY You can\'t write against a read only replica.');

              return client.set(key, value, options as never);
            };
          }
          const value = Reflect.get(client, name, client) as unknown;

          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(client) : value;
        },
      }),
    };

    await withProxy({ redis: refusingCheckWrites }, async url => {
      expect(await checkOf(`${at('api.target.test')}/v1/uncachable`, '', url)).toMatchObject({ payable: true, quote: { amount: '0.0011' } });
      const paid = await fetch(`${url}/${at('api.target.test')}/v1/uncachable`, { headers: { authorization: `Bearer ${paying.key}` } });

      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ paid: '/v1/uncachable' });
    });
    await expect.poll(async () => (await paymentOf(paying.accountId))?.status).toBe('captured');
    // The check's probe, the call's own, and the paid retry
    expect(requestsTo('/v1/uncachable').map(request => request.headers['payment-signature'] === undefined)).toEqual([true, true, false]);
  });
});

describe('GET /_/check\'s numbers and the database pool', () => {
  it('reads them on at most two connections, and answers at once without them while their table is locked', async () => {
    const other = createPostgres({ url: database.url, logger: createLogger({ level: 'silent' }) });
    let unlock!: () => void;
    const unlocked = new Promise<void>(resolve => {
      unlock = resolve;
    });
    let isLocked!: () => void;
    const locked = new Promise<void>(resolve => {
      isLocked = resolve;
    });
    const holding = other.db.transaction(async tx => {
      await tx.execute(sql`lock table stats_endpoints in access exclusive mode`);
      isLocked();
      await unlocked;
    });
    try {
      await locked;
      await withProxy({}, async url => {
        let most = 0;
        let watching = true;
        const watch = (async () => {
          while (watching) {
            const { rows: [row] } = await other.db.execute<{ waiting: number }>(sql`select count(*)::int as waiting from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock' and query ilike '%stats_endpoints%'`);
            most = Math.max(most, row!.waiting);
            await sleep(20);
          }
        })();
        const started = Date.now();

        const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => checkOf(`${at('api.target.test')}/v1/locked-${index}`, '', url)));

        const tookMs = Date.now() - started;
        watching = false;
        await watch;
        expect(answers.map(answer => [answer['payable'], answer['stats']])).toEqual(Array.from({ length: 20 }, () => [true, null]));
        expect(tookMs).toBeLessThan(3_000);
        expect(most).toBeGreaterThanOrEqual(1);
        expect(most).toBeLessThanOrEqual(2);
      });
    }
    finally {
      unlock();
      await holding;
      await other.close();
    }
  });
});

describe('GET /_/check with a method', () => {
  it('probes with the method and no body: a link paid only with POST is not payable with GET, and payable with POST', async () => {
    const link = `${at('api.target.test')}/v1/post-only`;

    const viaGet = await checkOf(link);
    const viaPost = await checkOf(link, '&method=POST');

    expect(viaGet).toEqual({
      payable: false, method: 'GET', reason: 'not_payable', detail: 'no_payment_asked', upstream: { status: 405 },
      message: 'The link answered 405 without asking for a payment. Anyfare routes paid calls only.',
    });
    expect(viaPost).toMatchObject({ payable: true, method: 'POST', protocol: 'x402', quote: { amount: '0.0011' } });
    expect(requestsTo('/v1/post-only').map(request => [request.method, request.body.length])).toEqual([['GET', 0], ['POST', 0]]);
  });

  it('shares the quote with a routed call of the same method: the routed POST after a check probes nothing', async () => {
    const link = `${at('api.target.test')}/v1/post-only-shared`;
    expect(await checkOf(link, '&method=POST')).toMatchObject({ payable: true, method: 'POST' });

    const unpaid = await fetch(`${proxyUrl}/${link}`, { method: 'POST', body: '{"q":1}', headers: { 'content-type': 'application/json' } });

    expect(unpaid.status).toBe(402);
    expect(((await unpaid.json()) as { credits: { price: string } }).credits.price).toBe('0.0011');
    expect(requestsTo('/v1/post-only-shared')).toHaveLength(1);
  });

  // A check anyone can trigger from a link never sends a bodyless PUT, PATCH or DELETE
  it('refuses a POST check without its header with 400, naming the header, before any request leaves; GET needs none', async () => {
    const before = target.requests.length;

    const bare = await fetch(checkUrl(`${at('api.target.test')}/v1/post-only-bare`, '&method=POST'));
    const wrong = await fetch(checkUrl(`${at('api.target.test')}/v1/post-only-bare`, '&method=POST'), { headers: { 'x-anyfare-check': 'yes' } });

    for (const response of [bare, wrong]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: 'invalid_request', message: 'A check with method=POST needs the header X-Anyfare-Check: 1' } });
    }
    expect(target.requests.length).toBe(before);
    expect(await checkOf(`${at('api.target.test')}/v1/pools-plain`)).toMatchObject({ payable: true, method: 'GET' });
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'post', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'GET,POST', ''])('refuses the method %j with 400, before any request leaves', async method => {
    const before = target.requests.length;

    const response = await fetch(checkUrl(`${at('api.target.test')}/v1/pools`, `&method=${encodeURIComponent(method)}`));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    expect(target.requests.length).toBe(before);
  });
});

describe('GET /_/check of a link it won\'t quote', () => {
  const refusalOf = async (link: string, url = proxyUrl) => {
    const answer = await checkOf(link, '', url);
    expect(answer).toMatchObject({ payable: false, method: 'GET' });
    expect(answer['message']).toMatch(/^[A-Z].*\.$/);

    return answer;
  };

  it('says the link isn\'t a paid link, with the status it answered', async () => {
    expect(await refusalOf(`${at('api.target.test')}/v1/free`)).toMatchObject({ reason: 'not_payable', detail: 'no_payment_asked', upstream: { status: 200 } });
  });

  it('says a paid link asks for no payment we make, or for none it can read', async () => {
    expect(await refusalOf(`${at('api.target.test')}/v1/gateway-only`)).toMatchObject({ reason: 'unsupported_payment', detail: 'no_option', upstream: { status: 402 } });
    expect(await refusalOf(`${at('api.target.test')}/v1/no-challenge`)).toMatchObject({ reason: 'unsupported_payment', detail: 'no_challenge', upstream: { status: 402 } });
  });

  it('says a dead link didn\'t resolve, refused the connection, or didn\'t answer in time', async () => {
    expect(await refusalOf(`${at('nowhere.target.test')}/v1/pools`)).toMatchObject({ reason: 'upstream_unavailable', detail: 'dns' });
    expect(await refusalOf(`refused.target.test:${closedPort}/v1/pools`)).toMatchObject({ reason: 'upstream_unavailable', detail: 'refused' });
    const impatient = new OutboundHttp({
      ownHosts: config.ownHosts, resolver: createFakeResolver({ 'slow.target.test': '127.0.0.1' }), addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
      ca: target.ca, connectTimeoutMs: 1_000, totalTimeoutMs: 300,
    });
    try {
      await withProxy({ http: impatient }, async url => {
        expect(await refusalOf(`${at('slow.target.test')}/v1/hangs`, url)).toMatchObject({ reason: 'upstream_unavailable', detail: 'timeout' });
      });
    }
    finally {
      await impatient.close();
    }
  });

  it('refuses a blocklisted host, a host that opted out, and our own hosts, by name or by address, and sends a blocklisted one nothing', async () => {
    await createRoutingRepository({ db: database.db, clock: systemClock }).block({ host: 'blocked.target.test', reason: 'abuse' });
    const before = target.requests.length;

    expect(await refusalOf(`${at('blocked.target.test')}/v1/pools`)).toMatchObject({ reason: 'host_not_allowed', detail: 'blocklisted' });
    expect(target.requests.length).toBe(before);
    expect(await refusalOf(`${at('optout.target.test')}/v1/pools`)).toMatchObject({ reason: 'host_not_allowed', detail: 'opted_out' });
    for (const link of ['https://www.anyfare.test/v1/x', 'a.pay.anyfare.test/v1/x', `https://${ourAddress}/v1/x`, `${at('ours.target.test')}/v1/x`])
      expect(await refusalOf(link), link).toMatchObject({ reason: 'host_not_allowed', detail: 'own_host' });
  });

  it('refuses a private address written in the link, and names no address', async () => {
    for (const link of ['https://10.0.0.1/v1/pools', 'http://127.0.0.1:8080/v1/pools', 'https://[::1]/v1/pools', 'https://169.254.169.254/latest']) {
      const answer = await refusalOf(link);

      expect(answer, link).toMatchObject({ reason: 'host_not_allowed', detail: 'private_address' });
      for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', ourAddress])
        expect(JSON.stringify(answer)).not.toContain(address);
    }
  });

  it('answers a name that resolves only to a private address as one that doesn\'t resolve: it never tells which internal names exist', async () => {
    const internal = await refusalOf(`${at('private.target.test')}/v1/pools`);
    const unknown = await refusalOf(`${at('nowhere.target.test')}/v1/pools`);

    expect(internal).toEqual(unknown);
    expect(internal).toMatchObject({ reason: 'upstream_unavailable', detail: 'dns' });
    expect(JSON.stringify(internal)).not.toContain('10.0.0.1');
    expect(requestsTo('/v1/pools').filter(request => request.servername === 'private.target.test')).toEqual([]);
  });

  it('says a host answered with headers too large to read', async () => {
    expect(await refusalOf(`${at('api.target.test')}/v1/huge-headers`)).toMatchObject({ reason: 'upstream_unavailable', detail: 'headers_too_large' });
  });

  it('says a link isn\'t a URL, or names no host we call', async () => {
    expect(await refusalOf('')).toMatchObject({ reason: 'invalid_target', detail: 'not_a_url' });
    expect(await refusalOf('https://exa mple.com/x')).toMatchObject({ reason: 'invalid_target', detail: 'not_a_url' });
    expect(await refusalOf('localhost/v1/pools')).toMatchObject({ reason: 'invalid_target', detail: 'invalid_host' });
    expect(await refusalOf('https://8.8.8.8/v1/pools')).toMatchObject({ reason: 'invalid_target', detail: 'ip_address' });
  });
});

describe('GET /_/check\'s limits', () => {
  it('counts every check against the per-IP check limit, whatever its method', async () => {
    await withOwnRedis({ unpaidIp: { requests: 2, windowSeconds: 60 } }, async url => {
      expect((await fetch(checkUrl(`${at('api.target.test')}/v1/limited`, '', url))).status).toBe(200);
      expect((await fetch(checkUrl(`${at('api.target.test')}/v1/limited`, '&method=POST', url), { headers: checkHeaders('&method=POST') })).status).toBe(200);
      const sent = target.requests.length;

      const refused = await fetch(checkUrl(`${at('api.target.test')}/v1/limited-again`, '', url));

      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(target.requests.length).toBe(sent);
    });
  });

  it.each(['GET', 'POST'])('counts a %s probe against the per-IP probe limit before any request leaves; a cached quote costs nothing', async method => {
    await withOwnRedis({ probeIp: { requests: 1, windowSeconds: 60 } }, async url => {
      const query = `&method=${method}`;
      expect(await checkOf(`${at('api.target.test')}/v1/post-only-probed`, query, url)).toMatchObject({ payable: method === 'POST' });
      if (method === 'POST')
        expect(await checkOf(`${at('api.target.test')}/v1/post-only-probed`, query, url)).toMatchObject({ payable: true });
      const sent = target.requests.length;

      const refused = await fetch(checkUrl(`${at('optout.target.test')}/v1/post-only-other`, query, url), { headers: checkHeaders(query) });

      expect(refused.status).toBe(429);
      expect(target.requests.length).toBe(sent);
    });
  });
});

describe('GET /_/check from a browser', () => {
  it('is readable from any origin without credentials, and answers its preflight', async () => {
    const answer = await fetch(checkUrl(`${at('api.target.test')}/v1/pools`), { headers: { origin: 'https://site.example' } });
    const preflight = await fetch(checkUrl(`${at('api.target.test')}/v1/pools`), {
      method: 'OPTIONS', headers: { origin: 'https://site.example', 'access-control-request-method': 'GET' },
    });

    expect(answer.status).toBe(200);
    expect(preflight.status).toBe(204);
    for (const response of [answer, preflight]) {
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    }
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET');
  });

  it('lets only our website\'s script add the POST check\'s header: no other site\'s preflight grants it', async () => {
    const preflightFrom = (origin: string) => fetch(checkUrl(`${at('api.target.test')}/v1/pools`, '&method=POST'), {
      method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-anyfare-check' },
    });

    const other = await preflightFrom('https://site.example');
    const ours = await preflightFrom(new URL(config.urls.website).origin);

    expect([other.status, ours.status]).toEqual([204, 204]);
    expect(other.headers.get('access-control-allow-headers')).toBeNull();
    expect(ours.headers.get('access-control-allow-headers')).toBe('X-Anyfare-Check');
    expect(other.headers.get('vary')).toContain('Origin');
    // A routed link's preflight is the routing one, as before
    const routed = await fetch(`${proxyUrl}/${at('api.target.test')}/v1/pools`, {
      method: 'OPTIONS', headers: { origin: 'https://site.example', 'access-control-request-method': 'POST' },
    });
    expect(routed.headers.get('access-control-allow-headers')).toBe('Authorization, PAYMENT-SIGNATURE, X-PAYMENT, Content-Type');
    expect(routed.headers.get('access-control-allow-methods')).toBe('GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  });
});
