import { readFileSync } from 'node:fs';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { buildOpenApiDocument, documentJson, registeredRoutes, sendDocument, type Logger, type OpenApiDocument } from '@anyfare/common';
import { rateLimitClient, RateLimitedError, type PlatformConfig, type RateLimiter } from '@anyfare/core';

import { errorStatuses } from '../errors.js';
import type { ProxyMetrics } from '../metrics.js';
import { paymentKeyScheme } from './key.js';

export const openApiPath = '/openapi.json';

// The answer is the document's JSON, sent as it was built: no serializer reads it
const documentSchema = { type: 'object', additionalProperties: true, description: 'This document: OpenAPI 3.1, as JSON' } as const;

const packageVersion = (): string => (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { readonly version: string }).version;

/** The pay host's OpenAPI document, from every route the app registered. */
export const createPayDocument = (app: FastifyInstance, config: PlatformConfig): OpenApiDocument => buildOpenApiDocument({
  title: 'Anyfare pay host',
  version: packageVersion(),
  description: 'Pays any x402 or MPP API for an AI agent: put this host in front of the API\'s link, and pay with a payment key, x402 or MPP. '
    + '`GET /_/check` quotes a link without paying. Accounts and payment keys are on the Platform API.',
  url: config.urls.pay,
  routes: registeredRoutes(app),
  errorStatuses,
  keys: { paymentKey: paymentKeyScheme },
  // A routed call's body goes on as bytes, whatever its type
  bodyErrors: ['request_too_large'],
});

export interface OpenApiRouteOptions {
  readonly config: PlatformConfig;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly metrics: Pick<ProxyMetrics, 'rateLimited' | 'rateLimiterError'>;
}

/**
 * `GET /openapi.json`: the document, without a key, limited per address under `rl:proxy:documents:<ip>` with the
 * platform's limit of public documents, readable from any origin. Built once every route is registered, and kept. One
 * that can't be built never stops the proxy, nor any paid call: it is logged once, and the route answers 503. While
 * Redis fails, the limit lets the request through, as the proxy's other limits do.
 */
export const registerOpenApiRoute = (app: FastifyInstance, { config, limiter, logger, metrics }: OpenApiRouteOptions): void => {
  let document: Buffer | undefined;
  app.addHook('onReady', async () => {
    document = documentJson(() => createPayDocument(app, config), logger);
  });
  const limit = async (request: FastifyRequest): Promise<void> => {
    let answer: Awaited<ReturnType<RateLimiter['hit']>>;
    try {
      answer = await limiter.hit(`proxy:documents:${rateLimitClient(request.ip)}`, config.rateLimits.documents);
    }
    catch (error) {
      metrics.rateLimiterError();
      logger.warn({ error, limit: 'documents' }, 'The rate limiter failed, so the request goes through');
      return;
    }
    if (answer.allowed)
      return;
    metrics.rateLimited('documents');
    throw new RateLimitedError(answer.retryAfterSeconds);
  };

  app.get(openApiPath, {
    onRequest: limit,
    schema: {
      summary: 'This document',
      description: 'No key. Limited per address.',
      tags: ['openapi'],
      errors: ['rate_limited', 'document_unavailable'],
      response: { 200: documentSchema },
    },
  }, async (request, reply) => sendDocument(request, reply, document, errorStatuses));
};
