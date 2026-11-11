import { STATUS_CODES } from 'node:http';
import { isDeepStrictEqual } from 'node:util';

import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from 'fastify';

import { AnyfareError } from '../errors.js';
import type { Logger } from '../logging.js';
import { isRecord } from '../object.js';
import { serverErrorCodes, toErrorResponse, type ErrorStatusTable } from './errors.js';
import { recordErrorCode } from './requestLog.js';

// An app's OpenAPI document, built from the routes it registers: their own schemas, and the few words a schema
// can't hold, which each route keeps beside its registration in the fields below.

/** One way a route asks for a key, as OpenAPI writes it: `{ masterKey: [] }`. An empty object: no key. */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

/**
 * What the document says of a route that takes and answers anything, which no schema of its own can describe. The
 * route's description and these parameters are said once, for the path; a request body only on a method that has one.
 */
export interface OperationOverride {
  // The path as the document writes it, such as `/{host}/{path}` for the router's `/*`
  readonly path: string;
  readonly parameters?: readonly Readonly<Record<string, unknown>>[];
  readonly requestBody?: Readonly<Record<string, unknown>>;
  readonly responses?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  // Schemas its responses name by `#/components/schemas/<name>`, said once in the document's components
  readonly schemas?: Readonly<Record<string, unknown>>;
}

declare module 'fastify' {
  interface FastifySchema {
    // The fields below are read by the OpenAPI document only: Fastify neither validates nor serializes with them
    // A line on what the route does
    summary?: string;
    description?: string;
    tags?: readonly string[];
    // The keys the route takes, by the names of the document's security schemes. None: it needs no key.
    security?: readonly SecurityRequirement[];
    // The codes of the app's error table the route may answer, beside those of its key and the server's own
    errors?: readonly string[];
    // The name the document gives the `*` of the route's path, such as `host`
    wildcard?: string;
    // A stream's server-sent events, by name, with the schema of their data
    events?: Readonly<Record<string, unknown>>;
    // Left out of the document, such as readiness
    hide?: boolean;
    openapi?: OperationOverride;
  }
}

/** A route as the app registered it: its methods, its path as the router writes it, and its schema. */
export interface RegisteredRoute {
  readonly methods: readonly string[];
  readonly url: string;
  readonly schema: FastifySchema | undefined;
}

const registered = new WeakMap<FastifyInstance, RegisteredRoute[]>();

/** Keeps every route the app registers, in its own scopes too, with its schema. Call before the app's first route. */
export const trackRoutes = (app: FastifyInstance): void => {
  const routes: RegisteredRoute[] = [];
  registered.set(app, routes);
  app.addHook('onRoute', route => {
    routes.push({ methods: [route.method].flat(), url: route.url, schema: route.schema });
  });
};

/** The routes an app made by `createServer` registered so far: all of them once it is ready. Throws for an app it doesn't track. */
export const registeredRoutes = (app: FastifyInstance): readonly RegisteredRoute[] => {
  const routes = registered.get(app);
  if (!routes)
    throw new Error('The app\'s routes aren\'t tracked: only an app made by createServer has them');

  return routes;
};

/** The error envelope as a response schema: the same on every app, and the document's one `Error` schema. */
export const errorBodySchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['error'],
  additionalProperties: false,
} as const;

// The statuses of the codes the server itself answers with, as its error handler maps them
const serverErrorStatuses: ErrorStatusTable = {
  [serverErrorCodes.notFound]: 404,
  [serverErrorCodes.invalidRequest]: 400,
  [serverErrorCodes.requestTooLarge]: 413,
  [serverErrorCodes.unsupportedMediaType]: 415,
  [serverErrorCodes.internalError]: 500,
};

// The methods Fastify reads a request body for
const bodyMethods = new Set(['DELETE', 'OPTIONS', 'PATCH', 'PUT', 'POST']);
const operationMethods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const errorRef = { $ref: '#/components/schemas/Error' } as const;

/** A key a route may ask for, sent as `Authorization: Bearer <key>`. */
export interface KeyScheme {
  readonly description: string;
  // The codes a request without the key, or with a wrong one, is answered with
  readonly errors: readonly string[];
}

