import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, Secret, type MicroUsd } from '@anyfare/common';
import type { Redis } from '@anyfare/db';
import { createFakeResolver, startFakeUpstream, type FakeUpstream } from '@anyfare/testing';

import {
  createEndpointRegistrar, createOptOutCheck, createSignerClient, isOwnHost, optOutTtlSeconds, ownDomainsOf, SignerUnavailableError, type SignInput,
} from '../../src/routing/support.js';

const signerSecret = 'signer-secret-for-the-support-tests-0123456789';
const internalSecret = 'internal-secret-for-the-support-tests-0123456789';

const signInput: SignInput = {
  requestId: 'req-support-1', quoteId: 'pay_1', protocol: 'x402', requirement: {} as never, resource: undefined, url: 'https://api.target.test/v1',
  quotedPrice: 1_000n as MicroUsd,
};

const signerAt = (fetch: typeof globalThis.fetch) =>
  createSignerClient({ url: 'http://signer.internal:8083/', secret: Secret.from(signerSecret), timeoutMs: 1_000, fetch });

const refusal = async (fetch: typeof globalThis.fetch): Promise<SignerUnavailableError> => {
  try {
    await signerAt(fetch).sign(signInput);
  }
  catch (error) {
    if (error instanceof SignerUnavailableError)
      return error;
    throw error;
  }
  throw new Error('No refusal');
};

describe('the Signer client', () => {
  it('sends the shared secret, the request ID, and x402 version 2, and reads the signed payment', async () => {
    const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const signed = await signerAt(async (url, init) => {
      sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });

      return Response.json({
        header: 'signed-header', signatureId: 'sig_1', network: 'eip155:84532', asset: 'base-usdc', atomicAmount: '1000', amount: '1000',
        payTo: '0x1111111111111111111111111111111111111111',
      });
    }).sign(signInput);

    expect(sent).toEqual([{
      url: 'http://signer.internal:8083/internal/v1/sign',
      headers: { 'content-type': 'application/json', 'x-signer-secret': signerSecret, 'x-request-id': 'req-support-1' },
      body: { requestId: 'req-support-1', quoteId: 'pay_1', protocol: 'x402', x402Version: 2, requirement: {}, url: 'https://api.target.test/v1', quotedPrice: '1000' },
    }]);
    expect(signed).toEqual({
      header: 'signed-header', signatureId: 'sig_1', network: 'eip155:84532', asset: 'base-usdc', atomicAmount: 1_000n, amount: 1_000n,
      payTo: '0x1111111111111111111111111111111111111111',
    });
  });

  it('sends an MPP challenge as the target sent it, without an x402 version', async () => {
    let body: Record<string, unknown> = {};
    await signerAt(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return new Response('{}', { status: 503 });
    }).sign({ requestId: 'req-mpp', quoteId: 'pay_2', protocol: 'mpp', challenge: 'Payment id="c1"', url: 'https://api.target.test/v1', quotedPrice: 5n as MicroUsd })
      .catch(() => undefined);

    expect(body).toEqual({ requestId: 'req-mpp', quoteId: 'pay_2', protocol: 'mpp', challenge: 'Payment id="c1"', url: 'https://api.target.test/v1', quotedPrice: '5' });
  });

  it('reads a 422 signing_refused\'s code and reason from the envelope, never the rest of the body', async () => {
    const error = await refusal(async () => Response.json({ error: { code: 'signing_refused', message: 'The daily spend limit is reached' }, leaked: 'body-secret' }, { status: 422 }));

    expect(error.failure).toEqual({
      host: 'signer.internal:8083', method: 'POST', path: '/internal/v1/sign', status: 422, code: 'signing_refused', reason: 'The daily spend limit is reached',
      durationMs: expect.any(Number),
    });
    expect(error.message).toBe('The Signer answered 422 signing_refused');
    expect(JSON.stringify(error.failure)).not.toContain('body-secret');
  });

  it('names the transport\'s code when the Signer doesn\'t answer, as when it is switched off', async () => {
    const error = await refusal(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.1.4:8083'), { code: 'ECONNREFUSED' }) });
    });

    expect(error.failure).toMatchObject({ host: 'signer.internal:8083', path: '/internal/v1/sign', code: 'ECONNREFUSED' });
  });

  it('takes a 200 that isn\'t a signed payment as unavailable', async () => {
    const error = await refusal(async () => Response.json({ header: 'signed-header', atomicAmount: 'lots' }));

    expect(error.failure).toMatchObject({ status: 200, code: 'invalid_answer' });
  });
});

