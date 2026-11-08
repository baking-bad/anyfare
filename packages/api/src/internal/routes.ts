import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AnyfareError, formatUsd, parseUsd, Secret, usdAmountPattern, type Clock, type IdGenerator } from '@anyfare/common';
import type { AuditLog } from '@anyfare/core';
import {
  createAccountRepository, createAuditLogRepository, createLedger, withTransaction, type Database, type DatabaseTransaction,
} from '@anyfare/db';

import { InvalidRequestError, NotFoundError } from '../errors.js';

// The shared secret every internal call carries
export const internalSecretHeader = 'x-internal-secret';
// Which app or operator calls, for the audit log. Optional.
export const internalCallerHeader = 'x-internal-caller';

const callerPattern = /^[a-z][a-z0-9-]{0,31}$/;

export interface InternalRoutesOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  // INTERNAL_API_SECRET. Without it, every internal call is refused.
  readonly secret: Secret | undefined;
  // The audit log inside a call's transaction. Default: the audit_log repository on it.
  readonly auditLog?: (tx: DatabaseTransaction) => AuditLog;
}

// The most one credit may be, in micro-USD. An operator's typo, such as an extra digit, stays small
// instead of growing the platform's shared balance toward the bigint limit.
const maxCreditAmount = 10_000_000_000n;

const creditBodySchema = {
  type: 'object',
  required: ['amount', 'reference'],
  properties: {
    amount: { type: 'string', pattern: usdAmountPattern, maxLength: 26 },
    // The idempotency key: an operator's ticket or transfer ID
    reference: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
  },
  additionalProperties: false,
} as const;

interface CreditBody {
  readonly amount: string;
  readonly reference: string;
}

/** An internal call without the right shared secret. */
class InternalUnauthorizedError extends AnyfareError {
  readonly code = 'unauthorized';

  constructor() {
    super(`The internal API needs the ${internalSecretHeader} header`);
  }
}

/**
 * The `onRequest` hook of the internal listener: the shared secret, compared with `Secret.equals`,
 * which is timing-safe. A missing or wrong one is `401 unauthorized`.
 */
export const createInternalAuth = (secret: Secret | undefined) => async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const header = request.headers[internalSecretHeader];
  const given = typeof header === 'string' && header !== '' ? Secret.from(header) : undefined;
  try {
    if (secret && given?.equals(secret))
      return;
  }
  finally {
    given?.destroy();
  }
  request.log.warn('An internal call without the right shared secret was refused');
  reply.header('www-authenticate', 'Bearer');
  throw new InternalUnauthorizedError();
};

/**
 * The internal API. `POST /internal/v1/accounts/{id}/credits` credits an account's balance, once
 * per `reference`. Every credit, a replay included, writes the audit log in the ledger's transaction;
 * a refused call writes nothing.
 */
export const registerInternalRoutes = (app: FastifyInstance, {
  db,
  clock,
  ids,
  secret,
  auditLog = tx => createAuditLogRepository({ db: tx, clock, ids }),
}: InternalRoutesOptions): void => {
  app.addHook('onRequest', createInternalAuth(secret));

  const callerOf = (request: FastifyRequest): string => {
    const header = request.headers[internalCallerHeader];

    return typeof header === 'string' && callerPattern.test(header) ? header : 'unknown';
  };

  app.post<{ Params: { readonly id: string }; Body: CreditBody }>('/internal/v1/accounts/:id/credits', {
    schema: { body: creditBodySchema },
  }, async (request, reply) => {
    const accountId = request.params.id;
    let amount: bigint;
    try {
      amount = parseUsd(request.body.amount);
    }
    catch {
      throw new InvalidRequestError('amount is too large');
    }
    if (amount === 0n)
      throw new InvalidRequestError('amount must be more than zero');
    if (amount > maxCreditAmount)
      throw new InvalidRequestError('amount is above the most one credit may be');
    if (!await createAccountRepository({ db }).findById(accountId))
      throw new NotFoundError('No such account');

    const caller = callerOf(request);
    const { reference } = request.body;
    const result = await withTransaction(db, async tx => {
      const credited = await createLedger({ db: tx, clock, ids }).credit({ accountId, amount, reference, requestId: request.id });
      await auditLog(tx).append({
        actor: { kind: 'internal_api', id: caller },
        action: 'ledger.credit',
        subject: { kind: 'account', id: accountId },
        requestId: request.id,
        details: { amount: amount.toString(), reference, transactionId: credited.transactionId, replayed: credited.replayed },
      });

      return credited;
    });
    request.log.info({ caller, accountId, amount: formatUsd(amount), reference, replayed: result.replayed }, 'An account was credited');

    return reply.status(result.replayed ? 200 : 201).send({
      transactionId: result.transactionId,
      accountId,
      amount: formatUsd(amount),
      reference,
      replayed: result.replayed,
      createdAt: result.createdAt.toISOString(),
    });
  });
};
