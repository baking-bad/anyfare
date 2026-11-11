import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, systemClock, type Server } from '@anyfare/common';
import { findAsset, generateApiKey, hashApiKey, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import {
  createAccountRepository, createLedger, createPaymentKeyRepository, createRedisReplayStore, createRoutingRepository, payments, routedEndpoints,
  type RedisReplayStore,
} from '@anyfare/db';
import { createFacilitators, initializeX402, type X402Setup } from '@anyfare/payments';
import { createApp as createSigner } from '@anyfare/signer';
import {
  createFakeClock, createFakeResolver, createTestDatabase, createTestRedis, encodeBase58, nearFacilitatorOff, startFakeFacilitator, startFakeUpstream,
  type FakeFacilitator, type FakeUpstream, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp, type ProxyDependencies } from '../../src/app.js';
import { checkListingDefaults, createNewHostLimit, newHostsPerClient } from '../../src/routing/listing.js';
import { createSignerClient } from '../../src/routing/support.js';

// A payable check lists its endpoint through the registrar, without the answer waiting for it: host and path
// only, under the caps and the per-client limit, and nothing for a link it won't quote. The internal API here
// lists through the routing repository, as the real one does, or stalls.

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const internalSecret = 'internal-secret-for-the-listing-tests-0123456789';
const targetPayTo = '0x3333333333333333333333333333333333333333';
const ourAddress = '203.0.113.7';
const newHosts = Array.from({ length: 21 }, (_, index) => `new-${index}.listing.test`);
const targetHosts = [
  'api.target.test', 'blocked.target.test', 'optout.target.test', 'private.target.test', 'nowhere.target.test', 'ours.target.test', 'a.blocked-parent.test',
  'stall-read.target.test', 'stall-redis.target.test', ...newHosts,
];
const generous = { requests: 100_000, windowSeconds: 60 };
const signerWallet = privateKeyToAccount(generatePrivateKey());

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let target: FakeUpstream;
let facilitator: FakeFacilitator;
let store: RedisReplayStore;
let http: OutboundHttp;
let x402: X402Setup;
let signer: Server;
let signerUrl: string;
let usdc: string;
// The internal API: what it was sent, and whether it answers
let internal: HttpServer;
let internalUrl: string;
let stalled = false;
const sent: Record<string, unknown>[] = [];

const required = (url: string) => ({
  x402Version: 2, error: 'Payment required', resource: { url, description: 'Pools', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: base, amount: '1000', asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }] as PaymentRequirements[],
});

const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(chunk as Buffer);

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
};

