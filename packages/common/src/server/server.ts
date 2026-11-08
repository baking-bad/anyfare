import type { AddressInfo } from 'node:net';

import AjvCompiler from '@fastify/ajv-compiler';
import type { Registry } from '@prometheus-io/client';
import fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import type { Logger } from '../logging.js';
import { randomIdGenerator, type IdGenerator } from '../ports.js';
import { createErrorHandler, notFoundResponse, type ErrorStatusTable } from './errors.js';
import { registerHealthRoutes, type ReadinessCheck } from './health.js';
import { createMetricsRegistry, registerHttpMetrics, registerMetricsRoute } from './metrics.js';
import { createRequestIdGenerator, requestIdHeader } from './requestId.js';
import { recordErrorCode, RequestLogController } from './requestLog.js';

const defaultBodyLimit = 1_048_576;
// How long `close` lets requests in flight finish before it closes their connections: well under the
// 30 s an app's shutdown has in all, so the app's pools close too
const defaultCloseGraceMs = 20_000;

// Fastify's own Ajv options, which suit a query string: `?limit=5` becomes the number 5
const lenientAjvOptions = { coerceTypes: 'array', removeAdditional: true, useDefaults: true, allErrors: false } as const;
// A JSON body is taken as sent: a number is not a string, and an unknown field is not dropped
const strictAjvOptions = { ...lenientAjvOptions, coerceTypes: false, removeAdditional: false } as const;

/** Validates bodies strictly, and the query string, path parameters, and headers leniently. */
const setValidators = (app: FastifyInstance): void => {
  const factory = AjvCompiler();
  const lenient = factory({}, { customOptions: lenientAjvOptions });
  const strict = factory({}, { customOptions: strictAjvOptions });
  app.setValidatorCompiler(route => (route.httpPart === 'body' ? strict : lenient)(route));
};

interface BaseOptions {
  readonly logger: Logger;
  // The app's code-to-status table. Codes missing from it answer an opaque 500.
  readonly errorStatuses?: ErrorStatusTable;
  // Default: 1 MiB
  readonly bodyLimit?: number;
  // Request IDs for requests without a valid `x-request-id`. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
  // The proxies in front, such as Traefik, whose X-Forwarded-For `request.ip` follows: addresses and
  // CIDR ranges, comma-separated. Default: none, so `request.ip` is the peer address.
  readonly trustProxy?: string;
  // How long `close` lets requests in flight finish before it closes their connections. Default: 20 s.
  readonly closeGraceMs?: number;
}

interface FastifyOptions extends BaseOptions {
  // One log line per request. Off on the metrics listener, which Prometheus scrapes all day.
  readonly requestLogging: boolean;
}

export interface ServerOptions extends BaseOptions {
  // What `/_/ready` covers, such as Postgres and Redis. None: always ready.
  readonly readinessChecks?: readonly ReadinessCheck[];
  // Each readiness check's deadline. Default: 2 s.
  readonly readinessTimeoutMs?: number;
}

export interface ServerAddresses {
  readonly port: number;
  readonly metricsPort: number;
}

export interface ListenOptions extends ServerAddresses {
  readonly host: string;
}

/** An app's public listener, plus its metrics listener on a port of its own. */
export interface Server {
  // The public listener. Apps add their routes here before `listen`.
  readonly app: FastifyInstance;
  readonly metrics: MetricsServer;
  /** Starts both listeners and returns their ports. Port 0 picks a free one. */
  listen(options: ListenOptions): Promise<ServerAddresses>;
  /** Stops accepting, waits for in-flight requests (`closeGraceMs` at most), then closes the metrics listener. */
  close(): Promise<void>;
}

export type MetricsServerOptions = Pick<ServerOptions, 'logger' | 'readinessChecks' | 'readinessTimeoutMs' | 'closeGraceMs'> & {
  // Also serve `/_/health` and `/_/ready`, for an app with no public listener. Default: false.
  readonly health?: boolean;
};

/** The internal metrics listener: `GET /metrics`, and for an app without a public listener, health too. */
export interface MetricsServer {
  readonly app: FastifyInstance;
  readonly registry: Registry;
  /** Starts the listener and returns its port. Port 0 picks a free one. */
  listen(options: { readonly host: string; readonly port: number }): Promise<number>;
  close(): Promise<void>;
}

/**
 * How a listener closes: it takes no new connection, and closes its idle keep-alive connections at
 * once, as Node's `close` does. A connection whose request is in flight closes once its response is
 * sent, which says `Connection: close`: left open, it would idle for the keep-alive timeout, 72 s,
 * and `close` would wait on it. A connection still open `graceMs` after `close` began is closed then.
 */
