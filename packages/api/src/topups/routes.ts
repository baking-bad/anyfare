import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';

import { formatUsd, recordErrorCode, toErrorResponse, type AnyfareError, type MicroUsd } from '@anyfare/common';
import { RateLimitedError, topupMessages, type RateLimit, type RateLimiter } from '@anyfare/core';
import type { Topup } from '@anyfare/db';
import { formatTokenAmount } from '@anyfare/topups';

import { authenticatedAccount, masterKeySecurity } from '../accounts/auth.js';
import { errorStatuses } from '../errors.js';
import { publicCors, publicReadMethods } from '../public/cors.js';
import { idParamsSchema, integer, list, nullableString, nullableTime, nullableUsdString, object, string, time, usdString } from '../schemas.js';
import { TopupMismatchError, TopupsUnavailableError, type TopupService } from './service.js';

export interface TopupRoutesOptions {
  readonly topups: TopupService;
  // Off, every top-up route answers 503
  readonly enabled: boolean;
  // The master key hook
  readonly authenticate: onRequestHookHandler;
  // The per-IP limit of public documents
  readonly documentsLimit: onRequestHookHandler;
  // Counts top-ups per account
  readonly limiter: RateLimiter;
  readonly limit: RateLimit;
}

// What top-ups add to the balance
const deliveredAsset = 'USDC on NEAR';

const createBodySchema = {
  type: 'object',
  properties: {
    network: { type: 'string', minLength: 1, maxLength: 64 },
    token: { type: 'string', minLength: 1, maxLength: 128 },
    // In the token's units; its decimals are checked against the token's own
    amount: { type: 'string', pattern: '^[0-9]{1,30}(\\.[0-9]{1,30})?$' },
  },
  required: ['network', 'token', 'amount'],
  additionalProperties: false,
} as const;

interface CreateBody {
  readonly network: string;
  readonly token: string;
  readonly amount: string;
}

interface TopupParams {
  readonly id: string;
}

const topupParamsSchema = idParamsSchema('The top-up\'s ID');

// The options as the route makes them: a network's tokens only when 1Click's list could be read, a token's address
// only when it has a contract. The serializer writes the required fields first, so a token's `decimals`, after the
// address it may not have, isn't listed as required: listed, it would move before the address.
const optionsSchema = object({
  asset: { type: 'string', description: 'What a top-up adds to the balance' },
  networks: list(object({
    name: string,
    minimum: { ...usdString, description: 'The least a top-up on it must be worth, in USD' },
    tokens: list(object({ symbol: string, address: string, decimals: { ...integer, description: 'Always there' } }, ['symbol'])),
  }, ['name', 'minimum'])),
});

// A top-up as `toTopupBody` makes it: amounts in the token's units, Credits in USD, and null for what it doesn't have yet
const nullableTokenUnits = { type: ['string', 'null'], description: 'In the token\'s units' } as const;
const topupSchema = object({
  id: string,
  status: string,
  message: string,
  network: string,
  token: string,
  amount: { type: 'string', description: 'In the token\'s units' },
  depositAddress: nullableString,
  depositMemo: nullableString,
  send: nullableTokenUnits,
  sendAtLeast: nullableTokenUnits,
  estimatedCredits: nullableUsdString,
  payBy: time,
  addressExpiresAt: nullableTime,
  createdAt: time,
  updatedAt: time,
  deposited: nullableTokenUnits,
  credited: nullableUsdString,
  transaction: { type: ['string', 'null'], description: 'The delivery\'s transaction on NEAR, once credited' },
  refunded: nullableTokenUnits,
  refundReason: nullableString,
});

const createErrors = [
  'rate_limited', 'topups_unavailable', 'unsupported_network', 'unknown_token', 'ambiguous_token', 'invalid_amount', 'amount_too_small', 'topup_refused',
  'topup_mismatch',
] as const;

/**
 * An expected 5xx, such as 1Click not answering: the service logged it at its own level, so it is
 * answered here, with the code on the request line, rather than by the error handler's error line.
 */
const answer = (request: FastifyRequest, reply: FastifyReply, error: AnyfareError): FastifyReply => {
  const { status, body } = toErrorResponse(error, errorStatuses);
  recordErrorCode(request, body.error.code);

  return reply.status(status).send(body);
};

const tokenUnits = (amount: bigint | undefined, decimals: number): string | null => amount === undefined ? null : formatTokenAmount(amount, decimals);
const usd = (amount: MicroUsd | undefined): string | null => amount === undefined ? null : formatUsd(amount);

