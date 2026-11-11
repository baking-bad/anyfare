import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildOpenApiDocument, createLogger, createServer, documentJson, documentPathOf, errorBodySchema, openApiProblems, registeredRoutes, sendDocument,
  type OpenApiDocument, type OpenApiOptions, type Server,
} from '../../src/index.js';
import { captureLogs } from './helpers.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

const thingSchema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } as const;
const bodySchema = { type: 'object', properties: { name: { type: 'string', maxLength: 20 } }, required: ['name'], additionalProperties: false } as const;
const thingParams = { type: 'object', properties: { id: { type: 'string', description: 'The thing\'s ID' } }, required: ['id'] } as const;
const pageQuery = { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, q: { type: 'string' } }, required: ['page'] } as const;
const hostParams = { type: 'object', properties: { '*': { type: 'string', maxLength: 253 } }, required: ['*'] } as const;
const traceHeaders = { type: 'object', properties: { 'x-trace': { type: 'string' } } } as const;
const eventSchema = { type: 'object', properties: { at: { type: 'string' } } } as const;
const streamSchema = { 200: { description: 'Events', content: { 'text/event-stream': { schema: { type: 'string' } } } } } as const;
const keyScheme = { description: 'A key', errors: ['unauthorized', 'invalid_key'] } as const;
const errorStatuses = { unauthorized: 401, invalid_key: 401, rate_limited: 429, not_found: 404, gone_away: 503 } as const;

/** An app with a route of each kind: a key's, a public read's, a body's, a wildcard's, a stream's, and one left out. */
const buildApp = (): Server => {
  const server = createServer({ logger: createLogger({ level: 'silent' }), errorStatuses });
  servers.push(server);
  const { app } = server;
  app.route({
    method: ['GET', 'OPTIONS'],
    url: '/things',
    schema: { summary: 'Things', tags: ['things'], errors: ['rate_limited'], querystring: pageQuery, response: { 200: thingSchema, 429: errorBodySchema } },
    handler: async () => ({ id: 'thing-1' }),
  });
  app.register(async scope => {
    scope.post('/things', {
      schema: { summary: 'Make a thing', security: [{ key: [] }], body: bodySchema, response: { 201: thingSchema } },
    }, async (_request, reply) => reply.status(201).send({ id: 'thing-2' }));
    scope.delete('/things/:id', {
      schema: { summary: 'Drop a thing', security: [{ key: [] }], errors: ['not_found'], params: thingParams, headers: traceHeaders },
    }, async () => ({ id: 'thing-1' }));
  });
  app.get('/hosts/*', { schema: { summary: 'A host', wildcard: 'host', params: hostParams } }, async () => ({}));
  app.get('/events', { schema: { summary: 'A stream', events: { tick: eventSchema }, errors: ['gone_away'], response: streamSchema } }, async () => '');
  app.get('/secret', { schema: { hide: true } }, async () => ({}));
  app.get('/plain/:name', async () => ({}));

  return server;
};

const optionsOf = (server: Server, changes: Partial<OpenApiOptions> = {}): OpenApiOptions => ({
  title: 'Things API',
  version: '1.2.3',
  description: 'Things',
  url: 'https://api.example.test/',
  routes: registeredRoutes(server.app),
  errorStatuses,
  keys: { key: keyScheme },
  bodyErrors: ['invalid_request', 'request_too_large', 'unsupported_media_type'],
  omitMethods: ['OPTIONS'],
  ...changes,
});

const ready = async (): Promise<Server> => {
  const server = buildApp();
  await server.app.ready();

  return server;
};

type Operation = Record<string, unknown> & {
  readonly responses: Record<string, { readonly description: string; readonly headers?: Record<string, unknown>; readonly content?: Record<string, { readonly schema: unknown }> }>;
  readonly parameters?: readonly { readonly name: string; readonly in: string; readonly required: boolean; readonly schema: unknown }[];
};
const operation = (document: ReturnType<typeof buildOpenApiDocument>, method: string, path: string): Operation => document.paths[path]![method] as Operation;

