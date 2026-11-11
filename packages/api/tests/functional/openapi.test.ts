import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, errorBodySchema, openApiProblems, registeredRoutes, Secret, type OpenApiDocument, type RegisteredRoute } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createFakeClock, createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';
import { createApiDocument } from '../../src/public/openapi.js';

// `GET /openapi.json` on the Platform API: every public route, from the routes' own schemas, and never the internal API

const internalSecret = 'internal-secret-for-the-openapi-tests-0123456789';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let server: ApiServer;
let url: string;
let served: { readonly text: string; readonly headers: Headers; readonly status: number };
let document: OpenApiDocument;

const base64 = (yaml: string) => Buffer.from(yaml).toString('base64');

const start = async (platform: PlatformConfig): Promise<{ readonly server: ApiServer; readonly url: string }> => {
  const started = createApp({
    config: platform, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock: createFakeClock('2026-11-12T09:00:00.000Z'),
    internalSecret: Secret.from(internalSecret), trustProxy: '127.0.0.1',
  });
  const { port } = await started.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });

  return { server: started, url: `http://127.0.0.1:${port}` };
};

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  config = await loadPlatformConfig({
    env: { CONFIG_PATH: 'config/example.yaml', CONFIG: base64('rateLimits:\n  signup: { requests: 1000, windowSeconds: 60 }\n  documents: { requests: 1000, windowSeconds: 60 }\n') },
  });
  ({ server, url } = await start(config));
  const response = await fetch(`${url}/openapi.json`);
  served = { status: response.status, headers: response.headers, text: await response.text() };
  document = createApiDocument(server.app, config);
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

type Operation = {
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly parameters?: readonly { readonly name: string; readonly in: string; readonly schema: unknown }[];
  readonly requestBody?: { readonly content: Record<string, { readonly schema: unknown }> };
  readonly responses: Record<string, { readonly content?: Record<string, { readonly schema: unknown }> }>;
};

const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const operations = (doc: OpenApiDocument) => Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item)
  .filter(([method]) => methods.has(method))
  .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation: operation as unknown as Operation })));

// The document's path of a route, written here on its own: `:id` as `{id}`, and `*` by the name the route gives it
const pathOf = (route: RegisteredRoute): string => route.url.replace(/:(\w+)/g, '{$1}').replace('*', `{${route.schema?.wildcard}}`);

describe('GET /openapi.json', () => {
  it('serves the document as JSON, built from the routes, kept 5 minutes, to any origin', async () => {
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(served.headers.get('cache-control')).toBe('public, max-age=300');
    expect(served.headers.get('access-control-allow-origin')).toBe('*');
    expect(served.text).toBe(JSON.stringify(document));
    // Built once: the next answer is the same bytes
    expect(await (await fetch(`${url}/openapi.json`)).text()).toBe(served.text);
  });

  it('answers the CORS preflight without a key', async () => {
    const response = await fetch(`${url}/openapi.json`, { method: 'OPTIONS', headers: { origin: 'https://elsewhere.example', 'access-control-request-method': 'GET' } });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });

  it('is well formed OpenAPI 3.1, for the API\'s host and the package\'s version', () => {
    const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

    expect(openApiProblems(JSON.parse(served.text))).toEqual([]);
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toMatchObject({ title: 'Anyfare Platform API', version });
    expect(document.servers).toEqual([{ url: 'https://api.anyfare.test' }]);
    expect(Object.keys(document.components)).toEqual(['schemas', 'securitySchemes']);
    expect(document.components.securitySchemes).toEqual({ masterKey: { type: 'http', scheme: 'bearer', description: expect.stringContaining('master key') } });
  });

  it('is under the limit per address that the public documents share', async () => {
    const limited = await start(await loadPlatformConfig({
      env: { CONFIG_PATH: 'config/example.yaml', CONFIG: base64('rateLimits:\n  documents: { requests: 2, windowSeconds: 60 }\n') },
    }));
    try {
      const get = (path: string, ip: string) => fetch(`${limited.url}${path}`, { headers: { 'x-forwarded-for': ip } });

      expect((await get('/openapi.json', '198.51.100.7')).status).toBe(200);
      expect((await get('/openapi.json', '198.51.100.7')).status).toBe(200);
      const refused = await get('/openapi.json', '198.51.100.7');
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
      expect((await refused.json() as { error: { code: string } }).error.code).toBe('rate_limited');
      // The catalog counts toward the same limit
      expect((await get('/v1/catalog', '198.51.100.8')).status).toBe(200);
      expect((await get('/openapi.json', '198.51.100.8')).status).toBe(200);
      expect((await get('/openapi.json', '198.51.100.8')).status).toBe(429);
    }
    finally {
      await limited.server.close();
    }
  });
});