beforeAll(async () => {
  [database, redis, target, facilitator] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: targetHosts }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        urls: { website: 'https://www.anyfare.test', api: 'https://api.anyfare.test', pay: 'https://pay.anyfare.test' },
        ownHosts: [ourAddress],
        routingFeeBps: 1000,
        rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous, probeIp: generous },
        facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff],
        signer: { maxPerCall: '0.5', maxPerNetworkPerDay: '100' },
      })).toString('base64'),
    },
  });
  usdc = findAsset(config, 'base-usdc')!.address;

  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    if (path === '/.well-known/anyfare.json') {
      response.writeHead(request.servername === 'optout.target.test' ? 200 : 404, { 'content-type': 'application/json' }).end('{"routing":false}');
      return;
    }
    if (path === '/v1/free') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (path === '/v1/no-challenge') {
      response.writeHead(402, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (typeof request.headers['payment-signature'] !== 'string') {
      response.writeHead(402, { 'payment-required': encodePaymentRequiredHeader(required(`https://${request.servername}:${target.port}${path}`) as never) }).end('{}');
      return;
    }
    const settled = encodePaymentResponseHeader({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: base, payer: signerWallet.address } as never);
    response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled }).end('{"paid":true}');
  });

  // Lists as the internal API does, through the routing repository, unless stalled: then it never answers
  const routing = createRoutingRepository({ db: database.db, clock: systemClock });
  internal = createServer((request, response) => {
    void (async () => {
      const body = await bodyOf(request);
      sent.push(body);
      if (stalled || request.headers['x-internal-secret'] !== internalSecret)
        return;
      const result = await routing.registerEndpoint({
        host: body['host'] as string, path: body['path'] as string, lastPrice: BigInt(Math.round(Number(body['quote']) * 1_000_000)),
        ...body['kind'] === 'checked' ? { checked: { method: body['method'] as 'GET' | 'POST', mayAddHost: body['mayAddHost'] === true } } : {},
      });
      response.writeHead(result === 'created' ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }));
    })();
  });
  await new Promise<void>(resolve => internal.listen(0, '127.0.0.1', resolve));
  internalUrl = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;

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
  store = createRedisReplayStore({ redis });
  signer = createSigner({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet } });
  signerUrl = `http://127.0.0.1:${(await signer.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
  x402 = await initializeX402({
    config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: systemClock }), timeoutMs: 5_000,
  });
  await createRoutingRepository({ db: database.db, clock: systemClock }).block({ host: 'blocked.target.test', reason: 'abuse' });
  await createRoutingRepository({ db: database.db, clock: systemClock }).block({ host: 'blocked-parent.test', reason: 'abuse' });
});

afterAll(async () => {
  await signer?.close();
  await Promise.all([http?.close(), target?.close(), facilitator?.close(), store?.close(), internal && new Promise(resolve => internal.close(resolve))]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const at = (host: string): string => `${host}:${target.port}`;

// A check here waits for its listing's decision, however slow the machine: what a test asserts is the decision. The
// tests of the check's own bound on that wait set it back to its 150 ms.
const decisionMs = 10_000;

/** A proxy with the internal API, a Redis of its own so its limits start at 0, and some dependencies of its own. */
const withProxy = async (overrides: Partial<ProxyDependencies>, work: (url: string, own: TestRedis) => Promise<void>): Promise<void> => {
  const own = await createTestRedis();
  const proxy = createApp({
    config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis: own, http, x402, claims: store, trustProxy: '127.0.0.1',
    signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
    internalApi: { url: internalUrl, secret: Secret.from(internalSecret) }, listingAnswerMs: decisionMs, ...overrides,
  });
  const { port } = await proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  try {
    await work(`http://127.0.0.1:${port}`, own);
  }
  finally {
    await proxy.close();
    await own.cleanup();
  }
};

const checkOf = async (url: string, link: string, ip = '198.51.100.20'): Promise<Record<string, unknown>> => {
  const response = await fetch(`${url}/_/check?url=${encodeURIComponent(link)}`, { headers: { 'x-forwarded-for': ip } });
  expect(response.status).toBe(200);

  return await response.json() as Record<string, unknown>;
};
const sentFor = (host: string) => sent.filter(body => body['host'] === host);
const rowsOf = (host: string) => database.db.select().from(routedEndpoints).where(eq(routedEndpoints.host, host));
// The listing goes after the answer: until it lands, as slow as the machine is
const landed = async (count: () => number | Promise<number>, expected: number): Promise<void> => {
  await expect.poll(count, { timeout: 15_000, interval: 50 }).toBe(expected);
};

