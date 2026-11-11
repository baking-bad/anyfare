import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { notFoundResponse, recordErrorCode } from '@anyfare/common';

// What the console's page may read of an answer, beside the headers every page may
const exposedHeaders = 'Retry-After, X-Request-Id';

const preflightHeaders = {
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '600',
} as const;

/**
 * Gives the console's CORS to every route `scope` registers after this call, and a preflight to each of their URLs.
 * Call it first in the scope, before the master key hook: one line per scope, none per route.
 */
export type AllowConsole = (scope: FastifyInstance) => void;

// An OPTIONS that isn't the console's preflight is answered as on a URL without the route, as it was before
const notFound = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
  recordErrorCode(request, notFoundResponse.body.error.code);

  return reply.status(404).send(notFoundResponse.body);
};

/**
 * CORS for the console on the routes behind the master key, whose page sends the key from the browser. Only the
 * console's origin, matched exactly, gets `Access-Control-Allow-Origin`, on every answer, errors too: the hook runs
 * before any other hook of the route, so its headers are set before anything can fail. Never with credentials: the
 * key travels in a header, not a cookie. The console's `OPTIONS` preflight is answered here with `204`, before the
 * key, any limit, or the handler, so it uses up nothing; any other `OPTIONS` answers `404`, as it did before. Another
 * origin, `null`, or none gets no CORS header and is served as before: the key is what protects the route. Every
 * answer says `Vary: Origin`, so no cache mixes the answers for two origins. Without a console origin, nothing at all.
 */
export const createConsoleCors = (consoleUrl: string | undefined): AllowConsole => {
  if (consoleUrl === undefined)
    return () => undefined;
  const origin = new URL(consoleUrl).origin;
  // Each URL that has its preflight, so two scopes never register one twice
  const preflights = new Set<string>();

  const hook = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    reply.header('vary', 'Origin');
    // A browser sends its origin serialized: lower case, without a default port. Compared as sent, nothing alike passes.
    const allowed = request.headers.origin === origin;
    if (allowed)
      reply.headers({ 'access-control-allow-origin': origin, 'access-control-expose-headers': exposedHeaders });
    if (request.method !== 'OPTIONS')
      return undefined;

    return allowed ? reply.status(204).headers(preflightHeaders).send() : notFound(request, reply);
  };

  return scope => {
    scope.addHook('onRequest', hook);
    scope.addHook('onRoute', function preflight(route) {
      if ([route.method].flat().includes('OPTIONS') || preflights.has(route.url))
        return;
      preflights.add(route.url);
      // Answered by the hook above, before the scope's other hooks: the handler is never reached
      this.route({ method: 'OPTIONS', url: route.routePath, handler: notFound });
    });
  };
};
