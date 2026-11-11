import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  AnyfareError, createServer, OutboundHttp, randomIdGenerator, systemClock, type Clock, type IdGenerator, type Logger, type Secret, type Server,
} from '@anyfare/common';
import { RateLimitedError, type InvalidationBus, type PlatformConfig, type RateLimiter } from '@anyfare/core';
import {
  createCallRepository, createKeyStore, createLedger, createPaymentRepository, createRedisInvalidationBus, createRedisRateLimiter, createRedisReplayStore,
  createRoutingRepository, createStatsRepository, type CallRepository, type Postgres, type Redis, type RoutingRepository, type StatsRepository,
} from '@anyfare/db';
import {
  createCreditsRail, createMppRail, createX402Rail, detectMpp, detectX402, type ClaimStore, type MppSetup, type PaymentRail, type X402Setup,
} from '@anyfare/payments';

import { errorStatuses, RetryLaterError } from './errors.js';
import { createProxyMetrics } from './metrics.js';
import { createKeyCache, type KeyCacheSettings } from './payments/keyCache.js';
import { createProxyLimits } from './payments/limits.js';
import { createPaymentStep } from './payments/step.js';
import { registerKeyRoute } from './platform/key.js';
import { createCallDetailsRecorder } from './routing/callDetails.js';
import { checkHeadersSchema, checkQuerySchema, checkResponseSchema, createPayWays, type CheckQuery } from './routing/check.js';
import { createEndpointStats } from './routing/checkStats.js';
import { createRouting, type Routing } from './routing/routes.js';
import { createEndpointRegistrar, createOptOutCheck, type SignerClient } from './routing/support.js';

// Every method a routing link takes. HEAD is its own call: it never reaches a GET for free. Never
// TRACE: it echoes the request, our payment header included.
export const routedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

// Payment key cache defaults: key events keep entries fresh, the TTL is the safety net
export const keyCacheDefaults = {
  maxKeys: 10_000,
  ttlMs: 60_000,
  // Unknown hashes, so random keys don't reach Postgres
  missTtlMs: 10_000,
} as const satisfies KeyCacheSettings;

export interface ProxyDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  readonly redis: Redis;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
  // Calls targets. Default: Outbound HTTP with the production address policy, the platform's own hosts
  // refused, and the limits from platform config. Closed with the app.
  readonly http?: Pick<OutboundHttp, 'request'>;
  // Where key changes are announced. Default: the Redis channel, closed with the app.
  readonly invalidation?: InvalidationBus;
  // Milliseconds since the epoch, for the key cache's TTLs. Default: Date.now.
  readonly now?: () => number;
  readonly keyCache?: Partial<KeyCacheSettings>;
  // Payment and ledger times, key expiry, the UTC day, and payment deadlines. Default: the system clock.
  readonly clock?: Clock;
  // Payment and ledger IDs. Default: random UUIDs.
  readonly ids?: IdGenerator;
  // Default: fixed windows in Redis
  readonly rateLimiter?: RateLimiter;
  // The proxies in front, such as Traefik, whose X-Forwarded-For gives the client IP for the unpaid limit
  readonly trustProxy?: string;
  // x402 on Base and Solana, from `initializeX402`. Without it, an x402 payment gets the 402.
  readonly x402?: X402Setup;
  // MPP on Tempo, from `initializeMpp`. Without it, an MPP credential gets the 402.
  readonly mpp?: MppSetup;
  // One call per signed x402 payment, across every replica. Default: the Redis replay store, closed with the app.
  readonly claims?: ClaimStore;
  // The Signer that pays targets. Without it, routed calls answer 503 and nobody pays.
  readonly signer?: SignerClient;
  // The internal API, for routed endpoints. Without it, nothing is registered.
  readonly internalApi?: { readonly url: string; readonly secret: Secret };
  // The blocklist, endpoint fees, and target legs. Default: the routing tables.
  readonly routingRepository?: Pick<RoutingRepository, 'isBlocked' | 'endpointFee' | 'recordTargetPayment' | 'updateTargetPayment'>;
  // Where a paid call's method, payer and arrival are kept, best effort. Default: the call_details table.
  readonly callDetails?: Pick<CallRepository, 'recordDetails'>;
  // The endpoints' counted numbers `GET /_/check` shows. Default: the stats tables.
  readonly stats?: Pick<StatsRepository, 'endpoint'>;
}