export interface OpenApiOptions {
  readonly title: string;
  readonly version: string;
  readonly description: string;
  // The host's public URL, from the platform config
  readonly url: string;
  readonly routes: readonly RegisteredRoute[];
  // The app's code-to-status table
  readonly errorStatuses: ErrorStatusTable;
  // The keys routes may take, by the names their `security` gives
  readonly keys?: Readonly<Record<string, KeyScheme>>;
  // The server's own codes for a request body it can't take, on each method that may carry one
  readonly bodyErrors: readonly string[];
  // Methods left out, such as OPTIONS on a host where it is only ever the CORS preflight
  readonly omitMethods?: readonly string[];
}

type JsonObject = Readonly<Record<string, unknown>>;

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: { readonly title: string; readonly version: string; readonly description: string };
  readonly servers: readonly { readonly url: string }[];
  // Each path's operations by method, and for a route that describes itself, its words and parameters
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components: {
    readonly schemas: { readonly Error: typeof errorBodySchema } & Readonly<Record<string, unknown>>;
    readonly securitySchemes?: Readonly<Record<string, JsonObject>>;
  };
}

const reasonOf = (status: string): string => STATUS_CODES[Number(status)] ?? (status === 'default' ? 'Any other answer' : `${status.charAt(0)}xx`);

const quoted = (codes: readonly string[]): string => codes.map(code => `\`${code}\``).join(', ');

/** The parameters a route's params, query string, or headers schema names, each with its own schema. */
const parametersOf = (schema: unknown, location: 'path' | 'query' | 'header', nameOf: (name: string) => string = name => name): JsonObject[] => {
  if (!isRecord(schema) || !isRecord(schema['properties']))
    return [];
  const required = new Set(Array.isArray(schema['required']) ? schema['required'] as unknown[] : []);

  return Object.entries(schema['properties']).map(([name, property]) => ({
    name: nameOf(name),
    in: location,
    required: location === 'path' || required.has(name),
    ...isRecord(property) && typeof property['description'] === 'string' ? { description: property['description'] } : {},
    schema: property,
  }));
};

/** The document's path for a route: `:id` as `{id}`, and `*` by the name the route gives it. */
export const documentPathOf = (route: Pick<RegisteredRoute, 'url' | 'schema'>): string =>
  route.schema?.openapi?.path ?? route.url.replace(/:(\w+)/g, '{$1}').replace('*', `{${route.schema?.wildcard ?? 'path'}}`);

const templateNames = (path: string): string[] => [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!);

const errorResponse = (status: string, codes: readonly string[]): JsonObject => ({
  description: codes.length === 0 ? reasonOf(status) : `${reasonOf(status)}: ${quoted(codes)}`,
  ...status === '401' ? { headers: { 'WWW-Authenticate': { description: 'The scheme the key goes in: Bearer', schema: { type: 'string' } } } } : {},
  ...status === '429' ? { headers: { 'Retry-After': { description: 'Seconds to wait before asking again', schema: { type: 'integer' } } } } : {},
  content: { 'application/json': { schema: errorRef } },
});

/** A status the route's own schema answers that error codes answer too: either one. */
const withCodes = (response: JsonObject, status: string, codes: readonly string[]): JsonObject => {
  const content = isRecord(response['content']) ? response['content'] : {};
  const json = isRecord(content['application/json']) ? content['application/json'] : undefined;
  if (json?.['schema'] === errorRef)
    return errorResponse(status, codes);

  return {
    ...response,
    description: `${String(response['description'])} Or an error: ${quoted(codes)}`,
    content: { ...content, 'application/json': { schema: json === undefined ? errorRef : { oneOf: [json['schema'], errorRef] } } },
  };
};