describe('the routed endpoint registrar', () => {
  it('sends the routed call\'s request ID to the internal API, and logs a failed registration with its status, never the shared secret', async () => {
    const lines: Record<string, unknown>[] = [];
    const sent: { headers: Record<string, string>; body: unknown }[] = [];
    const registrar = createEndpointRegistrar({
      url: 'http://api.internal:8082',
      secret: Secret.from(internalSecret),
      logger: createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }),
      fetch: async (_url, init) => {
        sent.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });

        return new Response('{"error":{"code":"internal_error"}}', { status: 500 });
      },
    });

    registrar.register('api.target.test', '/v1/pools', 1_100n as MicroUsd, 'req-routed-9');
    await registrar.settled();

    expect(sent).toEqual([{
      headers: { 'content-type': 'application/json', 'x-internal-secret': internalSecret, 'x-internal-caller': 'proxy', 'x-request-id': 'req-routed-9' },
      body: { host: 'api.target.test', path: '/v1/pools', quote: '0.0011' },
    }]);
    expect(lines).toEqual([expect.objectContaining({
      level: 40, msg: 'The internal API refused to register a routed endpoint', requestId: 'req-routed-9', endpointHost: 'api.target.test',
      host: 'api.internal:8082', method: 'PUT', path: '/internal/v1/routed-endpoints', status: 500, durationMs: expect.any(Number),
    })]);
    expect(JSON.stringify(lines)).not.toContain(internalSecret);
  });

  it('registers nothing without the internal API', async () => {
    let calls = 0;
    const registrar = createEndpointRegistrar({
      url: undefined, secret: undefined, logger: createLogger({ level: 'silent' }), fetch: async () => {
        calls += 1;

        return new Response(null, { status: 201 });
      },
    });

    registrar.register('api.target.test', '/v1/pools');
    await registrar.settled();

    expect(calls).toBe(0);
  });

  it.each([
    ['a 5xx', 503, 2],
    ['a 4xx, which is final', 400, 1],
  ])('tries again on the next call after %s', async (_case, status, calls) => {
    let sent = 0;
    const registrar = createEndpointRegistrar({
      url: 'http://api.internal:8082', secret: Secret.from(internalSecret), logger: createLogger({ level: 'silent' }), fetch: async () => {
        sent += 1;

        return new Response(null, { status });
      },
    });

    registrar.register('api.target.test', '/v1/pools');
    await registrar.settled();
    registrar.register('api.target.test', '/v1/pools');
    await registrar.settled();

    expect(sent).toBe(calls);
  });

  it('registers each endpoint once while the internal API takes it', async () => {
    let sent = 0;
    const registrar = createEndpointRegistrar({
      url: 'http://api.internal:8082', secret: Secret.from(internalSecret), logger: createLogger({ level: 'silent' }), fetch: async () => {
        sent += 1;

        return new Response(null, { status: 201 });
      },
    });

    registrar.register('api.target.test', '/v1/pools');
    await registrar.settled();
    registrar.register('api.target.test', '/v1/pools');
    await registrar.settled();

    expect(sent).toBe(1);
  });

  it('tries again on the next call when a registration gets no answer', async () => {
    let calls = 0;
    const registrar = createEndpointRegistrar({
      url: 'http://api.internal:8082', secret: Secret.from(internalSecret), logger: createLogger({ level: 'silent' }), fetch: async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      },
    });

    registrar.register('api.target.test', '/v1/pools');
    await registrar.settled();
    registrar.register('api.target.test', '/v1/pools');
    await registrar.settled();

    expect(calls).toBe(2);
  });
});

describe('the hosts the platform owns', () => {
  const config = {
    urls: { website: 'https://www.anyfare.test', api: 'https://api.anyfare.test', pay: 'https://pay.anyfare.test' },
    ownHosts: ['www.anyfare.test', 'api.anyfare.test', 'pay.anyfare.test', 'status.anyfare.test', '198.51.100.10'],
  };
  const domains = ownDomainsOf(config);

  it('are the exact hosts of its URLs and ownHosts, never the registrable domain', () => {
    expect([...domains].sort()).toEqual(['198.51.100.10', 'api.anyfare.test', 'pay.anyfare.test', 'status.anyfare.test', 'www.anyfare.test']);
  });

  it.each([
    ['the pay host', 'pay.anyfare.test', true],
    ['a subdomain of the pay host', 'a.pay.anyfare.test', true],
    ['the API host, in capitals and with a trailing dot', 'API.anyfare.test.', true],
    ['an ownHosts entry', 'status.anyfare.test', true],
    ['a subdomain of an ownHosts entry', 'eu.status.anyfare.test', true],
    ['another subdomain of the registrable domain', 'other.anyfare.test', false],
    ['the registrable domain itself', 'anyfare.test', false],
    ['a host that only ends like ours', 'notpay.anyfare.test', false],
    ['a target', 'api.target.test', false],
  ])('%s: %s is ours: %s', (_case, hostname, owned) => {
    expect(isOwnHost(hostname, domains)).toBe(owned);
  });

  it('refuses another subdomain once ownHosts names it, with its subdomains', () => {
    const named = ownDomainsOf({ ...config, ownHosts: [...config.ownHosts, 'other.anyfare.test'] });

    expect(isOwnHost('other.anyfare.test', named)).toBe(true);
    expect(isOwnHost('a.other.anyfare.test', named)).toBe(true);
    expect(isOwnHost('another.anyfare.test', named)).toBe(false);
  });
});

