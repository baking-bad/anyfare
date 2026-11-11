import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd, type Clock, type IdGenerator } from '@anyfare/common';
import type { Payment } from '@anyfare/core';
import { createLedger, createPaymentRepository, type Database } from '@anyfare/db';

import { authenticatedAccount, masterKeySecurity } from '../accounts/auth.js';
import { list, nullableString, object, string, time, usdString } from '../schemas.js';

export interface LedgerRoutesOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  // The master key hook
  readonly authenticate: onRequestHookHandler;
}

const defaultPageSize = 50;
const maxPageSize = 100;

const pageQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: maxPageSize },
    after: { type: 'string', maxLength: 512 },
  },
  additionalProperties: false,
} as const;

interface PageQuery {
  readonly limit?: number;
  readonly after?: string;
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
  targetHost: string,
  targetPath: string,
  amount: usdString,
  status: string,
  createdAt: time,
  updatedAt: time,
});
const paymentsSchema = object({
  payments: list(paymentSchema),
  next: { type: ['string', 'null'], description: 'The next page\'s `after`. Null: the last page' },
});

/** A payment as its buyer sees it: what was called, the price, and where it stands. */
const toPaymentBody = (payment: Payment) => ({
  id: payment.id,
  requestId: payment.requestId ?? null,
  rail: payment.rail,
  targetHost: payment.targetHost,
  targetPath: payment.targetPath,
  amount: formatUsd(payment.amount),
  status: payment.status,
  createdAt: payment.createdAt.toISOString(),
  updatedAt: payment.updatedAt.toISOString(),
});

/** Behind the master key: `GET /v1/balance` and `GET /v1/payments`. Amounts are USD decimal strings. */
export const registerLedgerRoutes = (app: FastifyInstance, { db, clock, ids, authenticate }: LedgerRoutesOptions): void => {
  const ledger = createLedger({ db, clock, ids });
  const payments = createPaymentRepository({ db, clock });

  app.register(async scope => {
    scope.addHook('onRequest', authenticate);

    scope.get('/v1/balance', {
      schema: { summary: 'The Credits balance: what is available, and what calls in flight hold', tags: ['balance'], security: masterKeySecurity, response: { 200: balanceSchema } },
    }, async request => {
      const { available, held } = await ledger.balance(authenticatedAccount(request).accountId);

      return { available: formatUsd(available), held: formatUsd(held) };
    });

    scope.get<{ Querystring: PageQuery }>('/v1/payments', {
      schema: {
        summary: 'The account\'s paid calls, newest first, a page at a time',
        tags: ['balance'],
        security: masterKeySecurity,
        errors: ['invalid_request'],
        querystring: pageQuerySchema,
        response: { 200: paymentsSchema },
      },
    }, async request => {
      const { accountId } = authenticatedAccount(request);
      const page = await payments.listForBuyer({
        buyerAccountId: accountId,
        limit: request.query.limit ?? defaultPageSize,
        ...(request.query.after === undefined ? {} : { after: request.query.after }),
      });

      return { payments: page.payments.map(toPaymentBody), next: page.next ?? null };
    });
  });
};