/** A status of the route's response schema, as the document writes it. */
const responseOf = (status: string, schema: unknown, events: JsonObject | undefined): JsonObject => {
  if (isDeepStrictEqual(schema, errorBodySchema))
    return errorResponse(status, []);
  const description = isRecord(schema) && typeof schema['description'] === 'string' ? schema['description'] : reasonOf(status);
  // Fastify's form for answers by content type
  if (isRecord(schema) && isRecord(schema['content'])) {
    const content = Object.fromEntries(Object.entries(schema['content']).map(([type, media]) => [type, {
      schema: isRecord(media) ? media['schema'] : undefined,
      ...type === 'text/event-stream' && events !== undefined ? { 'x-events': events } : {},
    }]));

    return { description, content };
  }

  return { description, content: { 'application/json': { schema } } };
};

const statusOrder = (status: string): number => (status === 'default' ? 1_000 : Number.parseInt(status, 10));

const looseKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'description']);

/**
 * Whether the server's validator can refuse nothing of a query string, path parameters, or headers under this schema.
 * It checks them leniently: a field the schema doesn't name is dropped, not refused. So no fields refuse nothing, nor do
 * fields that are only strings, of the path, which the router always gives, or of headers none of which is required. A
 * field of the query string can come twice, which a string refuses.
 */
const refusesNothing = (schema: unknown, location: 'path' | 'query' | 'header'): boolean => {
  if (!isRecord(schema) || Object.keys(schema).some(key => !looseKeys.has(key)))
    return false;
  const properties = isRecord(schema['properties']) ? Object.values(schema['properties']) : [];
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  if (properties.length === 0)
    return required.length === 0;
  if (location === 'query' || (location === 'header' && required.length > 0))
    return false;

  return properties.every(property => isRecord(property) && property['type'] === 'string' && Object.keys(property).every(key => key === 'type' || key === 'description'));
};

/**
 * The OpenAPI 3.1 document of an app's routes. Each request and response schema is the route's own object, so a
 * changed route changes the document. A route marked `hide` is left out, and so are the methods `omitMethods` names.
 * Error answers come from the codes each route lists, its key's, and the server's own, by the app's table.
 */
