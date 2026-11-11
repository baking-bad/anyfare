import { readFileSync } from 'node:fs';

import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { buildOpenApiDocument, documentJson, registeredRoutes, sendDocument, type Logger, type OpenApiDocument } from '@anyfare/common';
import type { PlatformConfig } from '@anyfare/core';

import { masterKeyScheme } from '../accounts/auth.js';
import { errorStatuses } from '../errors.js';
import { publicCors, publicReadMethods } from './cors.js';

// The answer is the document's JSON, sent as it was built: no serializer reads it
const documentSchema = { type: 'object', additionalProperties: true, description: 'This document: OpenAPI 3.1, as JSON' } as const;

const packageVersion = (): string => (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { readonly version: string }).version;

/**
 * The Platform API's OpenAPI document, from every route the public listener registered. The internal API is on a
 * listener of its own, so none of its routes can be in it.
 */
export const createApiDocument = (app: FastifyInstance, config: PlatformConfig): OpenApiDocument => buildOpenApiDocument({
  title: 'Anyfare Platform API',
  version: packageVersion(),
  description: 'Accounts, payment keys, balances and top-ups behind the master key, and the public reads of the catalog, calls and numbers '
    + 'without a key. Paid calls go through the pay host, with a payment key.',
  url: config.urls.api,
  routes: registeredRoutes(app),
  errorStatuses,
  keys: { masterKey: masterKeyScheme },
  bodyErrors: ['invalid_request', 'request_too_large', 'unsupported_media_type'],
  // Every OPTIONS on this host is a public read's CORS preflight
  omitMethods: ['OPTIONS'],
});

export interface OpenApiRouteOptions {
  readonly config: PlatformConfig;
  // The limit per address that public documents share
  readonly limit: onRequestHookHandler;
  readonly logger: Logger;
}

/**
 * `GET /openapi.json`: the document, without a key, under the limit per address public documents share, readable
 * from any origin. Built once every route is registered, and kept. One that can't be built never stops the API: it
 * is logged once, and the route answers 503.
 */
export const registerOpenApiRoute = (app: FastifyInstance, { config, limit, logger }: OpenApiRouteOptions): void => {
  let document: Buffer | undefined;
  app.addHook('onReady', async () => {
    document = documentJson(() => createApiDocument(app, config), logger);
  });
  app.route({
    method: [...publicReadMethods],
    url: '/openapi.json',
    onRequest: [publicCors, limit],
    schema: {
      summary: 'This document',
      description: 'No key. Limited per address.',
      tags: ['openapi'],
      errors: ['rate_limited', 'document_unavailable'],
      response: { 200: documentSchema },
    },
    handler: async (request, reply) => sendDocument(request, reply, document, errorStatuses),
  });
};