describe('a payable check\'s listing', () => {
  it('lists the host and the path, never the query, with our quote and the method; a repeat within a minute writes nothing, one after it the time', async () => {
    const host = at('api.target.test');
    const clock = createFakeClock(systemClock.now());
    await withProxy({ clock }, async url => {
      const first = await checkOf(url, `https://${host}/v1/listed?token=secret-in-query`);
      await landed(async () => (await rowsOf(host)).length, 1);
      const repeats = [await checkOf(url, `${host}/v1/listed`), await checkOf(url, `${host}/v1/listed?page=2`)];
      clock.advance(60_000);
      const later = await checkOf(url, `${host}/v1/listed`);
      await landed(() => sentFor(host).length, 2);

      expect([first['payable'], first['listed'], ...repeats.map(answer => answer['listed']), later['listed']]).toEqual([true, true, true, true, true]);
      // A host in the pool is counted for its client at each listing, the refresh too: once a day, at no more cost
      expect(sentFor(host)).toEqual([
        { host, path: '/v1/listed', quote: '0.0011', kind: 'checked', method: 'GET', mayAddHost: true },
        { host, path: '/v1/listed', quote: '0.0011', kind: 'checked', method: 'GET', mayAddHost: true },
      ]);
      const [row] = await rowsOf(host);
      expect(row).toMatchObject({ path: '/v1/listed', status: 'checked', lastPrice: 1_100n, checkMethod: 'GET', feeBps: null });
      expect(JSON.stringify(sent)).not.toContain('secret-in-query');
    });
  });

  it('lists nothing for a link it won\'t quote: not paid, dead, blocked, private, opted out, ours, or asking for a payment it can\'t make', async () => {
    await withProxy({}, async url => {
      const before = sent.length;
      const links = [
        `${at('api.target.test')}/v1/free`, `${at('nowhere.target.test')}/v1/x`, `${at('blocked.target.test')}/v1/x`, `${at('private.target.test')}/v1/x`,
        'https://10.0.0.1/v1/x', `${at('optout.target.test')}/v1/x`, `${at('ours.target.test')}/v1/x`, 'https://pay.anyfare.test/v1/x',
        `${at('api.target.test')}/v1/no-challenge`,
      ];

      const answers = await Promise.all(links.map(link => checkOf(url, link)));
      // Long enough for a listing to have gone out
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(answers.map(answer => answer['payable'])).toEqual(links.map(() => false));
      expect(answers.every(answer => !('listed' in answer))).toBe(true);
      expect(sent.length).toBe(before);
    });
  });

  it('lists nothing for a path of 3,000 characters, and still answers it payable', async () => {
    await withProxy({}, async url => {
      const before = sent.length;

      const answer = await checkOf(url, `${at('api.target.test')}/${'p'.repeat(2_999)}`);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(answer).toMatchObject({ payable: true, listed: false });
      expect(sent.length).toBe(before);
    });
  });

  it('lists 20 new hosts a day from one client and none after, and still answers the 21st payable', async () => {
    await withProxy({}, async url => {
      const answers = [];
      for (const host of newHosts)
        answers.push(await checkOf(url, `${at(host)}/v1/x`, '198.51.100.40'));
      await landed(() => newHosts.filter(host => sentFor(at(host)).length > 0).length, 20);
      // Another client lists the 21st
      const other = await checkOf(url, `${at(newHosts[20]!)}/v1/x`, '198.51.100.41');
      await landed(() => sentFor(at(newHosts[20]!)).length, 1);

      expect(answers.map(answer => [answer['payable'], answer['listed']])).toEqual([...Array.from({ length: 20 }, () => [true, true]), [true, false]]);
      expect(other).toMatchObject({ payable: true, listed: true });
    });
  });

  it('routes a host whose parent domain is blocked, and lists nothing of it: routing refuses only the exact name', async () => {
    await withProxy({}, async url => {
      const before = sent.length;

      const answer = await checkOf(url, `${at('a.blocked-parent.test')}/v1/x`);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(answer).toMatchObject({ payable: true, listed: false });
      expect(sent.length).toBe(before);
    });
  });

  it.each([
    ['the database\'s read', 'read'],
    ['Redis', 'redis'],
  ])('answers within its usual time while %s stalls: listed false, and nothing waits on it', async (_case, stalled) => {
    const never = new Promise<never>(() => undefined);
    // The check's own bound on its wait for the listing
    const overrides: Partial<ProxyDependencies> = stalled === 'read'
      ? { listing: { endpointListing: () => never }, listingAnswerMs: checkListingDefaults.answerMs }
      : { newHostLimit: { admit: () => never }, listingAnswerMs: checkListingDefaults.answerMs };
    await withProxy(overrides, async url => {
      const started = performance.now();
      // A host no check listed yet: it would join the pool, so its client's limit is read
      const answer = await checkOf(url, `${at(`stall-${stalled}.target.test`)}/v1/x`);
      const tookMs = performance.now() - started;

      expect(answer).toMatchObject({ payable: true, listed: false });
      // The probe, the stats, and the listing's 150 ms at most
      expect(tookMs).toBeLessThan(1_000);
    });
  });

  it('never waits for the listing: with the internal API stalled, the check answers in normal time', async () => {
    stalled = true;
    try {
      await withProxy({}, async url => {
        const started = performance.now();
        const answer = await checkOf(url, `${at('api.target.test')}/v1/stalled`);
        const tookMs = performance.now() - started;

        expect(answer).toMatchObject({ payable: true, listed: true });
        expect(tookMs).toBeLessThan(1_000);
        await landed(() => sentFor(at('api.target.test')).filter(body => body['path'] === '/v1/stalled').length, 1);
      });
    }
    finally {
      stalled = false;
    }
  });
});

