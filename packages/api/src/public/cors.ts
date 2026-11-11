import type { FastifyReply, FastifyRequest } from 'fastify';

// Methods of a keyless public read, and its preflight
export const publicReadMethods = ['GET', 'OPTIONS'] as const;

const preflightHeaders = {
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Accept, Cache-Control, Content-Type, Last-Event-ID',
  'access-control-max-age': '600',
} as const;

/**
 * CORS for a keyless public read, never for a route behind a key: any origin may read it, without
 * credentials, and its errors too. The route takes `publicReadMethods`, and this hook, first of its
 * `onRequest` hooks, answers the `OPTIONS` preflight itself, so a preflight reaches no limit and no handler.
 */
export const publicCors = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
  reply.headers({
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Retry-After, X-Request-Id',
  });
  if (request.method === 'OPTIONS')
    return reply.status(204).headers(preflightHeaders).send();

  return undefined;
};
