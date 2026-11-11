import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';

import {
  createServer, randomIdGenerator, systemClock, type Clock, type IdGenerator, type ListenOptions, type Logger, type Secret, type Server,
  type ServerAddresses,
} from '@anyfare/common';
import {
  cryptoRandomSource, type ApiKeyRepository, type InvalidationBus, type PlatformConfig, type RandomSource, type RateLimiter,
} from '@anyfare/core';
import {
  createApiKeyRepository, createRedisInvalidationBus, createRedisRateLimiter, type Postgres, type Redis,
} from '@anyfare/db';
import { createOneClickClient, createTokenCatalog, type OneClickClient, type TokenCatalog } from '@anyfare/topups';

import { createMasterKeyAuth, decorateAccount } from './accounts/auth.js';
import { createFreeCredits, createFreeCreditsCounter } from './accounts/freeCredits.js';
import { registerAccountRoutes } from './accounts/routes.js';
import { createAccountService } from './accounts/service.js';
import { createIpLimit, createSignupLimit } from './accounts/signupLimit.js';
import { registerCallRoutes } from './calls/routes.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import { errorStatuses } from './errors.js';
import { registerInternalRoutes } from './internal/routes.js';
import { registerKeyRoutes } from './keys/routes.js';
import { createPaymentKeyService } from './keys/service.js';
import { registerLedgerRoutes } from './ledger/routes.js';
import { createBlocklistCache } from './public/blocklist.js';
import { registerOpenApiRoute } from './public/openapi.js';
import { registerStatsRoutes } from './stats/routes.js';
import { registerTopupRoutes } from './topups/routes.js';
import { createTopupsCounter, createTopupService } from './topups/service.js';

export interface ApiDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  readonly redis: Redis;
  // Times of accounts, keys, and audit entries. Default: the system clock.
  readonly clock?: Clock;
  // IDs of accounts, keys, and audit entries. Default: random UUIDs.
  readonly ids?: IdGenerator;
  // Randomness for keys. Default: node:crypto.
  readonly random?: RandomSource;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
  // The proxies in front, whose X-Forwarded-For gives the client IP. Default: none.
  readonly trustProxy?: string;
  // Master key lookups. Default: the api_keys repository.
  readonly apiKeys?: Pick<ApiKeyRepository, 'findActiveByHash'>;
  // Where key changes are announced. Default: the Redis channel.
  readonly invalidation?: Pick<InvalidationBus, 'publish'>;
  // What counts the per-IP limits and the sign-up gift. Default: fixed windows in Redis.
  readonly limiter?: RateLimiter;
  // INTERNAL_API_SECRET, the shared secret of the internal API. Without it, every internal call is refused.
  readonly internalSecret?: Secret;
  // The 1Click API of NEAR Intents, which makes top-ups' deposit addresses. Default: a client of
  // config.topups's URL, without a key.
  readonly oneClick?: OneClickClient;
  // The tokens 1Click takes. Default: a catalog over `oneClick`.
  readonly tokenCatalog?: TokenCatalog;
  // How often the stream of calls reads finished calls, and pings its clients. Defaults: 1 s and 15 s.
  readonly callStreamTimings?: { readonly pollMs?: number; readonly pingMs?: number };
  // The calls a public number read when asked for counts at most. Default: 10,000.
  readonly statsReadCap?: number;
  // The public numbers' and the catalog's own pool, so no public read holds a connection the other routes need, the
  // internal ones and the paid path's above all. Default: `postgres`.
  readonly statsPostgres?: Postgres;
}

export interface ApiListenOptions extends ListenOptions {
  // The internal listener's port. Without it, the internal API doesn't listen.
  readonly internalPort?: number;
}

export interface ApiAddresses extends ServerAddresses {
  readonly internalPort: number | undefined;
}

