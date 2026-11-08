import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd, type Clock, type IdGenerator } from '@anyfare/common';
import type { Payment } from '@anyfare/core';
import { createLedger, createPaymentRepository, type Database } from '@anyfare/db';

import { authenticatedAccount } from '../accounts/auth.js';

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

    scope.get('/v1/balance', async request => {
      const { available, held } = await ledger.balance(authenticatedAccount(request).accountId);

      return { available: formatUsd(available), held: formatUsd(held) };
    });

    scope.get<{ Querystring: PageQuery }>('/v1/payments', { schema: { querystring: pageQuerySchema } }, async request => {
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