describe('the new hosts\' limit in Redis', () => {
  it('admits 20 hosts a client a day, each once whatever came of it, and no 21st; another client has its own', async () => {
    const own = await createTestRedis();
    try {
      const limit = createNewHostLimit({ redis: own });

      const first = await Promise.all(Array.from({ length: 25 }, (_, index) => limit.admit('198.51.100.9', `host-${index}.target.test`)));
      const again = await limit.admit('198.51.100.9', 'host-0.target.test');
      const other = await limit.admit('2001:db8:1:2::/64', 'host-24.target.test');
      const key = `${own.prefix}rl:proxy:newHosts:198.51.100.9`;

      expect(first.filter(Boolean)).toHaveLength(newHostsPerClient);
      expect(again).toBe(first[0]);
      // While a racing 21st is in the set for a moment, a host it added already still passes, and stays
      const admittedOne = first.findIndex(Boolean);
      await own.client.sAdd(`${own.prefix}rl:proxy:newHosts:198.51.100.9`, 'racing-21st');
      expect(await limit.admit('198.51.100.9', `host-${admittedOne}.target.test`)).toBe(true);
      await own.client.sRem(`${own.prefix}rl:proxy:newHosts:198.51.100.9`, 'racing-21st');
      expect(other).toBe(true);
      expect(await own.client.sCard(key)).toBe(newHostsPerClient);
      // Gone a day after the first
      expect(await own.client.ttl(key)).toBeGreaterThan(86_000);
    }
    finally {
      await own.cleanup();
    }
  });
});

describe('a paid call and a check\'s listing', () => {
  /** A buyer account with a payment key and $1 of credits. */
  const buyer = async (): Promise<string> => {
    const accountId = `acc_${randomUUID()}`;
    await createAccountRepository({ db: database.db }).create({ id: accountId, createdAt: systemClock.now() });
    const key = generateApiKey('payment', config.keyPrefixes);
    await createPaymentKeyRepository({ db: database.db }).insert({
      id: `key_${randomUUID()}`, accountId, keyHash: hashApiKey(key), label: undefined, createdAt: systemClock.now(), allowance: undefined, dailyBudget: 5_000_000n,
      maxPrice: undefined, expiresAt: undefined,
    });
    await createLedger({ db: database.db, clock: systemClock, ids: randomIdGenerator }).credit({ accountId, amount: 1_000_000n, reference: `credit-${accountId}` });

    return key.expose();
  };
  const paidCall = async (url: string, path: string) => {
    const key = await buyer();
    const response = await fetch(`${url}/${at('api.target.test')}${path}`, { headers: { authorization: `Bearer ${key}` } });
    expect(response.status).toBe(200);
    const receipt = response.headers.get('anyfare-receipt')!;
    const id = /id="([^"]+)"/.exec(receipt)![1]!;
    await expect.poll(async () => (await database.db.select().from(payments).where(eq(payments.id, id)))[0]?.status).toBe('captured');
    const [payment] = await database.db.select().from(payments).where(eq(payments.id, id));

    return { amount: payment!.amount, fee: payment!.fee, receipt: receipt.replace(/id="[^"]+"/, '') };
  };

  it('quotes and charges a routed call the same before and after a check lists its endpoint', async () => {
    await withProxy({}, async (url, own) => {
      const host = at('api.target.test');
      const before = await paidCall(url, '/v1/fee-same');
      // The paid call registered it; a fresh endpoint a check lists first, then a paid call reaches
      expect(await checkOf(url, `${host}/v1/fee-checked`)).toMatchObject({ payable: true, listed: true, quote: { amount: '0.0011', fee: '0.0001' } });
      await landed(async () => (await rowsOf(host)).filter(row => row.path === '/v1/fee-checked').length, 1);
      // Past the cached quotes, so the paid call probes, and reads the endpoint's fee from its listed row
      for await (const keys of own.client.scanIterator({ MATCH: `${own.prefix}*` })) {
        const quotes = keys.filter(key => /:(?:quote|check):/.test(key));
        if (quotes.length > 0)
          await own.client.unlink(quotes);
      }
      const probes = target.requests.filter(request => request.path === '/v1/fee-checked').length;
      const after = await paidCall(url, '/v1/fee-checked');

      // Its own probe, then the paid retry
      expect(target.requests.filter(request => request.path === '/v1/fee-checked').length).toBe(probes + 2);

      expect(after).toEqual(before);
      expect((await rowsOf(host)).find(row => row.path === '/v1/fee-checked')).toMatchObject({ feeBps: null });
      // Its first billable call made it paid
      await landed(async () => (await rowsOf(host)).filter(row => row.path === '/v1/fee-checked' && row.status === 'paid').length, 1);
    });
  });
});