/** An in-memory stand-in for the Redis client's get and set, with each key's expiry in seconds. */
const createMemoryRedis = () => {
  const values = new Map<string, string>();
  const expiries = new Map<string, number>();
  const redis = {
    prefix: 'test:',
    client: {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string, options: { expiration: { value: number } }) => {
        values.set(key, value);
        expiries.set(key, options.expiration.value);
      },
    },
  } as unknown as Redis;

  return { redis, values, expiries };
};

describe('the routing opt-out', () => {
  const hosts = ['optout.target.test', 'optin.target.test', 'nofile.target.test', 'text.target.test', 'large.target.test', 'list.target.test'];
  let upstream: FakeUpstream;
  let http: OutboundHttp;

  beforeAll(async () => {
    upstream = await startFakeUpstream({ hosts });
    upstream.handle((request, response) => {
      const host = request.servername;
      if (request.path !== '/.well-known/anyfare.json' || host === 'nofile.target.test') {
        response.writeHead(404).end();
        return;
      }
      if (host === 'text.target.test') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('{"routing":false}');
        return;
      }
      if (host === 'large.target.test') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ routing: false, padding: 'x'.repeat(20_000) }));
        return;
      }
      if (host === 'list.target.test') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('[{"routing":false}]');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ routing: host !== 'optout.target.test' }));
    });
    http = new OutboundHttp({
      ownHosts: [],
      resolver: createFakeResolver(Object.fromEntries(hosts.map(host => [host, '127.0.0.1']))),
      addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
      ca: upstream.ca,
    });
  });

  afterAll(async () => {
    await http?.close();
    await upstream?.close();
  });

  const at = (host: string): string => `${host}:${upstream.port}`;

  it('takes "routing": false in the host\'s file as an opt-out, and keeps it a day', async () => {
    const { redis, values, expiries } = createMemoryRedis();
    const optedOut = createOptOutCheck({ http, redis, logger: createLogger({ level: 'silent' }) });
    const before = upstream.requests.length;

    expect(await optedOut(at('optout.target.test'))).toBe(true);
    expect(await optedOut(at('optout.target.test'))).toBe(true);

    expect(upstream.requests.slice(before).map(request => [request.method, request.path, request.servername, request.headers['accept']]))
      .toEqual([['GET', '/.well-known/anyfare.json', 'optout.target.test', 'application/json']]);
    expect(values.get(`test:optout:${at('optout.target.test')}`)).toBe('1');
    expect(expiries.get(`test:optout:${at('optout.target.test')}`)).toBe(optOutTtlSeconds);
  });

  it.each([
    ['a file that allows routing', 'optin.target.test'],
    ['no file', 'nofile.target.test'],
    ['a file that isn\'t served as JSON', 'text.target.test'],
    ['a file over 16 KiB', 'large.target.test'],
    ['a file that isn\'t a JSON object', 'list.target.test'],
  ])('takes %s as no opt-out, and keeps that a day', async (_case, host) => {
    const { redis, values, expiries } = createMemoryRedis();

    expect(await createOptOutCheck({ http, redis, logger: createLogger({ level: 'silent' }) })(at(host))).toBe(false);

    expect(values.get(`test:optout:${at(host)}`)).toBe('0');
    expect(expiries.get(`test:optout:${at(host)}`)).toBe(optOutTtlSeconds);
  });

  it('takes a host that doesn\'t answer as no opt-out, logs why, and asks again in minutes', async () => {
    const { redis, values, expiries } = createMemoryRedis();
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

    expect(await createOptOutCheck({ http, redis, logger })('unknown.target.test')).toBe(false);

    expect(values.get('test:optout:unknown.target.test')).toBe('0');
    expect(expiries.get('test:optout:unknown.target.test')).toBe(300);
    expect(lines).toEqual([expect.objectContaining({
      level: 30, msg: 'The routing opt-out file didn\'t arrive: no opt-out', host: 'unknown.target.test', code: 'ENOTFOUND',
    })]);
  });

  it('asks the host when the cache is down, and serves its answer', async () => {
    const redis = { prefix: '', client: { get: async () => Promise.reject(new Error('down')), set: async () => Promise.reject(new Error('down')) } } as unknown as Redis;

    expect(await createOptOutCheck({ http, redis, logger: createLogger({ level: 'silent' }) })(at('optout.target.test'))).toBe(true);
  });
});