export const buildOpenApiDocument = (options: OpenApiOptions): OpenApiDocument => {
  const { routes, errorStatuses, keys = {}, bodyErrors, omitMethods = [] } = options;
  const statusOf = (code: string, route: string): number => {
    const status = Object.hasOwn(errorStatuses, code) ? errorStatuses[code] : serverErrorStatuses[code];
    if (status === undefined)
      throw new Error(`The route ${route} lists the error code ${code}, which neither the app's table nor the server's has`);

    return status;
  };
  const usedKeys = new Set<string>();
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = { Error: errorBodySchema };

  for (const route of routes) {
    const schema: FastifySchema = route.schema ?? {};
    if (schema.hide)
      continue;
    const path = documentPathOf(route);
    const override = schema.openapi;
    const parameters = [
      ...parametersOf(schema.params, 'path', name => (name === '*' ? schema.wildcard ?? 'path' : name)),
      ...parametersOf(schema.querystring, 'query'),
      ...parametersOf(schema.headers, 'header'),
      ...override?.parameters ?? [],
    ];
    // A path part with no schema of its own is a string, as the router gives it
    for (const name of templateNames(path)) {
      if (!parameters.some(parameter => parameter['in'] === 'path' && parameter['name'] === name))
        parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
    const requirements = schema.security ?? [];
    for (const requirement of requirements) {
      for (const name of Object.keys(requirement)) {
        if (!Object.hasOwn(keys, name))
          throw new Error(`The route ${route.methods.join(',')} ${route.url} takes the key ${name}, which the document has no scheme for`);
        usedKeys.add(name);
      }
    }
    // Every way in asks for a key: a missing or wrong one is answered with the key's codes
    const keyRequired = requirements.length > 0 && requirements.every(requirement => Object.keys(requirement).length > 0);
    const keyErrors = keyRequired ? requirements.flatMap(requirement => Object.keys(requirement).flatMap(name => keys[name]!.errors)) : [];
    const validates = schema.body !== undefined
      || ([[schema.params, 'path'], [schema.querystring, 'query'], [schema.headers, 'header']] as const)
        .some(([part, location]) => part !== undefined && !refusesNothing(part, location));
    const item = paths[path] ??= {};
    // A route that describes itself says its words and its parameters once, for every method of its path
    if (override !== undefined) {
      if (Object.keys(item).length > 0)
        throw new Error(`Another route is at ${path}`);
      Object.assign(item, {
        ...schema.description === undefined ? {} : { description: schema.description },
        ...parameters.length === 0 ? {} : { parameters },
      });
      for (const [name, value] of Object.entries(override.schemas ?? {})) {
        if (Object.hasOwn(schemas, name) && schemas[name] !== value)
          throw new Error(`Two schemas are named ${name}`);
        schemas[name] = value;
      }
    }

    for (const method of route.methods) {
      if (omitMethods.includes(method))
        continue;
      const name = `${method} ${route.url}`;
      const codes = new Set([
        ...schema.errors ?? [],
        ...keyErrors,
        ...validates ? [serverErrorCodes.invalidRequest] : [],
        ...bodyMethods.has(method) ? bodyErrors : [],
        serverErrorCodes.internalError,
      ]);
      const byStatus = new Map<string, string[]>();
      for (const code of codes) {
        const status = String(statusOf(code, name));
        byStatus.set(status, [...byStatus.get(status) ?? [], code]);
      }

      const responses: Record<string, JsonObject> = {};
      for (const [status, response] of Object.entries(isRecord(schema.response) ? schema.response : {}))
        responses[status] = responseOf(status, response, schema.events);
      Object.assign(responses, override?.responses ?? {});
      for (const [status, statusCodes] of byStatus)
        responses[status] = responses[status] === undefined ? errorResponse(status, statusCodes) : withCodes(responses[status], status, statusCodes);

      // GET and HEAD take no body: Fastify never reads one
      const body = !bodyMethods.has(method) ? undefined : override?.requestBody ?? (schema.body === undefined
        ? undefined
        : {
          required: isRecord(schema.body) && Array.isArray(schema.body['required']) && schema.body['required'].length > 0,
          content: { 'application/json': { schema: schema.body } },
        });
      const operation: JsonObject = {
        ...schema.summary === undefined ? {} : { summary: schema.summary },
        ...schema.description === undefined || override !== undefined ? {} : { description: schema.description },
        ...schema.tags === undefined ? {} : { tags: schema.tags },
        ...requirements.length === 0 ? {} : { security: requirements },
        ...parameters.length === 0 || override !== undefined ? {} : { parameters },
        ...body === undefined ? {} : { requestBody: body },
        responses: Object.fromEntries(Object.entries(responses).sort(([a], [b]) => statusOrder(a) - statusOrder(b))),
      };
      const key = method.toLowerCase();
      if (!operationMethods.has(key))
        throw new Error(`The route ${name} has a method OpenAPI can't describe`);
      if (item[key] !== undefined)
        throw new Error(`Two routes are ${method} ${path}`);
      item[key] = operation;
    }
  }

  const securitySchemes = Object.fromEntries([...usedKeys].map(name => [name, { type: 'http', scheme: 'bearer', description: keys[name]!.description }]));

  return {
    openapi: '3.1.0',
    info: { title: options.title, version: options.version, description: options.description },
    servers: [{ url: options.url.replace(/\/+$/, '') }],
    paths,
    components: {
      schemas: schemas as OpenApiDocument['components']['schemas'],
      ...usedKeys.size === 0 ? {} : { securitySchemes },
    },
  };
};

/** `/openapi.json` while its document can't be built: a 503, and every other route works. */
export class DocumentUnavailableError extends AnyfareError {
  readonly code = 'document_unavailable';

  constructor() {
    super('This API\'s description can\'t be served right now');
  }
}

/**
 * The document's JSON, built once at start. A document that can't be built never stops the app: the reason is logged
 * once, at error, and undefined is returned, so `/openapi.json` answers 503 while every other route works. The tests
 * build each document themselves, where a failure throws.
 */
export const documentJson = (build: () => OpenApiDocument, logger: Pick<Logger, 'error'>): Buffer | undefined => {
  try {
    return Buffer.from(JSON.stringify(build()));
  }
  catch (error) {
    logger.error({ error }, 'The OpenAPI document couldn\'t be built, so /openapi.json answers 503');

    return undefined;
  }
};

/**
 * `/openapi.json`'s answer: the document, which any cache may keep 5 minutes, or `503 document_unavailable` when it
 * couldn't be built, never kept. The app's table must map that code.
 */
export const sendDocument = (request: FastifyRequest, reply: FastifyReply, document: Buffer | undefined, statuses: ErrorStatusTable): FastifyReply => {
  if (document === undefined) {
    const { status, body } = toErrorResponse(new DocumentUnavailableError(), statuses);
    recordErrorCode(request, body.error.code);

    return reply.status(status).header('cache-control', 'no-store').send(body);
  }

  return reply.header('cache-control', 'public, max-age=300').type('application/json; charset=utf-8').send(document);
};

// ---------- A structural check ----------

const parameterLocations = new Set(['path', 'query', 'header', 'cookie']);
const responseKey = /^(?:[1-5][0-9]{2}|[1-5]XX|default)$/;

/** Every value is JSON: no undefined, function, symbol, bigint, or number that isn't finite. */
const nonJson = (value: unknown, at: string, problems: string[], seen: Set<object>): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      problems.push(`${at} is ${value}, which JSON can't hold`);
    return;
  }
  if (typeof value !== 'object') {
    problems.push(`${at} is ${typeof value}, which JSON can't hold`);
    return;
  }
  if (seen.has(value)) {
    problems.push(`${at} refers back to itself`);
    return;
  }
  seen.add(value);
  for (const [key, item] of Object.entries(value))
    nonJson(item, `${at}/${key}`, problems, seen);
  seen.delete(value);
};