/** The public listener and the metrics listener, plus the internal listener, which Traefik never routes to. */
export interface ApiServer extends Server {
  readonly internal: FastifyInstance;
  listen(options: ApiListenOptions): Promise<ApiAddresses>;
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
const robotsTxt = 'User-agent: *\nDisallow: /\n';

export const createApp = ({
  config,
  logger,
  postgres,
  redis,
  clock = systemClock,
  ids = randomIdGenerator,
  random = cryptoRandomSource,
  requestIds,
  trustProxy,
  apiKeys = createApiKeyRepository({ db: postgres.db }),
  invalidation = createRedisInvalidationBus({ redis, logger }),
  limiter = createRedisRateLimiter({ redis }),
  internalSecret,
  oneClick = createOneClickClient({ url: config.topups.url, timeoutMs: config.topups.timeoutMs }),
  tokenCatalog = createTokenCatalog({
    client: oneClick,
    clock,
    onStale: ({ error, ageMs }) => logger.warn({ error, ageMs }, 'The 1Click token list could not be refreshed, so top-ups use the older list'),
  }),
  callStreamTimings,
  statsReadCap,
  statsPostgres = postgres,
}: ApiDependencies): ApiServer => {
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
  const { app } = server;
  decorateAccount(app);
  acceptEmptyJson(app);

  const authenticate = createMasterKeyAuth({ keyPrefixes: config.keyPrefixes, apiKeys });
  registerAccountRoutes(app, {
    accounts: createAccountService({ db: postgres.db, clock, ids, random, keyPrefixes: config.keyPrefixes }),
    authenticate,
    signupLimit: createSignupLimit({ limiter, limit: config.rateLimits.signup }),
    freeCredits: createFreeCredits({ config: config.freeCredits, limiter, clock, record: createFreeCreditsCounter(server.metrics.registry) }),
  });
  registerKeyRoutes(app, {
    keys: createPaymentKeyService({
      db: postgres.db,
      clock,
      ids,
      random,
      keyPrefixes: config.keyPrefixes,
      defaultDailyBudget: config.paymentKeyDefaults.dailyBudget,
      invalidation,
      logger,
    }),
    authenticate,
    clock,
  });
  registerLedgerRoutes(app, { db: postgres.db, clock, ids, authenticate });
  // Public documents share one limit per client IP
  const documentsLimit = createIpLimit({ limiter, limit: config.rateLimits.documents, name: 'documents' });
  // The public reads of what routing listed, on the public reads' pool, with one read of the blocklist every few seconds
  const blocklist = createBlocklistCache({ db: statsPostgres.db, clock });
  registerCatalogRoutes(app, { db: statsPostgres.db, config, limit: documentsLimit, clock, blocklist });
  registerTopupRoutes(app, {
    topups: createTopupService({
      db: postgres.db,
      clock,
      ids,
      config: config.topups,
      keyPrefixes: config.keyPrefixes,
      oneClick,
      tokens: tokenCatalog,
      record: createTopupsCounter(server.metrics.registry),
    }),
    enabled: config.topups.enabled,
    authenticate,
    documentsLimit,
    limiter,
    limit: config.rateLimits.topups,
  });
  // Public reads of calls and numbers share one limit per client IP
  const publicReadsLimit = createIpLimit({ limiter, limit: config.rateLimits.publicReads, name: 'publicReads' });
  registerCallRoutes(app, {
    db: postgres.db, config, limit: publicReadsLimit, clock, logger, ...callStreamTimings === undefined ? {} : { timings: callStreamTimings },
  });
  registerStatsRoutes(app, {
    db: statsPostgres.db, config, limit: publicReadsLimit, clock, blocklist, ...statsReadCap === undefined ? {} : { readCap: statsReadCap },
  });
  // Of this listener's routes only, under the documents' limit
  registerOpenApiRoute(app, { config, limit: documentsLimit, logger });
  // This host keeps crawlers out on its own: none of its answers is a page to index
  app.get('/robots.txt', { schema: { hide: true } }, async (_request, reply) => reply.type('text/plain; charset=utf-8').send(robotsTxt));

  // The internal API on a listener of its own, with the same request IDs, logs, and error envelope
  const internal = createServer({ logger, errorStatuses, requestIds });
  registerInternalRoutes(internal.app, {
    db: postgres.db, clock, ids, secret: internalSecret, assetNames: new Set(config.assets.map(asset => asset.name)),
  });

  return {
    ...server,
    internal: internal.app,
    listen: async options => {
      const addresses = await server.listen(options);
      if (options.internalPort === undefined)
        return { ...addresses, internalPort: undefined };

      try {
        await internal.app.listen({ host: options.host, port: options.internalPort });
      }
      catch (error) {
        await server.close();
        throw error;
      }

      return { ...addresses, internalPort: (internal.app.server.address() as AddressInfo).port };
    },
    close: async () => {
      await internal.app.close();
      await server.close();
    },
  };
};
