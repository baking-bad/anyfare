import type { FastifyInstance } from 'fastify';

import { createServer, type IdGenerator, type Logger, type Server } from '@anyfare/common';
import type { PlatformConfig } from '@anyfare/core';
import type { Postgres, Redis } from '@anyfare/db';

import { errorStatuses } from './errors.js';

export interface ApiDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  readonly redis: Redis;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
  // The proxies in front, whose X-Forwarded-For gives the client IP. Default: none.
  readonly trustProxy?: string;
}

// A POST with `Content-Type: application/json` and no body has no body, rather than invalid JSON
const acceptEmptyJson = (app: FastifyInstance): void => {
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text === '')
      done(null, undefined);
    else
      parseJson(request, text, done);
  });
};

/** The Platform API on api.anyfare.agents.bakingbad.dev. Readiness covers Postgres and Redis. */
export const createApp = ({ logger, postgres, redis, requestIds, trustProxy }: ApiDependencies): Server => {
  const server = createServer({
    logger,
    errorStatuses,
    requestIds,
    trustProxy,
    readinessChecks: [
      { name: 'postgres', check: () => postgres.ping() },
      { name: 'redis', check: () => redis.ping() },
    ],
  });
  acceptEmptyJson(server.app);

  return server;
};