describe('the routes the server keeps', () => {
  it('are every route it registered, in its own scopes too, with the schema it was given', async () => {
    const server = await ready();

    const routes = registeredRoutes(server.app).map(route => `${route.methods.join(',')} ${route.url}`);

    expect(routes).toEqual([
      'GET /_/health', 'GET /_/ready', 'GET,OPTIONS /things', 'GET /hosts/*', 'GET /events', 'GET /secret', 'GET /plain/:name', 'POST /things', 'DELETE /things/:id',
    ]);
    expect(registeredRoutes(server.app).find(route => route.url === '/hosts/*')!.schema!.params).toBe(hostParams);
  });

  it('are known only for an app the server made', async () => {
    const plain = fastify();

    expect(() => registeredRoutes(plain)).toThrow('The app\'s routes aren\'t tracked');
    await plain.close();
  });

  it('are kept apart for each app', async () => {
    const one = await ready();
    const other = createServer({ logger: createLogger({ level: 'silent' }) });
    servers.push(other);
    other.app.get('/elsewhere', async () => ({}));
    await other.app.ready();

    expect(registeredRoutes(one.app).some(route => route.url === '/elsewhere')).toBe(false);
    expect(registeredRoutes(other.app).map(route => route.url)).toEqual(['/_/health', '/_/ready', '/elsewhere']);
  });
});

