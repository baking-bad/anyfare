import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';

import { encodePaymentRequiredHeader } from '@x402/core/http';
import fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLogger, errorBodySchema, openApiProblems, randomIdGenerator, registeredRoutes, systemClock, type OpenApiDocument, type OutboundHttp, type OutboundRequest,
  type OutboundResponse, type RegisteredRoute,
} from '@anyfare/common';
import { findAsset, generateApiKey, hashApiKey, loadPlatformConfig, type PlatformConfig, type RateLimiter } from '@anyfare/core';
import { createAccountRepository, createLedger, createPaymentKeyRepository } from '@anyfare/db';
import { createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, routedMethods, type ProxyServer } from '../../src/app.js';
import { createPayDocument } from '../../src/platform/openapi.js';
import { paymentRequiredSchema, routedCallSchema } from '../../src/routing/routedCall.js';

// `GET /openapi.json` on the pay host: its routes from their own schemas, the routed call in words, and a path
// that is never routed to a paid API

interface Answer {
  readonly url: string;
  readonly status: string | undefined;
  readonly before: string;
  readonly after: string;
}

const generous = { requests: 100_000, windowSeconds: 60 };
// A made-up address the target asks to be paid at
const targetPayTo = '0x3333333333333333333333333333333333333333';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let proxy: ProxyServer;
let url: string;
let document: OpenApiDocument;
let served: { readonly status: number; readonly headers: Headers; readonly text: string };
// What the proxy asked of paid APIs
const outbound: OutboundRequest[] = [];
const answers: Answer[] = [];
const servers: ProxyServer[] = [];

const response = (target: string, status: number, headers: Record<string, string>): OutboundResponse => ({
  status, headers, url: new URL(target), body: Readable.from([Buffer.from('{}')]), bytes: async () => Buffer.from('{}'), text: async () => '{}', dispose: () => undefined,
});

/** Every paid API: no opt-out, and a 402 in x402 for 0.001 USDC on Base, which the proxy pays. */
const targets: Pick<OutboundHttp, 'request'> = {
  request: async request => {
    outbound.push(request);
    const target = String(request.url);
    if (new URL(target).pathname === '/.well-known/anyfare.json')
      return response(target, 404, {});
    const required = {
      x402Version: 2, error: 'Payment required', resource: { url: target, description: 'Data', mimeType: 'application/json' },
      accepts: [{
        scheme: 'exact', network: 'eip155:84532', amount: '1000', asset: findAsset(config, 'base-usdc')!.address, payTo: targetPayTo, maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2' },
      }],
    };

    return response(target, 402, { 'payment-required': encodePaymentRequiredHeader(required as never) });
  },
};

/** Fastify's own serializer compiler, recording each answer it serializes beside `JSON.stringify` of the same value. */
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
      answers.push({ url: definition.url, status: definition.httpStatus, before: JSON.stringify(data), after });

      return after;
    };
  });
};

const start = async (platform: PlatformConfig, limiter?: RateLimiter): Promise<{ readonly server: ProxyServer; readonly url: string }> => {
  const server = createApp({
    config: platform, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, http: targets, trustProxy: '127.0.0.1',
    ...limiter === undefined ? {} : { rateLimiter: limiter },
  });
  servers.push(server);
  await recordAnswers(server.app);
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return { server, url: `http://127.0.0.1:${port}` };
};

const configWith = (rateLimits: Record<string, unknown>) => loadPlatformConfig({
  env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ rateLimits })).toString('base64') },
});

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  config = await configWith({ paymentKey: generous, unpaidIp: generous, probeIp: generous, documents: generous });
  ({ server: proxy, url } = await start(config));
  const answer = await fetch(`${url}/openapi.json`);
  served = { status: answer.status, headers: answer.headers, text: await answer.text() };
  document = createPayDocument(proxy.app, config);
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

type Operation = {
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly parameters?: readonly { readonly name: string; readonly in: string; readonly schema: unknown }[];
  readonly responses: Record<string, { readonly description: string; readonly headers?: Record<string, unknown>; readonly content?: Record<string, { readonly schema: unknown }> }>;
};

const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const operations = (doc: OpenApiDocument) => Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item)
  .filter(([method]) => methods.has(method))
  .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation: operation as unknown as Operation })));

// The document's path of a route, written here on its own: the routed call's `/*` is `/{host}/{path}`
const pathOf = (route: RegisteredRoute): string => (route.url === '/*' ? '/{host}/{path}' : route.url);

