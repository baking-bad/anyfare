import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd, type Clock, type IdGenerator } from '@anyfare/common';
import type { Payment } from '@anyfare/core';
import { createLedger, createPaymentRepository, paymentStateOf, paymentStates, type Database, type PaymentState } from '@anyfare/db';

import { authenticatedAccount, masterKeySecurity } from '../accounts/auth.js';
import type { AllowConsole } from '../accounts/consoleCors.js';
import { StatsUnavailableError } from '../errors.js';
import { closedQuery, list, nullableString, object, pageQueryProperties, string, time, usdString } from '../schemas.js';

export interface LedgerRoutesOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  // The master key hook
  readonly authenticate: onRequestHookHandler;
  // The console's CORS, first in the scope
  readonly allowConsole: AllowConsole;
}

const defaultPageSize = 50;
// The list gives up after this and answers 503: a filter that matches few of an account's many payments reads every
// one of them, so it could otherwise hold a connection long
const paymentsReadTimeoutMs = 2_000;

const paymentsQuerySchema = closedQuery({
  ...pageQueryProperties(defaultPageSize),
  state: { type: 'string', enum: [...paymentStates], description: '`paid`: charged. `free`: not charged. `pending`: in flight' },
  keyId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', maxLength: 64, description: 'The ID of the payment key that paid' },
  // The exact host, without a NUL, which Postgres can't take
  service: { type: 'string', pattern: '^[^\\u0000]+$', maxLength: 255, description: 'The exact host called, without case, with its port when it has one' },
});

interface PaymentsQuery {
  readonly limit?: number;
  readonly after?: string;
  readonly state?: PaymentState;
  readonly keyId?: string;
  readonly service?: string;
}

const balanceSchema = object({
  available: { ...usdString, description: 'What the account can spend now, in USD' },
  held: { ...usdString, description: 'What calls in flight hold, in USD' },
});
// A payment as `toPaymentBody` makes it
const paymentSchema = object({
  id: string,
  requestId: nullableString,
  rail: string,
  keyId: { type: ['string', 'null'], description: 'The payment key that paid: null for a payment on a chain' },
  targetHost: string,
  targetPath: { type: 'string', description: 'The path only: a call\'s query string is never kept' },
  amount: usdString,
  status: string,
  state: { type: 'string', enum: [...paymentStates], description: '`paid`: charged. `free`: not charged. `pending`: in flight' },
  upstreamStatus: { type: ['integer', 'null'], description: 'The HTTP status the paid API answered: null before it answered, or when it didn\'t' },
  createdAt: time,
  updatedAt: time,
});
const paymentsSchema = object({
  payments: list(paymentSchema),
  next: { type: ['string', 'null'], description: 'The next page\'s `after`. Null: the last page' },
});

/** A payment as its buyer sees it: what was called, with which key, the price, and where it stands. */
const toPaymentBody = (payment: Payment) => ({
  id: payment.id,
  requestId: payment.requestId ?? null,
  rail: payment.rail,
  keyId: payment.keyId ?? null,
  targetHost: payment.targetHost,
  targetPath: payment.targetPath,
  amount: formatUsd(payment.amount),
  status: payment.status,
  state: paymentStateOf(payment.status),
  upstreamStatus: payment.upstreamStatus ?? null,
  createdAt: payment.createdAt.toISOString(),
  updatedAt: payment.updatedAt.toISOString(),
});

// Postgres gave up on the statement: its statement timeout
const statementCanceled = '57014';
const isStatementTimeout = (error: unknown): boolean => {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if ((cause as { code?: unknown }).code === statementCanceled)
      return true;

  return false;
};

/**
 * Behind the master key: `GET /v1/balance` and `GET /v1/payments`, which takes filters by state, key and host. Amounts
 * are USD decimal strings. The console's origin may call each.
 */
export const registerLedgerRoutes = (app: FastifyInstance, { db, clock, ids, authenticate, allowConsole }: LedgerRoutesOptions): void => {
  const ledger = createLedger({ db, clock, ids });
  const payments = createPaymentRepository({ db, clock });

  app.register(async scope => {
    allowConsole(scope);
    scope.addHook('onRequest', authenticate);

    scope.get('/v1/balance', {
      schema: { summary: 'The Credits balance: what is available, and what calls in flight hold', tags: ['balance'], security: masterKeySecurity, response: { 200: balanceSchema } },
    }, async request => {
      const { available, held } = await ledger.balance(authenticatedAccount(request).accountId);

      return { available: formatUsd(available), held: formatUsd(held) };
    });

    scope.get<{ Querystring: PaymentsQuery }>('/v1/payments', {
      schema: {
        summary: 'The account\'s paid calls, newest first, a page at a time',
        description: 'The filters combine: each one given must match. `after` goes on from where the page before stopped, whatever its '
          + 'filters were. A read that can\'t finish in time answers 503.',
        tags: ['balance'],
        security: masterKeySecurity,
        errors: ['invalid_request', 'stats_unavailable'],
        querystring: paymentsQuerySchema,
        response: { 200: paymentsSchema },
      },
    }, async request => {
      const { accountId } = authenticatedAccount(request);
      const { limit = defaultPageSize, after, state, keyId, service } = request.query;
      const page = await payments.listForBuyer({
        buyerAccountId: accountId,
        limit,
        ...after === undefined ? {} : { after },
        filter: {
          ...state === undefined ? {} : { state },
          ...keyId === undefined ? {} : { keyId },
          // Routing keeps hosts lowercase
          ...service === undefined ? {} : { targetHost: service.toLowerCase() },
        },
        timeoutMs: paymentsReadTimeoutMs,
      }).catch((error: unknown) => {
        if (isStatementTimeout(error))
          throw new StatsUnavailableError('The payments can\'t be read right now: try again shortly', { cause: error });
        throw error;
      });

      return { payments: page.payments.map(toPaymentBody), next: page.next ?? null };
    });
  });
};