const resolvePointer = (document: unknown, ref: string): boolean => {
  if (!ref.startsWith('#/'))
    return false;
  let node = document;
  for (const part of ref.slice(2).split('/').map(item => decodeURIComponent(item).replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!isRecord(node) && !Array.isArray(node))
      return false;
    if (!Object.hasOwn(node, part))
      return false;
    node = (node as Record<string, unknown>)[part];
  }

  return true;
};

const collectRefs = (value: unknown, refs: Set<string>): void => {
  if (Array.isArray(value)) {
    value.forEach(item => collectRefs(item, refs));
    return;
  }
  if (!isRecord(value))
    return;
  for (const [key, item] of Object.entries(value)) {
    if (key === '$ref' && typeof item === 'string')
      refs.add(item);
    else
      collectRefs(item, refs);
  }
};

/**
 * What keeps a document from being a well-formed OpenAPI 3.1 document, by its structure: the fields it requires,
 * every operation with responses that each have a description, every parameter with a name, a place and a schema,
 * a path's every `{name}` a required path parameter and no other, every `$ref` resolving inside the document, every
 * security requirement naming a scheme it defines, and nothing JSON can't hold. Empty: none found. It doesn't check
 * the schemas against JSON Schema's own rules, media types, header names, or that the words are true.
 */
