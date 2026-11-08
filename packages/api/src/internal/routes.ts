import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AnyfareError, formatUsd, parseUsd, Secret, usdAmountPattern, type Clock, type IdGenerator } from '@anyfare/common';
import type { AuditLog } from '@anyfare/core';
import {
  createAccountRepository, createAuditLogRepository, createLedger, createRoutingRepository, createTreasuryRepository, withTransaction,
  type Database, type DatabaseTransaction,
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
  // The asset registry's names, for treasury transfers
  readonly assetNames: ReadonlySet<string>;
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

const assetAmount = {
  type: 'object',
  required: ['asset', 'amount'],
  properties: {
    asset: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' },
    amount: { type: 'string', pattern: usdAmountPattern, maxLength: 26 },
  },
  additionalProperties: false,
} as const;

const transferBodySchema = {
  type: 'object',
  required: ['reference', 'from', 'to', 'transactions'],
  properties: {
    reference: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
    from: assetAmount,
    to: assetAmount,
    // The operator's references: transaction hashes or explorer links
    transactions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 256 } },
  },
  additionalProperties: false,
} as const;

interface TransferBody {
  readonly reference: string;
  readonly from: { readonly asset: string; readonly amount: string };
  readonly to: { readonly asset: string; readonly amount: string };
  readonly transactions: readonly string[];
}

// A lowercase DNS name, as `new URL(...).hostname` gives it
const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

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
 * per `reference`. The proxy registers routed endpoints, and operators set their fees, block hosts,
 * and record treasury transfers. Every call that changes something writes the audit log in its
 * transaction; a refused call writes nothing.
 */