const closeConnectionsOnClose = (app: FastifyInstance, graceMs: number): void => {
  let closing = false;
  let grace: NodeJS.Timeout | undefined;
  app.addHook('preClose', async () => {
    closing = true;
    grace = setTimeout(() => {
      app.server.getConnections((_error, count) => {
        if (count > 0)
          app.log.warn({ connections: count, graceMs }, 'Closed the connections still open at the end of the shutdown grace');
      });
      app.server.closeAllConnections();
    }, graceMs);
    grace.unref();
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (closing)
      reply.header('connection', 'close');

    return payload;
  });
  // A response whose headers went out before `close` began
  app.addHook('onResponse', async () => {
    if (closing)
      app.server.closeIdleConnections();
  });
  app.addHook('onClose', async () => clearTimeout(grace));
};

const createFastify = ({
  logger,
  errorStatuses = {},
  bodyLimit = defaultBodyLimit,
  requestIds = randomIdGenerator,
  trustProxy,
  closeGraceMs = defaultCloseGraceMs,
  requestLogging,
}: FastifyOptions): FastifyInstance => {
  const app = fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Request logs with metadata only, and the request ID on every line
    logController: new RequestLogController({ enabled: requestLogging }),
    // A HEAD route would reach a paid GET for free
    exposeHeadRoutes: false,
    // While draining, requests on open connections are still served, with `Connection: close`
    return503OnClosing: false,
    bodyLimit,
    trustProxy: trustProxy ?? false,
    requestIdHeader: false,
    genReqId: createRequestIdGenerator(requestIds),
  });
  setValidators(app);
  closeConnectionsOnClose(app, closeGraceMs);
  app.setErrorHandler(createErrorHandler(errorStatuses));
  app.setNotFoundHandler(async (request, reply) => {
    recordErrorCode(request, notFoundResponse.body.error.code);

    return reply.status(404).send(notFoundResponse.body);
  });

  return app;
};

const listenOn = async (app: FastifyInstance, host: string, port: number): Promise<number> => {
  await app.listen({ host, port });

  return (app.server.address() as AddressInfo).port;
};

export const createMetricsServer = ({
  logger,
  readinessChecks = [],
  readinessTimeoutMs,
  closeGraceMs,
  health = false,
}: MetricsServerOptions): MetricsServer => {
  const app = createFastify({ logger, requestLogging: false, ...closeGraceMs === undefined ? {} : { closeGraceMs } });
  const registry = createMetricsRegistry();
  registerMetricsRoute(app, registry);
  if (health)
    registerHealthRoutes(app, { checks: readinessChecks, timeoutMs: readinessTimeoutMs });

  return {
    app,
    registry,
    listen: ({ host, port }) => listenOn(app, host, port),
    close: () => app.close(),
  };
};

/**
 * The server every app with a public listener runs:
 * - the request ID from a valid `x-request-id`, or a new one, on the response and every log line;
 * - one log line per request with method, route, status, sizes, latency, and request ID, never the URL;
 * - the error envelope, with statuses from the app's table, and `404 not_found` for unknown routes;
 * - no automatic HEAD routes;
 * - `/_/health` and `/_/ready`;
 * - request count and latency on the metrics listener;
 * - a `close` that waits for requests in flight, `closeGraceMs` at most, never for idle connections.
 */
export const createServer = ({ readinessChecks = [], readinessTimeoutMs, ...options }: ServerOptions): Server => {
  const app = createFastify({ ...options, requestLogging: true });
  const metrics = createMetricsServer({ logger: options.logger, ...options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs } });

  app.addHook('onRequest', async (request, reply) => {
    reply.header(requestIdHeader, request.id);
  });
  registerHttpMetrics(app, metrics.registry);
  registerHealthRoutes(app, { checks: readinessChecks, timeoutMs: readinessTimeoutMs });

  return {
    app,
    metrics,
    listen: async ({ host, port, metricsPort }) => {
      const [publicPort, internalPort] = await Promise.allSettled([listenOn(app, host, port), metrics.listen({ host, port: metricsPort })]);
      if (publicPort.status === 'rejected' || internalPort.status === 'rejected') {
        // Such as a port in use. Neither listener stays open.
        await Promise.allSettled([app.close(), metrics.close()]);
        throw publicPort.status === 'rejected' ? publicPort.reason : (internalPort as PromiseRejectedResult).reason;
      }

      return { port: publicPort.value, metricsPort: internalPort.value };
    },
    close: async () => {
      await app.close();
      await metrics.close();
    },
  };
};