describe('the OpenAPI document', () => {
  it('is well formed, with the info, the server, and the error envelope once', async () => {
    const document = buildOpenApiDocument(optionsOf(await ready()));

    expect(openApiProblems(document)).toEqual([]);
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toEqual({ title: 'Things API', version: '1.2.3', description: 'Things' });
    expect(document.servers).toEqual([{ url: 'https://api.example.test' }]);
    expect(document.components.schemas.Error).toBe(errorBodySchema);
    expect(document.components.securitySchemes).toEqual({ key: { type: 'http', scheme: 'bearer', description: 'A key' } });
  });

  it('has every route but those left out, at the path OpenAPI writes', async () => {
    const document = buildOpenApiDocument(optionsOf(await ready()));

    const operations = Object.entries(document.paths).flatMap(([path, item]) => Object.keys(item).map(method => `${method} ${path}`));

    expect(operations.sort()).toEqual([
      'delete /things/{id}', 'get /_/health', 'get /events', 'get /hosts/{host}', 'get /plain/{name}', 'get /things', 'post /things',
    ]);
    expect(documentPathOf({ url: '/hosts/*', schema: { wildcard: 'host' } })).toBe('/hosts/{host}');
  });

  it('keeps OPTIONS when the app doesn\'t leave it out', async () => {
    const document = buildOpenApiDocument(optionsOf(await ready(), { omitMethods: [] }));

    expect(Object.keys(document.paths['/things']!)).toEqual(['get', 'options', 'post']);
  });

  it('describes each part of a request with the route\'s own schema object', async () => {
    const document = buildOpenApiDocument(optionsOf(await ready()));

    const list = operation(document, 'get', '/things');
    expect(list.parameters).toEqual([
      { name: 'page', in: 'query', required: true, schema: pageQuery.properties.page },
      { name: 'q', in: 'query', required: false, schema: pageQuery.properties.q },
    ]);
    expect(list.parameters![0]!.schema).toBe(pageQuery.properties.page);
    expect((operation(document, 'post', '/things')['requestBody'] as { content: { 'application/json': { schema: unknown } } }).content['application/json'].schema)
      .toBe(bodySchema);
    const drop = operation(document, 'delete', '/things/{id}');
    expect(drop.parameters).toEqual([
      { name: 'id', in: 'path', required: true, description: 'The thing\'s ID', schema: thingParams.properties.id },
      { name: 'x-trace', in: 'header', required: false, schema: traceHeaders.properties['x-trace'] },
    ]);
    expect(operation(document, 'get', '/hosts/{host}').parameters).toEqual([{ name: 'host', in: 'path', required: true, schema: hostParams.properties['*'] }]);
    expect(operation(document, 'get', '/hosts/{host}').parameters![0]!.schema).toBe(hostParams.properties['*']);
    // A path part without a schema is a string, as the router gives it
    expect(operation(document, 'get', '/plain/{name}').parameters).toEqual([{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }]);
  });

  it('answers with the route\'s own response schemas, and a stream with its events', async () => {
    const document = buildOpenApiDocument(optionsOf(await ready()));

    expect(operation(document, 'get', '/things').responses['200']!.content!['application/json']!.schema).toBe(thingSchema);
    expect(operation(document, 'post', '/things').responses['201']).toEqual({ description: 'Created', content: { 'application/json': { schema: thingSchema } } });
    const stream = operation(document, 'get', '/events').responses['200']!;
    expect(stream).toEqual({ description: 'Events', content: { 'text/event-stream': { schema: { type: 'string' }, 'x-events': { tick: eventSchema } } } });
    expect(stream.content!['text/event-stream']!.schema).toBe(streamSchema[200].content['text/event-stream'].schema);
  });

  it('lists every error a route can give: its own, its key\'s, and the server\'s, by the app\'s table, with the envelope by reference', async () => {
    const document = buildOpenApiDocument(optionsOf(await ready()));
    const statuses = (method: string, path: string) => Object.fromEntries(Object.entries(operation(document, method, path).responses)
      .map(([status, response]) => [status, response.description]));

    expect(statuses('get', '/things')).toEqual({ 200: 'OK', 400: 'Bad Request: `invalid_request`', 429: 'Too Many Requests: `rate_limited`', 500: 'Internal Server Error: `internal_error`' });
    expect(statuses('post', '/things')).toEqual({
      201: 'Created', 400: 'Bad Request: `invalid_request`', 401: 'Unauthorized: `unauthorized`, `invalid_key`', 413: 'Payload Too Large: `request_too_large`',
      415: 'Unsupported Media Type: `unsupported_media_type`', 500: 'Internal Server Error: `internal_error`',
    });
    expect(statuses('delete', '/things/{id}')).toMatchObject({ 401: 'Unauthorized: `unauthorized`, `invalid_key`', 404: 'Not Found: `not_found`' });
    expect(statuses('get', '/_/health')).toEqual({ 200: 'OK', 500: 'Internal Server Error: `internal_error`' });
    expect(statuses('get', '/events')).toMatchObject({ 503: 'Service Unavailable: `gone_away`' });
    const limited = operation(document, 'get', '/things').responses['429']!;
    expect(limited.content).toEqual({ 'application/json': { schema: { $ref: '#/components/schemas/Error' } } });
    expect(Object.keys(limited.headers!)).toEqual(['Retry-After']);
    expect(Object.keys(operation(document, 'post', '/things').responses['401']!.headers!)).toEqual(['WWW-Authenticate']);
    expect(operation(document, 'post', '/things')['security']).toEqual([{ key: [] }]);
    expect(operation(document, 'get', '/things')['security']).toBeUndefined();
  });

  it('refuses an error code the tables don\'t have, and a key it has no scheme for', async () => {
    const server = buildApp();
    server.app.get('/unknown', { schema: { errors: ['no_such_code'] } }, async () => ({}));
    server.app.get('/locked', { schema: { security: [{ door: [] }] } }, async () => ({}));
    await server.app.ready();
    const routes = registeredRoutes(server.app);

    expect(() => buildOpenApiDocument(optionsOf(server, { routes: routes.filter(route => route.url !== '/locked') })))
      .toThrow('The route GET /unknown lists the error code no_such_code');
    expect(() => buildOpenApiDocument(optionsOf(server, { routes: routes.filter(route => route.url !== '/unknown') })))
      .toThrow('takes the key door, which the document has no scheme for');
  });

  it('describes a route that takes and answers anything by its own words, and adds its errors to the answers it names', async () => {
    const server = buildApp();
    const challenge = { type: 'object', properties: { price: { type: 'string' } } } as const;
    const parameters = [{ name: 'target', in: 'path', required: true, schema: { type: 'string' } }, { name: 'rest', in: 'path', required: true, schema: { type: 'string' } }];
    server.app.route({
      method: ['GET', 'POST'],
      url: '/pass/*',
      schema: {
        summary: 'Anything',
        description: 'Long words, said once',
        security: [{ key: [] }, {}],
        errors: ['invalid_key', 'rate_limited'],
        openapi: {
          path: '/pass/{target}/{rest}',
          parameters,
          requestBody: { content: { '*/*': { schema: {} } } },
          schemas: { Challenge: challenge },
          responses: {
            401: { description: 'Pay first', content: { 'application/json': { schema: { $ref: '#/components/schemas/Challenge' } } } },
            default: { description: 'Its answer' },
          },
        },
      },
      handler: async () => ({}),
    });
    await server.app.ready();
    const document = buildOpenApiDocument(optionsOf(server));

    expect(openApiProblems(document)).toEqual([]);
    // Its words and its parameters once, for the path; its schemas once, in the components
    const item = document.paths['/pass/{target}/{rest}']!;
    expect(Object.keys(item)).toEqual(['description', 'parameters', 'get', 'post']);
    expect(item['description']).toBe('Long words, said once');
    expect(item['parameters']).toEqual(parameters);
    expect(document.components.schemas['Challenge']).toBe(challenge);
    const pass = operation(document, 'post', '/pass/{target}/{rest}');
    expect(Object.keys(pass)).toEqual(['summary', 'security', 'requestBody', 'responses']);
    expect(pass.responses['401']).toEqual({
      description: 'Pay first Or an error: `invalid_key`',
      content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/Challenge' }, { $ref: '#/components/schemas/Error' }] } } },
    });
    // The key is one way in of two: a missing key is no error of its own
    expect(Object.keys(pass.responses)).toEqual(['400', '401', '413', '415', '429', '500', 'default']);
    expect(pass['security']).toEqual([{ key: [] }, {}]);
    // A GET takes no body: Fastify never reads one
    expect(pass['requestBody']).toEqual({ content: { '*/*': { schema: {} } } });
    expect(operation(document, 'get', '/pass/{target}/{rest}')['requestBody']).toBeUndefined();
  });

  it('refuses two schemas of one name', async () => {
    const server = buildApp();
    const other = { type: 'string' } as const;
    server.app.route({ method: 'GET', url: '/one/*', schema: { openapi: { path: '/one/{x}', schemas: { Error: other } } }, handler: async () => ({}) });
    await server.app.ready();

    expect(() => buildOpenApiDocument(optionsOf(server))).toThrow('Two schemas are named Error');
  });

  it('lists invalid_request only where the server\'s validator can refuse the request', async () => {
    const server = buildApp();
    const empty = { type: 'object', properties: {}, additionalProperties: false } as const;
    const strings = { type: 'object', properties: { id: { type: 'string', description: 'An ID' } }, required: ['id'] } as const;
    server.app.get('/quiet/:id', { schema: { querystring: empty, params: strings, headers: { type: 'object', properties: { 'x-a': { type: 'string' } } } } }, async () => ({}));
    server.app.get('/twice', { schema: { querystring: { type: 'object', properties: { q: { type: 'string' } } } } }, async () => ({}));
    server.app.get('/needs', { schema: { headers: { type: 'object', properties: { 'x-a': { type: 'string' } }, required: ['x-a'] } } }, async () => ({}));
    server.app.get('/bounded/:id', { schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 5 } } } } }, async () => ({}));
    await server.app.ready();
    const document = buildOpenApiDocument(optionsOf(server));
    const refuses = (path: string) => Object.keys(operation(document, 'get', path).responses).includes('400');

    // Fields it doesn't name are dropped, and a path part or a header comes once, as a string
    expect(refuses('/quiet/{id}')).toBe(false);
    // A query string field may come twice, a required header may be missing, and a bounded one may be too long
    expect([refuses('/twice'), refuses('/needs'), refuses('/bounded/{id}')]).toEqual([true, true, true]);
  });
});