/** A top-up as its account sees it: amounts in the token's units, Credits in USD, and null for what it doesn't have yet. */
const toTopupBody = (topup: Topup) => ({
  id: topup.id,
  status: topup.status,
  message: topupMessages[topup.status],
  network: topup.network,
  token: topup.tokenSymbol,
  amount: formatTokenAmount(topup.amount, topup.tokenDecimals),
  depositAddress: topup.depositAddress ?? null,
  depositMemo: topup.depositMemo ?? null,
  send: tokenUnits(topup.sendAmount, topup.tokenDecimals),
  sendAtLeast: tokenUnits(topup.sendAtLeast, topup.tokenDecimals),
  estimatedCredits: usd(topup.estimatedCredits),
  payBy: topup.payBy.toISOString(),
  addressExpiresAt: topup.addressExpiresAt?.toISOString() ?? null,
  createdAt: topup.createdAt.toISOString(),
  updatedAt: topup.updatedAt.toISOString(),
  deposited: tokenUnits(topup.depositedAmount, topup.tokenDecimals),
  credited: usd(topup.creditedAmount),
  // The delivery's transaction on NEAR, once credited
  transaction: topup.deliveryTxHash ?? null,
  refunded: tokenUnits(topup.refundedAmount, topup.tokenDecimals),
  refundReason: topup.refundReason ?? null,
});

/**
 * `GET /v1/topups/options` without a key, limited per client IP and readable from any origin, and behind the master key,
 * `POST /v1/topups` and `GET /v1/topups/{id}`. While top-ups are off, each answers
 * `503 topups_unavailable`.
 */
export const registerTopupRoutes = (app: FastifyInstance, { topups, enabled, authenticate, documentsLimit, limiter, limit }: TopupRoutesOptions): void => {
  const whenEnabled = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> =>
    enabled ? undefined : answer(request, reply, new TopupsUnavailableError('Top-ups are off'));

  // Each account's top-ups in a fixed window, under `rl:api:topups:<account ID>`
  const accountLimit = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { allowed, retryAfterSeconds } = await limiter.hit(`api:topups:${authenticatedAccount(request).accountId}`, limit);
    if (allowed)
      return;

    reply.header('retry-after', String(retryAfterSeconds));
    throw new RateLimitedError(retryAfterSeconds);
  };

  const options = async (request: FastifyRequest, reply: FastifyReply) => {
    const networks = await topups.options(request.log);
    const listed = networks.every(({ tokens }) => tokens !== undefined);
    // Without the token list the answer is only good until 1Click answers again
    reply.header('cache-control', listed ? 'public, max-age=60' : 'no-store');

    return {
      asset: deliveredAsset,
      networks: networks.map(({ network, tokens }) => ({
        name: network.name,
        minimum: formatUsd(network.minimum),
        ...tokens === undefined
          ? {}
          : { tokens: tokens.map(token => ({ symbol: token.symbol, ...token.contractAddress === undefined ? {} : { address: token.contractAddress }, decimals: token.decimals })) },
      })),
    };
  };
  // Keyless, so any origin may read it
  app.route({
    method: [...publicReadMethods],
    url: '/v1/topups/options',
    onRequest: [publicCors, whenEnabled, documentsLimit],
    schema: {
      summary: 'The networks and tokens a top-up can come from',
      description: 'No key. Limited per address. Without 1Click\'s token list, the networks come without `tokens`.',
      tags: ['topups'],
      errors: ['rate_limited', 'topups_unavailable'],
      response: { 200: optionsSchema },
    },
    handler: options,
  });

  app.register(async scope => {
    scope.addHook('onRequest', authenticate);
    scope.addHook('onRequest', whenEnabled);

    scope.post<{ Body: CreateBody }>('/v1/topups', {
      onRequest: accountLimit,
      schema: {
        summary: 'Ask for a deposit address that turns a token into Credits',
        description: 'Send the amount of the token to the deposit address before `payBy`. The Credits arrive once the swap is done.',
        tags: ['topups'],
        security: masterKeySecurity,
        errors: createErrors,
        body: createBodySchema,
        response: { 201: topupSchema },
      },
    }, async (request, reply) => {
      const { accountId } = authenticatedAccount(request);
      try {
        const topup = await topups.create({ accountId, requestId: request.id, ...request.body, log: request.log });

        return reply.status(201).header('cache-control', 'no-store').send(toTopupBody(topup));
      }
      catch (error) {
        if (error instanceof TopupsUnavailableError || error instanceof TopupMismatchError)
          return answer(request, reply, error);
        throw error;
      }
    });

    scope.get<{ Params: TopupParams }>('/v1/topups/:id', {
      schema: {
        summary: 'A top-up, and where it stands',
        tags: ['topups'],
        security: masterKeySecurity,
        errors: ['topups_unavailable', 'not_found'],
        params: topupParamsSchema,
        response: { 200: topupSchema },
      },
    }, async (request, reply) => {
      const topup = await topups.get({ accountId: authenticatedAccount(request).accountId, id: request.params.id });

      return reply.header('cache-control', 'no-store').send(toTopupBody(topup));
    });
  });
};
