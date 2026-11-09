import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';

import { formatUsd, recordErrorCode, toErrorResponse, type AnyfareError, type MicroUsd } from '@anyfare/common';
import { RateLimitedError, topupMessages, type RateLimit, type RateLimiter } from '@anyfare/core';
import type { Topup } from '@anyfare/db';
import { formatTokenAmount } from '@anyfare/topups';

import { authenticatedAccount } from '../accounts/auth.js';
import { errorStatuses } from '../errors.js';
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
 * `GET /v1/topups/options` without a key, limited per client IP, and behind the master key,
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

  app.get('/v1/topups/options', { onRequest: [whenEnabled, documentsLimit] }, async (request, reply) => {
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
  });

  app.register(async scope => {
    scope.addHook('onRequest', authenticate);
    scope.addHook('onRequest', whenEnabled);

    scope.post<{ Body: CreateBody }>('/v1/topups', { onRequest: accountLimit, schema: { body: createBodySchema } }, async (request, reply) => {
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

    scope.get<{ Params: TopupParams }>('/v1/topups/:id', async (request, reply) => {
      const topup = await topups.get({ accountId: authenticatedAccount(request).accountId, id: request.params.id });

      return reply.header('cache-control', 'no-store').send(toTopupBody(topup));
    });
  });
};