describe('a document that can\'t be built', () => {
  it('never stops the API: it starts, logs it once, serves every other route, and answers 503 on /openapi.json, never kept', async () => {
    const lines: Record<string, unknown>[] = [];
    const broken = createApp({
      config, logger: createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }), postgres: database.postgres, redis,
      clock: createFakeClock('2026-11-12T09:00:00.000Z'),
    });
    broken.app.get('/test/broken', { schema: { errors: ['no_such_code'] } }, async () => ({ ok: true }));
    try {
      const { port } = await broken.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
      const at = `http://127.0.0.1:${port}`;

      const answers = [];
      for (const path of ['/openapi.json', '/openapi.json', '/_/health', '/v1/catalog', '/test/broken'])
        answers.push(await fetch(`${at}${path}`));

      expect(answers.map(answer => answer.status)).toEqual([503, 503, 200, 200, 200]);
      expect(answers[0]!.headers.get('cache-control')).toBe('no-store');
      expect((await answers[0]!.json() as { error: { code: string } }).error.code).toBe('document_unavailable');
      expect((await fetch(`${at}/v1/accounts`, { method: 'POST' })).status).toBe(201);
      expect(lines.filter(line => (line['level'] as number) >= 50).map(line => line['msg'])).toEqual([
        'The OpenAPI document couldn\'t be built, so /openapi.json answers 503',
      ]);
    }
    finally {
      await broken.close();
    }
  });
});