describe('GET /openapi.json on the pay host', () => {
  it('serves the document as JSON, built from the routes, kept 5 minutes, to any origin', async () => {
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(served.headers.get('cache-control')).toBe('public, max-age=300');
    expect(served.headers.get('access-control-allow-origin')).toBe('*');
    expect(served.text).toBe(JSON.stringify(document));
    expect(await (await fetch(`${url}/openapi.json?any=query`)).text()).toBe(served.text);
  });

  it('answers its CORS preflight with GET only', async () => {
    const preflight = await fetch(`${url}/openapi.json`, { method: 'OPTIONS', headers: { origin: 'https://elsewhere.example', 'access-control-request-method': 'GET' } });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET');
  });

  it('is well formed OpenAPI 3.1, for the pay host and the package\'s version, with the payment key as its scheme', () => {
    const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

    expect(openApiProblems(JSON.parse(served.text))).toEqual([]);
    expect(document.info).toMatchObject({ title: 'Anyfare pay host', version });
    expect(document.servers).toEqual([{ url: 'https://pay.anyfare.test' }]);
    expect(Object.keys(document.components.securitySchemes ?? {})).toEqual(['paymentKey']);
    expect(served.text).not.toMatch(/\/internal\/|x-internal|127\.0\.0\.1|localhost|0x[0-9a-fA-F]{40}/);
  });

  it('is under a limit per address, and lets the request through while the limiter fails, as the proxy\'s limits do', async () => {
    const limited = await start(await configWith({ documents: { requests: 1, windowSeconds: 60 } }));
    const failing = await start(config, { hit: async () => {
      throw new Error('Redis is down');
    } });
    const get = (at: string) => fetch(`${at}/openapi.json`, { headers: { 'x-forwarded-for': '198.51.100.9' } });

    expect((await get(limited.url)).status).toBe(200);
    const refused = await get(limited.url);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe('rate_limited');
    expect((await get(failing.url)).status).toBe(200);
  });
});

describe('a document that can\'t be built', () => {
  it('never stops the pay host: it starts, logs it once, routes paid calls, and answers 503 on /openapi.json, never kept', async () => {
    const lines: Record<string, unknown>[] = [];
    const broken = createApp({
      config, logger: createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }), postgres: database.postgres, redis,
      http: targets,
    });
    servers.push(broken);
    broken.app.get('/_/broken', { schema: { errors: ['no_such_code'] } }, async () => ({ ok: true }));
    const { port } = await broken.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
    const at = `http://127.0.0.1:${port}`;

    const answers = [];
    for (const path of ['/openapi.json', '/openapi.json', '/_/health', '/_/broken', '/api.target.test/v1/data'])
      answers.push(await fetch(`${at}${path}`));

    expect(answers.map(answer => answer.status)).toEqual([503, 503, 200, 200, 402]);
    expect(answers[0]!.headers.get('cache-control')).toBe('no-store');
    expect((await answers[0]!.json() as { error: { code: string } }).error.code).toBe('document_unavailable');
    expect(lines.filter(line => (line['level'] as number) >= 50).map(line => line['msg'])).toEqual([
      'The OpenAPI document couldn\'t be built, so /openapi.json answers 503',
    ]);
  });
});