describe('a document that can\'t be built', () => {
  const failing = (): OpenApiDocument => {
    throw new Error('The route GET /x lists the error code no_such_code');
  };

  it('is logged once at error, and leaves nothing to serve, without throwing', () => {
    const { logger, lines } = captureLogs();

    expect(documentJson(failing, logger)).toBeUndefined();
    expect(lines.map(line => [line['level'], line['msg']])).toEqual([[50, 'The OpenAPI document couldn\'t be built, so /openapi.json answers 503']]);
  });

  it('answers 503 document_unavailable, never kept by a cache, while one that was built is kept 5 minutes', async () => {
    const server = createServer({ logger: createLogger({ level: 'silent' }), errorStatuses: { document_unavailable: 503 } });
    servers.push(server);
    const built = documentJson(() => buildOpenApiDocument(optionsOf(server)), createLogger({ level: 'silent' }));
    server.app.get('/missing.json', async (request, reply) => sendDocument(request, reply, undefined, { document_unavailable: 503 }));
    server.app.get('/built.json', async (request, reply) => sendDocument(request, reply, built, { document_unavailable: 503 }));

    const missing = await server.app.inject({ method: 'GET', url: '/missing.json' });
    const served = await server.app.inject({ method: 'GET', url: '/built.json' });

    expect([missing.statusCode, missing.headers['cache-control'], missing.json()]).toEqual([
      503, 'no-store', { error: { code: 'document_unavailable', message: 'This API\'s description can\'t be served right now' } },
    ]);
    expect([served.statusCode, served.headers['cache-control'], served.headers['content-type']]).toEqual([200, 'public, max-age=300', 'application/json; charset=utf-8']);
    expect(served.body).toBe(built!.toString('utf8'));
  });
});