describe('the document\'s routes', () => {
  it('are every public route the listener registers, and only those: a route missing from the document fails here', () => {
    const registered = registeredRoutes(server.app);
    const shown = registered.filter(route => !route.schema?.hide);
    // OPTIONS is only ever a CORS preflight: a public read's, or the console's on a route behind the master key
    const expected = shown.flatMap(route => route.methods.filter(method => method !== 'OPTIONS').map(method => `${method} ${pathOf(route)}`));
    const documented = operations(document).map(({ method, path }) => `${method} ${path}`);

    expect(documented.sort()).toEqual([...new Set(expected)].sort());
    // Readiness, and the host's own robots.txt
    expect(registered.filter(route => route.schema?.hide).map(route => `${route.methods.join(',')} ${route.url}`).sort()).toEqual(['GET /_/ready', 'GET /robots.txt']);
    // A public read's beside its GET; the console's on its own, at the URL of a route that takes the master key, or signs up
    const keyed = new Set(shown.filter(route => route.schema?.security !== undefined || route.url === '/v1/accounts').map(route => route.url));
    const preflights = registered.filter(route => route.methods.includes('OPTIONS'));
    expect(preflights.filter(route => !route.methods.includes('GET') && !(route.methods.length === 1 && keyed.has(route.url)))).toEqual([]);
    expect(preflights.filter(route => !route.methods.includes('GET')).map(route => route.url).sort()).toEqual([...keyed].sort());
    // Exactly these: a route registered on the public listener by mistake fails here
    expect(documented.sort()).toEqual([
      'DELETE /v1/keys/{id}', 'GET /_/health', 'GET /openapi.json', 'GET /v1/account', 'GET /v1/balance', 'GET /v1/calls', 'GET /v1/calls/stream',
      'GET /v1/calls/{id}', 'GET /v1/catalog', 'GET /v1/endpoints/stats', 'GET /v1/keys', 'GET /v1/payments', 'GET /v1/services', 'GET /v1/services/{host}',
      'GET /v1/stats', 'GET /v1/stats/live', 'GET /v1/stats/top', 'GET /v1/topups', 'GET /v1/topups/options', 'GET /v1/topups/{id}', 'PATCH /v1/keys/{id}',
      'POST /v1/account/master-key/rotate',
      'POST /v1/accounts', 'POST /v1/keys', 'POST /v1/topups',
    ]);
  });

  it('never include the internal API, nor readiness', () => {
    const internal = registeredRoutes(server.internal);
    const paths = Object.keys(document.paths);

    expect(internal.length).toBeGreaterThan(5);
    expect(internal.filter(route => route.url.startsWith('/internal/')).every(route => !paths.includes(pathOf(route)))).toBe(true);
    expect(paths.filter(path => path.startsWith('/internal') || path === '/_/ready' || path === '/metrics')).toEqual([]);
    expect(served.text).not.toMatch(/\/internal\/|x-internal|127\.0\.0\.1|localhost/);
    expect(served.text).not.toContain(internalSecret);
  });

  it('each have a summary and a tag', () => {
    expect(operations(document).filter(({ operation }) => !operation.summary || operation.tags?.length !== 1).map(({ method, path }) => `${method} ${path}`)).toEqual([]);
  });

  it('take the master key exactly where the server asks for it: a call without one answers 401 there and nowhere else', async () => {
    const filled = (path: string) => path.replace('{host}', 'api.example.test').replace(/\{\w+\}/g, 'x');
    const answers = await Promise.all(operations(document).map(async ({ method, path, operation }) => {
      const controller = new AbortController();
      const response = await fetch(`${url}${filled(path)}`, { method, signal: controller.signal });
      // A stream would stay open
      controller.abort();

      return { name: `${method} ${path}`, keyed: operation.security !== undefined, refused: response.status === 401 };
    }));

    expect(answers.filter(answer => answer.keyed !== answer.refused)).toEqual([]);
    expect(answers.filter(answer => answer.keyed).length).toBe(11);
    expect(operations(document).filter(({ operation }) => operation.security !== undefined).every(({ operation }) => isDeepStrictEqual(operation.security, [{ masterKey: [] }])))
      .toBe(true);
  });

  it('describe each request and response with the route\'s own schema object, so a changed route changes the document', () => {
    let compared = 0;
    for (const route of registeredRoutes(server.app).filter(candidate => !candidate.schema?.hide)) {
      const schema = route.schema ?? {};
      for (const method of route.methods.filter(item => item !== 'OPTIONS')) {
        const { operation } = operations(document).find(item => item.method === method && item.path === pathOf(route))!;
        const parameter = (location: string, name: string) => operation.parameters!.find(item => item.in === location && item.name === name)!.schema;
        for (const [location, part] of [['query', schema.querystring], ['header', schema.headers], ['path', schema.params]] as const) {
          for (const [name, property] of Object.entries((part as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})) {
            expect(parameter(location, name === '*' ? schema.wildcard! : name), `${method} ${route.url} ${name}`).toBe(property);
            compared += 1;
          }
        }
        if (schema.body !== undefined) {
          expect(operation.requestBody!.content['application/json']!.schema).toBe(schema.body);
          compared += 1;
        }
        for (const [status, response] of Object.entries((schema.response ?? {}) as Record<string, Record<string, unknown>>)) {
          const content = operation.responses[status]!.content!;
          if (isDeepStrictEqual(response, errorBodySchema)) {
            expect(content['application/json']!.schema).toEqual({ $ref: '#/components/schemas/Error' });
            expect(document.components.schemas.Error).toEqual(response);
          }
          else if (response['content'] !== undefined) {
            for (const [type, media] of Object.entries(response['content'] as Record<string, { schema: unknown }>))
              expect(content[type]!.schema).toBe(media.schema);
          }
          else
            expect(content['application/json']!.schema, `${method} ${route.url} ${status}`).toBe(response);
          compared += 1;
        }
      }
    }

    expect(compared).toBeGreaterThan(60);
  });

  it('describe the stream as server-sent events, with the data of its event', () => {
    const stream = (document.paths['/v1/calls/stream']!['get'] as unknown as Operation).responses['200']!.content!;

    expect(Object.keys(stream)).toEqual(['text/event-stream']);
    expect(Object.keys((stream['text/event-stream'] as unknown as { 'x-events': object })['x-events'])).toEqual(['call']);
  });

  it('list the errors each route can give, from the error table, and none it can\'t', () => {
    const responses = (method: string, path: string) => Object.keys((document.paths[path]![method] as unknown as Operation).responses);

    expect(responses('get', '/v1/keys')).toEqual(['200', '401', '500']);
    expect(responses('post', '/v1/topups')).toEqual(['201', '400', '401', '413', '415', '429', '500', '502', '503']);
    // Its ID is any string the router gives
    expect(responses('get', '/v1/topups/{id}')).toEqual(['200', '401', '404', '500', '503']);
    expect(responses('get', '/v1/topups')).toEqual(['200', '400', '401', '500', '503']);
    expect(responses('get', '/v1/payments')).toEqual(['200', '400', '401', '500', '503']);
    expect(responses('get', '/v1/services/{host}')).toEqual(['200', '400', '404', '429', '500', '503']);
    expect(responses('get', '/v1/services')).toEqual(['200', '400', '429', '500', '503']);
    expect(responses('get', '/v1/calls')).toEqual(['200', '400', '429', '500']);
    expect(responses('get', '/v1/calls/stream')).toEqual(['200', '400', '429', '500', '503']);
    expect(responses('get', '/v1/calls/{id}')).toEqual(['200', '400', '404', '429', '500']);
    expect(responses('get', '/v1/stats')).toEqual(['200', '429', '500', '503']);
    expect(responses('get', '/v1/stats/live')).toEqual(['200', '429', '500', '503']);
    expect(responses('get', '/openapi.json')).toEqual(['200', '429', '500', '503']);
  });

  it('name the filters and fields of the payments and the list of top-ups, and the parameters each refuses', () => {
    const operation = (path: string) => document.paths[path]!['get'] as unknown as Operation;
    const query = (path: string) => operation(path).parameters!.filter(parameter => parameter.in === 'query').map(parameter => parameter.name);
    const answer = (path: string) => operation(path).responses['200']!.content!['application/json']!.schema as { properties: Record<string, { items: { properties: object } }> };

    expect(query('/v1/payments')).toEqual(['limit', 'after', 'state', 'keyId', 'service']);
    expect(query('/v1/topups')).toEqual(['limit', 'after']);
    expect(Object.keys(answer('/v1/payments').properties['payments']!.items.properties)).toEqual([
      'id', 'requestId', 'rail', 'keyId', 'targetHost', 'targetPath', 'amount', 'status', 'state', 'upstreamStatus', 'createdAt', 'updatedAt',
    ]);
    expect(answer('/v1/topups').properties['topups']!.items).toBe(answer('/v1/topups/{id}'));
    expect(Object.keys(answer('/v1/topups').properties)).toEqual(['topups', 'next']);
  });

  it('list no 400 where a query it doesn\'t name is dropped, not refused', async () => {
    const statuses = await Promise.all(['/v1/stats', '/v1/stats/live'].map(async path => (await fetch(`${url}${path}?unknown=1`)).status));

    expect(statuses.filter(status => status === 400)).toEqual([]);
  });
});