export const openApiProblems = (document: unknown): string[] => {
  const problems: string[] = [];
  nonJson(document, '#', problems, new Set());
  if (!isRecord(document))
    return [...problems, 'The document is not an object'];
  if (typeof document['openapi'] !== 'string' || !/^3\.1\.\d+$/.test(document['openapi']))
    problems.push('openapi is not 3.1.x');
  const info = document['info'];
  if (!isRecord(info) || typeof info['title'] !== 'string' || info['title'] === '' || typeof info['version'] !== 'string' || info['version'] === '')
    problems.push('info needs a title and a version');
  const servers = document['servers'];
  if (servers !== undefined && (!Array.isArray(servers) || servers.some(server => !isRecord(server) || typeof server['url'] !== 'string' || !URL.canParse(server['url']))))
    problems.push('servers must each have an absolute url');
  const components = isRecord(document['components']) ? document['components'] : {};
  const schemes = isRecord(components['securitySchemes']) ? components['securitySchemes'] : {};
  const paths = document['paths'];
  if (!isRecord(paths))
    return [...problems, 'paths is not an object'];

  const operationIds = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/'))
      problems.push(`The path ${path} doesn't start with /`);
    if (!isRecord(item)) {
      problems.push(`${path} is not a path item`);
      continue;
    }
    const names = templateNames(path);
    // Parameters said for the path apply to each operation, unless the operation says its own of the same name and place
    const shared = Array.isArray(item['parameters']) ? item['parameters'] as unknown[] : [];
    if (item['parameters'] !== undefined && !Array.isArray(item['parameters']))
      problems.push(`${path} has parameters that aren't a list`);
    for (const [method, operation] of Object.entries(item)) {
      const at = `${method.toUpperCase()} ${path}`;
      if (!operationMethods.has(method)) {
        if (!['summary', 'description', 'parameters', 'servers'].includes(method) && !method.startsWith('x-'))
          problems.push(`${path} has ${method}, which is no method or field of a path item`);
        continue;
      }
      if (!isRecord(operation)) {
        problems.push(`${at} is not an operation`);
        continue;
      }
      const responses = operation['responses'];
      if (!isRecord(responses) || Object.keys(responses).length === 0)
        problems.push(`${at} has no responses`);
      else {
        for (const [status, response] of Object.entries(responses)) {
          if (!responseKey.test(status))
            problems.push(`${at} answers ${status}, which is no status`);
          if (!isRecord(response) || (typeof response['description'] !== 'string' && typeof response['$ref'] !== 'string'))
            problems.push(`${at} ${status} has no description`);
          else if (response['content'] !== undefined && (!isRecord(response['content'])
            || Object.values(response['content']).some(media => !isRecord(media) || !isRecord(media['schema']))))
            problems.push(`${at} ${status} has a media type without a schema`);
        }
      }
      const own = operation['parameters'] ?? [];
      if (!Array.isArray(own))
        problems.push(`${at} has parameters that aren't a list`);
      const ownKeys = new Set((Array.isArray(own) ? own : []).filter(isRecord).map(parameter => `${String(parameter['in'])} ${String(parameter['name'])}`));
      const parameters = [
        ...shared.filter(parameter => !isRecord(parameter) || !ownKeys.has(`${String(parameter['in'])} ${String(parameter['name'])}`)),
        ...Array.isArray(own) ? own : [],
      ];
      const pathNames: string[] = [];
      for (const parameter of parameters) {
        if (!isRecord(parameter) || typeof parameter['name'] !== 'string' || !parameterLocations.has(String(parameter['in']))) {
          problems.push(`${at} has a parameter without a name or a place`);
          continue;
        }
        if (!isRecord(parameter['schema']) && !isRecord(parameter['content']))
          problems.push(`${at} has the parameter ${parameter['name']} without a schema`);
        if (parameter['in'] === 'path') {
          pathNames.push(parameter['name']);
          if (parameter['required'] !== true)
            problems.push(`${at} has the path parameter ${parameter['name']}, which isn't required`);
        }
      }
      if ([...names].sort().join(',') !== [...pathNames].sort().join(','))
        problems.push(`${at}'s path parameters aren't the parts of its path: ${pathNames.join(', ')}`);
      const body = operation['requestBody'];
      if (body !== undefined && (!isRecord(body) || !isRecord(body['content'])))
        problems.push(`${at} has a request body without content`);
      const security = operation['security'];
      if (security !== undefined) {
        if (!Array.isArray(security) || security.some(requirement => !isRecord(requirement)))
          problems.push(`${at} has security that isn't a list of requirements`);
        else {
          for (const name of security.flatMap(requirement => Object.keys(requirement as object))) {
            if (!Object.hasOwn(schemes, name))
              problems.push(`${at} takes ${name}, which no security scheme defines`);
          }
        }
      }
      const operationId = operation['operationId'];
      if (typeof operationId === 'string') {
        if (operationIds.has(operationId))
          problems.push(`${at}'s operationId ${operationId} is not unique`);
        operationIds.add(operationId);
      }
    }
  }

  const refs = new Set<string>();
  collectRefs(document, refs);
  for (const ref of refs) {
    if (!resolvePointer(document, ref))
      problems.push(`$ref ${ref} doesn't resolve`);
  }

  return problems;
};