export interface ProxyServer extends Server {
  // Resolves once the key cache receives invalidation events. The proxy serves before that.
  readonly subscribed: Promise<void>;
}

// A target's HTML must never run as the pay origin, which serves every target
const securityHeaders = {
  'content-security-policy': 'sandbox',
  'x-content-type-options': 'nosniff',
} as const;

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate, Payment-Receipt, Anyfare-Receipt, x-request-id',
} as const;
const preflightHeaders = {
  'access-control-allow-methods': routedMethods.join(', '),
  'access-control-allow-headers': 'Authorization, PAYMENT-SIGNATURE, X-PAYMENT, Content-Type',
  'access-control-max-age': '600',
} as const;

// First path segments the platform keeps for itself. Browsers ask for /favicon.ico and crawlers for
// /robots.txt on their own: neither is a routing link to a host of that name.
const platformSegments = new Set(['_', '.well-known', 'favicon.ico', 'robots.txt']);
// Crawlers stay off the pay host: every path on it is a routing link to someone else's API
const robotsTxt = 'User-agent: *\nDisallow: /\n';

// A 401 names the scheme it expects
const keyErrorCodes = new Set(['unauthorized', 'invalid_key', 'wrong_key_type']);

// The preflight of `GET /_/check`: GET only, and its header, which a POST check needs, only for our
// website. No other site's script may add it, so no other page can make us send a POST.
const checkPreflightHeaders = (origin: string, website: string): Record<string, string> => ({
  'access-control-allow-methods': 'GET',
  ...origin === website ? { 'access-control-allow-headers': 'X-Anyfare-Check' } : {},
  'access-control-max-age': '600',
  vary: 'Origin',
});

const registerResponseHeaders = (app: FastifyInstance, website: string): void => {
  // A CORS preflight is answered here, before any route: it never reaches a target
  app.addHook('onRequest', async (request, reply) => {
    const { origin } = request.headers;
    if (request.method !== 'OPTIONS' || origin === undefined || request.headers['access-control-request-method'] === undefined)
      return undefined;
    if (request.url.split('?', 1)[0] === '/_/check')
      return reply.status(204).headers(checkPreflightHeaders(origin, website)).send();

    return reply.status(204).headers(preflightHeaders).send();
  });
  // Headers that belong to an error: Retry-After on 429 and on a 503 worth retrying soon, the scheme on 401
  app.addHook('onError', async (_request, reply, error) => {
    if (error instanceof RateLimitedError || error instanceof RetryLaterError)
      reply.header('retry-after', String(error.retryAfterSeconds));
    else if (error instanceof AnyfareError && keyErrorCodes.has(error.code))
      reply.header('www-authenticate', 'Bearer');
  });
  // Every response, routed or not, including errors. A 402 is never cached.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers({ ...securityHeaders, ...corsHeaders });
    if (reply.statusCode === 402)
      reply.header('cache-control', 'no-store');

    return payload;
  });
};

/** `/<host>/<path>` for every method, with request bodies as bytes; the platform's own paths answer 404. */
const registerRoutingRoutes = (app: FastifyInstance, routing: Routing): void => {
  app.get<{ Querystring: CheckQuery }>('/_/check', {
    schema: { headers: checkHeadersSchema, querystring: checkQuerySchema, response: checkResponseSchema },
  }, async request => routing.check(request));
  app.get('/robots.txt', async (_request, reply) => reply.type('text/plain; charset=utf-8').send(robotsTxt));

  const dispatch = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const first = (request.raw.url ?? '/').split('?', 1)[0]!.split('/')[1] ?? '';
    if (platformSegments.has(first.toLowerCase())) {
      reply.callNotFound();
      return reply;
    }

    return routing.serve(request, reply);
  };
  app.register(async scope => {
    // Bodies pass through as bytes, whatever their type, up to the request body limit
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    scope.route({ method: [...routedMethods], url: '/*', handler: dispatch });
    scope.route({ method: [...routedMethods], url: '/', handler: dispatch });
  });
};

