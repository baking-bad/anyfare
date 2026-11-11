import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';

import type { Clock, Logger } from '@anyfare/common';
import type { PlatformConfig } from '@anyfare/core';
import { createCallRepository, type CallFilter, type Database } from '@anyfare/db';

import { NotFoundError } from '../errors.js';
import { publicCors, publicReadMethods } from '../public/cors.js';
import { createCallFeed } from './feed.js';
import {
  countCap, errorSchema, listQuerySchema, listResponseSchema, receiptParamsSchema, receiptSchema, streamEvents, streamQuerySchema, streamResponseSchema,
} from './schemas.js';
import { createCallStreams } from './stream.js';
import { createCallViews, type CallStatus, type CallView, type PaidWith } from './view.js';

export interface CallRoutesOptions {
  readonly db: Database;
  readonly config: PlatformConfig;
  // The `publicReads` limit per client IP. A stream counts once, when it opens.
  readonly limit: onRequestHookHandler;
  readonly clock: Clock;
  readonly logger: Logger;
  // How often the stream reads finished calls, and pings. Defaults: 1 s and 15 s.
  readonly timings?: { readonly pollMs?: number; readonly pingMs?: number };
}

interface Filters {
  readonly paidWith?: PaidWith;
  readonly service?: string;
  readonly host?: string;
  readonly endpoint?: string;
  readonly status?: CallStatus;
}

interface ListQuery extends Filters {
  readonly page: number;
  readonly size: number;
}

// An empty filter is no filter
const given = (value: string | undefined): string | undefined => value === undefined || value === '' ? undefined : value;

// The error answers of the list and the stream; a receipt can also be not found
const errors = { 400: errorSchema, 429: errorSchema } as const;
const receiptErrors = { ...errors, 404: errorSchema } as const;
// Hosts are kept lowercase, as routing writes them
const hostOf = (value: string | undefined): string | undefined => given(value)?.toLowerCase();

/**
 * `GET /v1/calls`, `GET /v1/calls/stream` and `GET /v1/calls/{id}`: finished calls, without a key,
 * limited per client IP, readable from any origin. They never name a Credits buyer, and never show a
 * routed call's query string, body or headers.
 */
export const registerCallRoutes = (app: FastifyInstance, { db, config, limit, clock, logger, timings = {} }: CallRoutesOptions): void => {
  const calls = createCallRepository({ db });
  const views = createCallViews(config);
  const feed = createCallFeed({ calls, clock, logger, ...timings.pollMs === undefined ? {} : { pollMs: timings.pollMs } });
  const streams = createCallStreams({ feed, views, caps: config.callStream, clock, ...timings.pingMs === undefined ? {} : { pingMs: timings.pingMs } });
  // Shutdown ends the streams first, so it never waits for one, then stops reading
  app.addHook('preClose', async () => streams.endAll());
  app.addHook('onClose', async () => feed.close());

  app.route<{ Querystring: ListQuery }>({
    method: [...publicReadMethods],
    url: '/v1/calls',
    onRequest: [publicCors, limit],
    schema: {
      summary: 'Finished calls, newest first, a page at a time',
      description: 'No key. Limited per address. A call never names a Credits buyer, nor shows the query string, the body or the headers it carried.',
      tags: ['calls'],
      errors: ['rate_limited'],
      querystring: listQuerySchema,
      response: { 200: listResponseSchema, ...errors },
    },
    handler: async (request, reply) => {
      const { page, size, status } = request.query;
      const service = given(request.query.service);
      const host = hostOf(request.query.host);
      const endpoint = given(request.query.endpoint);
      const paidWith = request.query.paidWith === undefined ? undefined : views.filterOf(request.query.paidWith);
      reply.header('cache-control', 'public, max-age=5');
      // A way to pay that this deployment has no network for: nothing matches
      if (request.query.paidWith !== undefined && paidWith === undefined)
        return { calls: [], page, size, total: 0, totalCapped: false };

      const filter: CallFilter = {
        ...paidWith === undefined ? {} : { paidWith },
        ...host === undefined ? {} : { host },
        ...service === undefined ? {} : { hostContains: service },
        ...endpoint === undefined ? {} : { path: endpoint },
        ...status === undefined ? {} : { outcome: status },
      };
      const found = await calls.list({ filter, offset: (page - 1) * size, limit: size, cap: countCap });

      return { calls: found.calls.map(views.callOf), page, size, total: found.total, totalCapped: found.totalCapped };
    },
  });

  app.route<{ Querystring: Filters }>({
    method: [...publicReadMethods],
    url: '/v1/calls/stream',
    onRequest: [publicCors, limit],
    schema: {
      summary: 'Finished calls as they happen, as server-sent events',
      description: 'No key. Limited per address, and in how many streams an address keeps open. The filters are those of the list.',
      tags: ['calls'],
      errors: ['rate_limited', 'shutting_down'],
      events: streamEvents,
      querystring: streamQuerySchema,
      response: { ...streamResponseSchema, ...errors, 503: errorSchema },
    },
    handler: async (request: FastifyRequest<{ Querystring: Filters }>, reply: FastifyReply) => {
      const { paidWith, status } = request.query;
      const service = given(request.query.service)?.toLowerCase();
      const host = hostOf(request.query.host);
      const endpoint = given(request.query.endpoint);
      const matches = (call: CallView): boolean => (paidWith === undefined || call.paidWith === paidWith)
        && (service === undefined || call.service.toLowerCase().includes(service))
        && (host === undefined || call.service === host)
        && (endpoint === undefined || call.path === endpoint)
        && (status === undefined || call.status === status);

      return streams.open(request, reply, matches);
    },
  });

  app.route<{ Params: { readonly id: string } }>({
    method: [...publicReadMethods],
    url: '/v1/calls/:id',
    onRequest: [publicCors, limit],
    schema: {
      summary: 'A finished call\'s receipt: who was paid what, and when',
      description: 'No key. Limited per address.',
      tags: ['calls'],
      errors: ['rate_limited', 'not_found'],
      params: receiptParamsSchema,
      response: { 200: receiptSchema, ...receiptErrors },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const record = id.startsWith('pay_') ? await calls.find(id) : undefined;
      if (!record)
        throw new NotFoundError('No finished call has this ID');
      const receipt = views.receiptOf(record);
      // A final payment never changes again; a settling one still does
      reply.header('cache-control', receipt.steps.some(step => step.step === 'settled' || step.step === 'released') ? 'public, max-age=60' : 'no-cache');

      return receipt;
    },
  });
};