describe('the pay host\'s document', () => {
  it('has every route the app registers, and only those: a route missing from the document fails here', () => {
    const registered = registeredRoutes(proxy.app);
    const expected = registered.filter(route => !route.schema?.hide).flatMap(route => route.methods.map(method => `${method} ${pathOf(route)}`));
    const documented = operations(document).map(({ method, path }) => `${method} ${path}`);

    expect(documented.sort()).toEqual(expected.sort());
    expect(registered.filter(route => route.schema?.hide).map(route => `${route.methods.join(',')} ${route.url}`))
      .toEqual(['GET /_/ready', 'GET /robots.txt', `${routedMethods.join(',')} /`]);
    expect(Object.keys(document.paths).sort()).toEqual(['/_/check', '/_/health', '/_/key', '/openapi.json', '/{host}/{path}']);
  });

  it('leaves out a link without a host, which is always 400 invalid_target', async () => {
    const answers = await Promise.all(['GET', 'POST'].map(async method => {
      const answer = await fetch(`${url}/`, { method });

      return [answer.status, (await answer.json() as { error: { code: string } }).error.code];
    }));

    expect(answers).toEqual([[400, 'invalid_target'], [400, 'invalid_target']]);
  });

  it('describes the routed call as one path, for every method, its words and parameters said once', () => {
    const routed = document.paths['/{host}/{path}']!;

    expect(Object.keys(routed)).toEqual(['description', 'parameters', ...routedMethods.map(method => method.toLowerCase())]);
    expect(routed['description']).toContain('The path stands for any paid API\'s link');
    expect(routed['description']).toContain('the slashes of the path and the colon of the port are not percent-encoded');
    expect(routed['description']).toContain('The query is the request\'s own query string');
    expect(routed['description']).toContain('A path that starts with one answers `404 not_found`');
    const parameters = routed['parameters'] as { in: string; name: string; description: string }[];
    expect(parameters.map(parameter => `${parameter.in} ${parameter.name}`)).toEqual(['path host', 'path path', 'header PAYMENT-SIGNATURE']);
    expect(parameters[1]!.description).not.toContain('query');
    const call = routed['post'] as unknown as Operation;
    expect(Object.keys(call)).toEqual(['summary', 'tags', 'security', 'requestBody', 'responses']);
    expect(call.security).toEqual([{ paymentKey: [] }, {}]);
    const challenge = call.responses['402']!;
    expect(Object.keys(challenge.headers!)).toEqual(['PAYMENT-REQUIRED', 'WWW-Authenticate', 'Cache-Control']);
    expect(challenge.content!['application/json']!.schema).toEqual({ oneOf: [{ $ref: '#/components/schemas/PaymentRequired' }, { $ref: '#/components/schemas/Error' }] });
    expect(document.components.schemas['PaymentRequired']).toBe(paymentRequiredSchema);
    expect(challenge.description).toContain('`insufficient_balance`');
    expect(Object.keys(call.responses['2XX']!.headers!)).toEqual(['Anyfare-Receipt', 'PAYMENT-RESPONSE', 'Payment-Receipt']);
    // An object keeps keys that are numbers first
    expect(Object.keys(call.responses)).toEqual(['400', '401', '402', '404', '413', '429', '500', '502', '503', '2XX', 'default']);
    expect(call.responses['404']!.description).toContain('`not_found`');
    // A GET has no body to send on, nor to refuse
    expect(Object.keys((routed['get'] as unknown as Operation).responses)).not.toContain('413');
    expect(Object.keys(routed['get']!)).not.toContain('requestBody');
    expect(Object.keys(call)).toContain('requestBody');
    expect(call.responses['503']!.description).toContain('`upstream_unavailable`');
  });

  it('names only the ways to pay the rails take: x402 version 2, never version 1\'s X-PAYMENT, which the x402 rail refuses', () => {
    expect(served.text).not.toMatch(/X-PAYMENT/i);
    expect(served.text).toContain('PAYMENT-SIGNATURE');
  });

  it('lists the check\'s errors it can give, and no 503', () => {
    expect(Object.keys((document.paths['/_/check']!['get'] as unknown as Operation).responses)).toEqual(['200', '400', '429', '500']);
    expect(Object.keys((document.paths['/openapi.json']!['get'] as unknown as Operation).responses)).toEqual(['200', '429', '500', '503']);
  });

  it('describes each request and response of the other routes with the route\'s own schema object', () => {
    let compared = 0;
    for (const route of registeredRoutes(proxy.app).filter(candidate => !candidate.schema?.hide && candidate.url !== '/*')) {
      const schema = route.schema ?? {};
      const { operation } = operations(document).find(item => item.method === 'GET' && item.path === route.url)!;
      for (const [location, part] of [['query', schema.querystring], ['header', schema.headers]] as const) {
        for (const [name, property] of Object.entries((part as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})) {
          expect(operation.parameters!.find(item => item.in === location && item.name === name)!.schema).toBe(property);
          compared += 1;
        }
      }
      for (const [status, answer] of Object.entries((schema.response ?? {}) as Record<string, unknown>)) {
        const content = operation.responses[status]!.content!['application/json']!;
        if (isDeepStrictEqual(answer, errorBodySchema))
          expect(content.schema).toEqual({ $ref: '#/components/schemas/Error' });
        else
          expect(content.schema, `${route.url} ${status}`).toBe(answer);
        compared += 1;
      }
    }

    expect(compared).toBeGreaterThan(8);
    expect((document.paths['/_/key']!['get'] as unknown as Operation).security).toEqual([{ paymentKey: [] }]);
    expect((document.paths['/_/check']!['get'] as unknown as Operation).security).toBeUndefined();
  });
});