// What a check needs to know of node-postgres's pool, which drizzle keeps as `$client`
interface PoolCounts {
  readonly waitingCount: number;
  readonly idleCount: number;
  readonly totalCount: number;
  readonly options?: { readonly max?: number };
}

/**
 * Whether the database pool has no connection to spare: a query waits for one, or would. A check then
 * reads no numbers, so it never queues beside paid calls. Never busy without a pool to count.
 */
const poolBusy = (postgres: Postgres) => (): boolean => {
  const pool = (postgres.db as unknown as { readonly $client?: Partial<PoolCounts> }).$client;
  if (typeof pool?.waitingCount !== 'number' || typeof pool.idleCount !== 'number' || typeof pool.totalCount !== 'number')
    return false;

  return pool.waitingCount > 0 || (pool.idleCount === 0 && pool.totalCount >= (pool.options?.max ?? 10));
};

/**
 * The proxy on the pay host: routing links, `GET /_/check`, and `GET /_/key`. Readiness covers Postgres
 * and Redis, the enabled facilitators with x402, and the Tempo RPC with MPP.
 */
export const createApp = ({
  config,
  logger,
  postgres,
  redis,
  requestIds,
  http,
  invalidation,
  now,
  keyCache: keyCacheSettings = {},
  clock = systemClock,
  ids = randomIdGenerator,
  rateLimiter = createRedisRateLimiter({ redis }),
  trustProxy,
  x402,
  mpp,
  claims,
  signer,
  internalApi,
  routingRepository = createRoutingRepository({ db: postgres.db, clock }),
  callDetails: callDetailsStore = createCallRepository({ db: postgres.db }),
  stats = createStatsRepository({ db: postgres.db }),
}: ProxyDependencies): ProxyServer => {
  const server = createServer({
    logger,
    errorStatuses,
    requestIds,
    trustProxy,
    bodyLimit: config.sizeLimits.requestBodyBytes,
    readinessChecks: [
      { name: 'postgres', check: () => postgres.ping() },
      { name: 'redis', check: () => redis.ping() },
      // Every enabled facilitator answers /supported
      ...(x402?.facilitators ?? []).map(facilitator => ({
        name: `facilitator:${facilitator.name}`,
        check: async () => {
          await facilitator.getSupported();
        },
      })),
      // The Tempo RPC answers with mpp.network's chain ID
      ...(mpp ? [{ name: 'mpp', check: () => mpp.check(config.timeouts.connectMs) }] : []),
    ],
  });
  const { app } = server;
  const metrics = createProxyMetrics(server.metrics.registry);
  registerResponseHeaders(app, new URL(config.urls.website).origin);

  let targets = http;
  if (!targets) {
    const outbound = new OutboundHttp({
      ownHosts: config.ownHosts,
      connectTimeoutMs: config.timeouts.connectMs,
      totalTimeoutMs: config.timeouts.requestMs,
      maxRequestBytes: config.sizeLimits.requestBodyBytes,
      // Routing limits a paid answer itself, once it knows its status; this is the limit of anything else
      maxResponseBytes: config.sizeLimits.bufferedResponseBytes,
    });
    app.addHook('onClose', async () => outbound.close());
    targets = outbound;
  }
  let claimStore = claims;
  if (!claimStore) {
    const store = createRedisReplayStore({ redis });
    app.addHook('onClose', async () => store.close());
    claimStore = store;
  }

  // The credits rail, with keys from a short cache
  const keys = createKeyCache({
    ...keyCacheDefaults,
    ...keyCacheSettings,
    store: createKeyStore({ db: postgres.db }),
    now,
    onLookup: result => metrics.keyCacheLookup(result),
  });
  const ledger = createLedger({ db: postgres.db, clock, ids });
  const apiUrl = config.urls.api.replace(/\/+$/, '');
  const credits = createCreditsRail({
    keys,
    ledger,
    clock,
    keyPrefixes: config.keyPrefixes,
    signupUrl: `${apiUrl}/v1/accounts`,
    ...(config.topups.enabled ? { topUpUrl: `${apiUrl}/v1/topups`, topUpOptionsUrl: `${apiUrl}/v1/topups/options` } : {}),
  });
  const limits = createProxyLimits({ limiter: rateLimiter, limits: config.rateLimits, logger, metrics });
  const recorder = createPaymentRepository({ db: postgres.db, clock });
  const x402Rail = x402 ? createX402Rail({ setup: x402, recorder, ledger, claims: claimStore, clock, logger }) : undefined;
  const mppRail = mpp ? createMppRail({ setup: mpp, recorder, ledger, logger, clock, settleTimeoutMs: config.timeouts.settleMs }) : undefined;
  const rails: PaymentRail[] = [credits, ...(x402Rail ? [x402Rail] : []), ...(mppRail ? [mppRail] : [])];
  const payments = createPaymentStep({
    rails,
    // A rail that is off is still detected, so two credentials of any kind get 400
    detectors: [credits.detect, x402Rail?.detect ?? detectX402, mppRail?.detect ?? detectMpp],
    recorder,
    limits,
    ids,
    logger,
    metrics,
  });
  registerKeyRoute(app, { credits, limits, ledger, clock });
  const callDetails = createCallDetailsRecorder({ store: callDetailsStore });
  const routing = createRouting({
    config,
    http: targets,
    redis,
    payments,
    routing: routingRepository,
    ledger,
    signer,
    optedOut: createOptOutCheck({ http: targets, redis, logger }),
    registrar: createEndpointRegistrar({ url: internalApi?.url, secret: internalApi?.secret, logger }),
    callDetails,
    limitIp: ip => limits.unpaid(ip),
    limitProbe: ip => limits.probe(ip),
    // As the combined 402 offers them: the assets of the rails that take payments here
    payWays: createPayWays(config, { x402: x402?.assets ?? [], mpp: mpp && { network: mpp.network, assets: mpp.assets } }),
    endpointStats: createEndpointStats({ stats, busy: poolBusy(postgres), clock }).get,
    metrics,
    clock,
    logger,
  });
  registerRoutingRoutes(app, routing);
  // Shutdown finishes or releases the holds of the last answers, and lets the last details writes end
  app.addHook('onClose', async () => {
    await Promise.all([payments.drain(), callDetails.drain()]);
  });

  // Drop a key when it changes, and every key after a missed stretch
  const ownedBus = invalidation ? undefined : createRedisInvalidationBus({ redis, logger });
  const bus = invalidation ?? ownedBus!;
  const subscription = bus.subscribe(event => {
    metrics.invalidation(event.kind);
    if (event.kind === 'key')
      keys.invalidate(event.id);
  }, {
    onReconnect: () => {
      metrics.reconnect();
      keys.clear();
    },
  });
  let closing = false;
  // Without a subscription the cache still expires on its own, so the proxy serves meanwhile
  const subscribed = subscription.then(() => undefined, (error: unknown) => {
    // Closing ends a subscription that is still connecting; that is no failure
    if (!closing)
      logger.error({ error }, 'The key cache couldn\'t subscribe to invalidation events');
  });
  app.addHook('onClose', async () => {
    closing = true;
    // A subscription still connecting is dropped whenever it completes: closing never waits for Redis
    void subscription.then(unsubscribe => unsubscribe(), () => undefined);
    await ownedBus?.close();
    keys.clear();
  });

  return { ...server, subscribed };
};