export const registerInternalRoutes = (app: FastifyInstance, {
  db,
  clock,
  ids,
  secret,
  assetNames,
  auditLog = tx => createAuditLogRepository({ db: tx, clock, ids }),
}: InternalRoutesOptions): void => {
  app.addHook('onRequest', createInternalAuth(secret));

  const callerOf = (request: FastifyRequest): string => {
    const header = request.headers[internalCallerHeader];

    return typeof header === 'string' && callerPattern.test(header) ? header : 'unknown';
  };

  const routing = createRoutingRepository({ db, clock });
  const audit = (request: FastifyRequest, action: `${string}.${string}`, subject: { kind: string; id: string }, details: Record<string, string | number | null>) =>
    withTransaction(db, tx => auditLog(tx).append({ actor: { kind: 'internal_api', id: callerOf(request) }, action, subject, requestId: request.id, details }));

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

  // The proxy registers an endpoint that answered 402, once, up to the cap per host
  app.put<{ Body: { readonly host: string; readonly path: string; readonly quote?: string } }>('/internal/v1/routed-endpoints', {
    schema: { body: {
      type: 'object', required: ['host', 'path'], additionalProperties: false,
      properties: {
        host: { type: 'string', maxLength: 253 },
        path: { type: 'string', pattern: '^/', maxLength: 2048 },
        // The last quote, in USD, for the catalog
        quote: { type: 'string', pattern: usdAmountPattern, maxLength: 26 },
      },
    } },
  }, async (request, reply) => {
    const { host, path, quote } = request.body;
    // The host as the routing link names it: a lowercase DNS name, with a port when one was given
    const [hostname = '', port] = host.split(':');
    if (!hostPattern.test(hostname) || (port !== undefined && !/^\d{1,5}$/.test(port)) || host.split(':').length > 2)
      throw new InvalidRequestError('host must be a lowercase DNS name, with an optional port');
    let lastPrice: bigint | undefined;
    try {
      lastPrice = quote === undefined ? undefined : parseUsd(quote);
    }
    catch {
      throw new InvalidRequestError('quote is too large');
    }
    const result = await routing.registerEndpoint({ host, path, ...lastPrice === undefined ? {} : { lastPrice } });
    if (result === 'created')
      await audit(request, 'routing.endpoint_register', { kind: 'routed_endpoint', id: `${host}${path}` }, { host, path });
    // Under the routed call's request ID, which the proxy sends along
    request.log[result === 'created' ? 'info' : 'debug']({ caller: callerOf(request), host, path, result }, 'A routed endpoint was registered');

    return reply.status(result === 'created' ? 201 : 200).send({ host, path, result });
  });

  // An endpoint's own fee, or null for routingFeeBps
  app.put<{ Params: { readonly host: string }; Body: { readonly path: string; readonly feeBps: number | null } }>('/internal/v1/routed-endpoints/:host/fee', {
    schema: { body: {
      type: 'object', required: ['path', 'feeBps'], additionalProperties: false,
      properties: { path: { type: 'string', pattern: '^/', maxLength: 2048 }, feeBps: { type: ['integer', 'null'], minimum: 0, maximum: 10_000 } },
    } },
  }, async request => {
    const { host } = request.params;
    const { path, feeBps } = request.body;
    if (!await routing.setEndpointFee({ host, path, feeBps }))
      throw new NotFoundError('No such routed endpoint');
    await audit(request, 'routing.endpoint_fee', { kind: 'routed_endpoint', id: `${host}${path}` }, { feeBps });

    return { host, path, feeBps };
  });

  // Hosts the proxy refuses
  app.put<{ Params: { readonly host: string }; Body: { readonly reason: string } }>('/internal/v1/blocklist/:host', {
    schema: { body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } } },
  }, async request => {
    const { host } = request.params;
    if (!hostPattern.test(host))
      throw new InvalidRequestError('host must be a lowercase DNS name');
    await routing.block({ host, reason: request.body.reason });
    await audit(request, 'routing.block', { kind: 'host', id: host }, { reason: request.body.reason });
    request.log.info({ caller: callerOf(request), host }, 'A host was blocklisted');

    return { host, blocked: true };
  });

  app.delete<{ Params: { readonly host: string } }>('/internal/v1/blocklist/:host', async request => {
    const { host } = request.params;
    if (!await routing.unblock(host))
      throw new NotFoundError('The host isn\'t blocked');
    await audit(request, 'routing.unblock', { kind: 'host', id: host }, {});
    request.log.info({ caller: callerOf(request), host }, 'A host left the blocklist');

    return { host, blocked: false };
  });

  // An operator records a rebalancing they did, with its transactions. The ledger books it once.
  app.post<{ Body: TransferBody }>('/internal/v1/treasury/transfers', { schema: { body: transferBodySchema } }, async (request, reply) => {
    const { reference, from, to, transactions } = request.body;
    let fromAmount: bigint;
    let toAmount: bigint;
    try {
      fromAmount = parseUsd(from.amount);
      toAmount = parseUsd(to.amount);
    }
    catch {
      throw new InvalidRequestError('An amount is too large');
    }
    if (fromAmount === 0n || toAmount === 0n)
      throw new InvalidRequestError('Both amounts must be more than zero');
    if (toAmount > fromAmount)
      throw new InvalidRequestError('A transfer can\'t gain USD: what arrives is at most what left');
    if (from.asset === to.asset)
      throw new InvalidRequestError('A transfer moves between two different assets');
    if (!assetNames.has(from.asset) || !assetNames.has(to.asset))
      throw new InvalidRequestError('Both assets must be in the asset registry');

    const actor = { kind: 'internal_api', id: callerOf(request) } as const;
    const result = await withTransaction(db, async tx => {
      // The same reference again with the same input is a replay; with another input, the ledger throws a conflict
      const booked = await createLedger({ db: tx, clock, ids }).treasuryTransfer({
        reference, from: { asset: from.asset, amount: fromAmount }, to: { asset: to.asset, amount: toAmount }, requestId: request.id,
      });
      if (!booked.replayed) {
        await createTreasuryRepository({ db: tx }).recordTransfer({
          reference, fromAsset: from.asset, fromAmount, toAsset: to.asset, toAmount, transactions: [...transactions], recordedBy: actor.id,
          ledgerTransactionId: booked.transactionId, createdAt: booked.createdAt,
        });
      }
      await auditLog(tx).append({
        actor, action: 'treasury.transfer', subject: { kind: 'treasury_transfer', id: reference }, requestId: request.id,
        details: { from: from.asset, fromAmount: fromAmount.toString(), to: to.asset, toAmount: toAmount.toString(), replayed: booked.replayed },
      });

      return booked;
    });

    request.log.info({
      caller: actor.id, reference, from: from.asset, fromAmount: formatUsd(fromAmount), to: to.asset, toAmount: formatUsd(toAmount), replayed: result.replayed,
    }, 'A treasury transfer was recorded');

    return reply.status(result.replayed ? 200 : 201).send({
      reference, transactionId: result.transactionId, conversionCost: formatUsd(fromAmount - toAmount), replayed: result.replayed,
      createdAt: result.createdAt.toISOString(),
    });
  });
};