/** The keys of a value its schema doesn't describe, and those it requires that the value lacks. */
const misfits = (value: unknown, schema: Record<string, unknown>, at = ''): string[] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || schema['properties'] === undefined)
    return [];
  const properties = schema['properties'] as Record<string, Record<string, unknown>>;
  const required = (schema['required'] ?? []) as readonly string[];

  return [
    ...Object.keys(value).filter(key => !(key in properties)).map(key => `${at}/${key} isn't described`),
    ...required.filter(key => !(key in value)).map(key => `${at}/${key} is missing`),
    ...Object.entries(value).flatMap(([key, item]) => (key in properties ? misfits(item, properties[key]!, `${at}/${key}`) : [])),
  ];
};

describe('the routed call\'s 402', () => {
  it('is the body the document describes: every field the proxy sends, and those it says are always there', async () => {
    const challenge = await fetch(`${url}/api.target.test/v1/data`);
    const body = await challenge.json() as Record<string, unknown>;

    expect(challenge.status).toBe(402);
    expect(challenge.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(body)).toContain('credits');
    expect(misfits(body, paymentRequiredSchema)).toEqual([]);
    expect(misfits({ ...body, credits: { ...body['credits'] as object, extra: 1 } }, paymentRequiredSchema)).toEqual(['/credits/extra isn\'t described']);
  });

  it('keeps routedCallSchema the route\'s own: the document\'s words for it are the schema the route was registered with', () => {
    expect(registeredRoutes(proxy.app).find(route => route.url === '/*')!.schema).toBe(routedCallSchema);
  });
});

describe('/openapi.json is never a routed link', () => {
  it.each([
    ['POST', '/openapi.json'], ['PUT', '/openapi.json'], ['DELETE', '/openapi.json'], ['HEAD', '/openapi.json'], ['GET', '/openapi.json/v1/data'],
    ['GET', '/OpenAPI.json'], ['POST', '/OPENAPI.JSON/v1/data'],
  ])('%s %s answers 404 and reaches no API', async (method, path) => {
    const before = outbound.length;

    const answer = await fetch(`${url}${path}`, { method });

    expect(answer.status).toBe(404);
    if (method !== 'HEAD')
      expect((await answer.json() as { error: { code: string } }).error.code).toBe('not_found');
    expect(outbound.slice(before)).toEqual([]);
  });

  it('leaves robots.txt as it was', async () => {
    const robots = await fetch(`${url}/robots.txt`);

    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
  });
});

describe('GET /_/key answers what it sent without its response schema', () => {
  /** A payment key of a new account with Credits, as the Platform API writes them. */
  const paymentKey = async (limits: { label?: string; allowance?: bigint; maxPrice?: bigint; expiresAt?: Date }): Promise<string> => {
    const accountId = `acc_${randomUUID()}`;
    const createdAt = systemClock.now();
    await createAccountRepository({ db: database.db }).create({ id: accountId, createdAt });
    const key = generateApiKey('payment', config.keyPrefixes);
    await createPaymentKeyRepository({ db: database.db }).insert({
      id: `key_${randomUUID()}`, accountId, keyHash: hashApiKey(key), label: limits.label, createdAt, allowance: limits.allowance, dailyBudget: 5_000_000n,
      maxPrice: limits.maxPrice, expiresAt: limits.expiresAt,
    });
    await createLedger({ db: database.db, clock: systemClock, ids: randomIdGenerator }).credit({ accountId, amount: 1_250_000n, reference: `credit-${accountId}` });

    return key.expose();
  };

  it('with every limit, and with none', async () => {
    const limited = await paymentKey({ label: 'agent', allowance: 20_000_000n, maxPrice: 50_000n, expiresAt: new Date('2027-06-30T00:00:00.000Z') });
    const bare = await paymentKey({});

    const statuses = [];
    for (const key of [limited, bare])
      statuses.push((await fetch(`${url}/_/key`, { headers: { authorization: `Bearer ${key}` } })).status);

    expect(statuses).toEqual([200, 200]);
    const seen = answers.filter(answer => answer.url === '/_/key');
    expect(seen.map(answer => answer.status)).toEqual(['200', '200']);
    expect(seen.map(answer => answer.before.includes('null'))).toEqual([false, true]);
    for (const answer of seen)
      expect(answer.after).toBe(answer.before);
  });
});