describe('the structural check', () => {
  const valid = () => ({
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.test' }],
    paths: {
      '/things/{id}': {
        get: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          security: [{ key: [] }],
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } },
        },
      },
    },
    components: { schemas: { Thing: { type: 'object' } }, securitySchemes: { key: { type: 'http', scheme: 'bearer' } } },
  });

  it('finds nothing wrong with a well-formed document', () => {
    expect(openApiProblems(valid())).toEqual([]);
  });

  it('reads a parameter said once for the path as each operation\'s', () => {
    const document = valid();
    Object.assign(document.paths['/things/{id}'], { parameters: document.paths['/things/{id}'].get.parameters });
    Object.assign(document.paths['/things/{id}'].get, { parameters: [] });

    expect(openApiProblems(document)).toEqual([]);
  });

  it.each([
    ['another version', (document: ReturnType<typeof valid>) => Object.assign(document, { openapi: '3.0.3' }), 'openapi is not 3.1.x'],
    ['no title', (document: ReturnType<typeof valid>) => Object.assign(document, { info: { version: '1' } }), 'info needs a title and a version'],
    ['a relative server', (document: ReturnType<typeof valid>) => Object.assign(document, { servers: [{ url: '/v1' }] }), 'servers must each have an absolute url'],
    ['no responses', (document: ReturnType<typeof valid>) => Object.assign(document.paths['/things/{id}'].get, { responses: {} }), 'GET /things/{id} has no responses'],
    ['a response without a description', (document: ReturnType<typeof valid>) => Object.assign(document.paths['/things/{id}'].get.responses[200], { description: undefined }),
      'GET /things/{id} 200 has no description'],
    ['a $ref that resolves nowhere', (document: ReturnType<typeof valid>) => Object.assign(document.components, { schemas: {} }), '$ref #/components/schemas/Thing doesn\'t resolve'],
    ['a parameter without a schema', (document: ReturnType<typeof valid>) => Object.assign(document.paths['/things/{id}'].get.parameters[0]!, { schema: undefined }),
      'GET /things/{id} has the parameter id without a schema'],
    ['a path part with no parameter', (document: ReturnType<typeof valid>) => Object.assign(document.paths['/things/{id}'].get, { parameters: [] }),
      'GET /things/{id}\'s path parameters aren\'t the parts of its path: '],
    ['an optional path parameter', (document: ReturnType<typeof valid>) => Object.assign(document.paths['/things/{id}'].get.parameters[0]!, { required: false }),
      'GET /things/{id} has the path parameter id, which isn\'t required'],
    ['a path-level parameter without a schema', (document: ReturnType<typeof valid>) => Object.assign(document.paths['/things/{id}'], {
      parameters: [{ name: 'id', in: 'path', required: true }],
    }) && Object.assign(document.paths['/things/{id}'].get, { parameters: [] }), 'GET /things/{id} has the parameter id without a schema'],
    ['a key no scheme defines', (document: ReturnType<typeof valid>) => Object.assign(document.paths['/things/{id}'].get, { security: [{ door: [] }] }),
      'GET /things/{id} takes door, which no security scheme defines'],
    ['an undefined value', (document: ReturnType<typeof valid>) => Object.assign(document.info, { description: undefined }), '#/info/description is undefined, which JSON can\'t hold'],
    ['a number JSON can\'t hold', (document: ReturnType<typeof valid>) => Object.assign(document.components.schemas.Thing, { maximum: Number.NaN }),
      '#/components/schemas/Thing/maximum is NaN, which JSON can\'t hold'],
  ])('finds %s', (_case, spoil, problem) => {
    const document = valid();
    spoil(document);

    expect(openApiProblems(document)).toContain(problem);
  });
});
