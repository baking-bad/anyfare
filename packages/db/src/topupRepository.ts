import { and, asc, eq, lt } from 'drizzle-orm';

import type { Clock, MicroUsd } from '@anyfare/common';
import type { JsonObject, TopupStatus } from '@anyfare/core';

import type { DatabaseExecutor } from './postgres.js';
import { topups } from './schema/topups.js';

export interface TopupRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
}

/** A top-up as the code reads it: amounts as bigint, times as Date, and what the row doesn't have yet undefined. */
export interface Topup {
  readonly id: string;
  readonly accountId: string;
  readonly requestId: string | undefined;
  readonly status: TopupStatus;
  // Our name for the network, such as base, and 1Click's
  readonly network: string;
  readonly blockchain: string;
  readonly tokenSymbol: string;
  // 1Click's asset ID
  readonly originAsset: string;
  readonly tokenDecimals: number;
  // What the client asked for, in the token's atomic units
  readonly amount: bigint;
  // The registry asset's name, such as near-usdc
  readonly destinationAsset: string;
  readonly recipient: string;
  readonly refundTo: string;
  readonly payBy: Date;
  readonly quoteRequest: JsonObject;
  readonly quoteResponse: JsonObject | undefined;
  readonly correlationId: string | undefined;
  readonly depositAddress: string | undefined;
  readonly depositMemo: string | undefined;
  readonly addressExpiresAt: Date | undefined;
  // In the token's atomic units
  readonly sendAmount: bigint | undefined;
  readonly sendAtLeast: bigint | undefined;
  readonly estimatedCredits: MicroUsd | undefined;
  readonly quoteError: string | undefined;
  readonly oneClickStatus: string | undefined;
  readonly lastStatus: JsonObject | undefined;
  readonly depositedAmount: bigint | undefined;
  readonly creditedAmount: MicroUsd | undefined;
  readonly ledgerTransactionId: string | undefined;
  readonly deliveryTxHash: string | undefined;
  readonly refundedAmount: bigint | undefined;
  readonly refundReason: string | undefined;
  readonly refundTxHash: string | undefined;
  readonly originTxHashes: readonly string[];
  readonly needsReview: boolean;
  readonly reviewReason: string | undefined;
  readonly nextPollAt: Date | undefined;
  readonly lastPolledAt: Date | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A top-up about to ask 1Click for its deposit address. */
export interface NewTopup {
  readonly id: string;
  readonly accountId: string;
  readonly requestId: string | undefined;
  readonly network: string;
  readonly blockchain: string;
  readonly tokenSymbol: string;
  readonly originAsset: string;
  readonly tokenDecimals: number;
  readonly amount: bigint;
  readonly destinationAsset: string;
  readonly recipient: string;
  readonly refundTo: string;
  readonly payBy: Date;
  // Exactly what is sent for the real quote
  readonly quoteRequest: JsonObject;
}

/** What a real quote answered. */
export interface TopupQuote {
  // The whole answer, with its signature
  readonly quoteResponse: JsonObject;
  readonly correlationId: string;
  readonly depositAddress: string;
  readonly depositMemo: string | undefined;
  readonly addressExpiresAt: Date;
  readonly sendAmount: bigint;
  readonly sendAtLeast: bigint;
  readonly estimatedCredits: MicroUsd;
  // When the status job first asks 1Click about it
  readonly nextPollAt: Date;
}

/** Why a quote made no usable address. */
export interface TopupQuoteFailure {
  // 1Click's message, or our reason for refusing its answer
  readonly error: string;
  // An answer we refused, kept as it came
  readonly quoteResponse?: JsonObject;
  readonly correlationId?: string;
}

/**
 * The `topups` rows. A status change applies only from the status it names: from any other, or for a
 * top-up that doesn't exist, it changes nothing and returns undefined, so of two writers one wins.
 */
export interface TopupRepository {
  /** Records a top-up as `quoting`, before its real quote is asked for. */
  create(topup: NewTopup): Promise<Topup>;
  /** `quoting` → `waiting`, with the quote's deposit address and amounts. */
  markQuoted(id: string, quote: TopupQuote): Promise<Topup | undefined>;
  /** `quoting` → `quote_failed`: 1Click refused the quote, or we refused its answer. */
  markQuoteFailed(id: string, failure: TopupQuoteFailure): Promise<Topup | undefined>;
  /**
   * `quoting` → `quote_unknown`: the quote didn't answer, or its answer was never recorded, so an
   * address may exist that nobody was given.
   */
  markQuoteUnknown(id: string, reason: string): Promise<Topup | undefined>;
  /**
   * Top-ups still `quoting` that were created before `before`, oldest first: ones whose quote's outcome
   * was never recorded, such as when a write after the quote failed.
   */
  listStuckQuoting(input: { readonly before: Date; readonly limit: number }): Promise<readonly Topup[]>;
  /** The account's own top-up: another account's is undefined, as an unknown ID is. */
  findForAccount(id: string, accountId: string): Promise<Topup | undefined>;
  find(id: string): Promise<Topup | undefined>;
}

const optional = <TValue>(value: TValue | null): TValue | undefined => value ?? undefined;

const toTopup = (row: typeof topups.$inferSelect): Topup => ({
  id: row.id,
  accountId: row.accountId,
  requestId: optional(row.requestId),
  status: row.status,
  network: row.network,
  blockchain: row.blockchain,
  tokenSymbol: row.tokenSymbol,
  originAsset: row.originAsset,
  tokenDecimals: row.tokenDecimals,
  amount: row.amount,
  destinationAsset: row.destinationAsset,
  recipient: row.recipient,
  refundTo: row.refundTo,
  payBy: row.payBy,
  quoteRequest: row.quoteRequest,
  quoteResponse: optional(row.quoteResponse),
  correlationId: optional(row.correlationId),
  depositAddress: optional(row.depositAddress),
  depositMemo: optional(row.depositMemo),
  addressExpiresAt: optional(row.addressExpiresAt),
  sendAmount: optional(row.sendAmount),
  sendAtLeast: optional(row.sendAtLeast),
  estimatedCredits: optional(row.estimatedCredits),
  quoteError: optional(row.quoteError),
  oneClickStatus: optional(row.oneClickStatus),
  lastStatus: optional(row.lastStatus),
  depositedAmount: optional(row.depositedAmount),
  creditedAmount: optional(row.creditedAmount),
  ledgerTransactionId: optional(row.ledgerTransactionId),
  deliveryTxHash: optional(row.deliveryTxHash),
  refundedAmount: optional(row.refundedAmount),
  refundReason: optional(row.refundReason),
  refundTxHash: optional(row.refundTxHash),
  originTxHashes: row.originTxHashes,
  needsReview: row.needsReview,
  reviewReason: optional(row.reviewReason),
  nextPollAt: optional(row.nextPollAt),
  lastPolledAt: optional(row.lastPolledAt),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const createTopupRepository = ({ db, clock }: TopupRepositoryOptions): TopupRepository => {
  // Only from `from`, checked and written in one statement
  const change = async (id: string, from: TopupStatus, set: Partial<typeof topups.$inferInsert> & { readonly status: TopupStatus }): Promise<Topup | undefined> => {
    const [row] = await db.update(topups)
      .set({ ...set, updatedAt: clock.now() })
      .where(and(eq(topups.id, id), eq(topups.status, from)))
      .returning();

    return row ? toTopup(row) : undefined;
  };

  return {
    create: async topup => {
      const now = clock.now();
      const [row] = await db.insert(topups).values({
        ...topup,
        requestId: topup.requestId ?? null,
        status: 'quoting',
        originTxHashes: [],
        needsReview: false,
        createdAt: now,
        updatedAt: now,
      }).returning();

      return toTopup(row!);
    },
    markQuoted: (id, quote) => change(id, 'quoting', {
      status: 'waiting',
      quoteResponse: quote.quoteResponse,
      correlationId: quote.correlationId,
      depositAddress: quote.depositAddress,
      depositMemo: quote.depositMemo ?? null,
      addressExpiresAt: quote.addressExpiresAt,
      sendAmount: quote.sendAmount,
      sendAtLeast: quote.sendAtLeast,
      estimatedCredits: quote.estimatedCredits,
      nextPollAt: quote.nextPollAt,
    }),
    markQuoteFailed: (id, { error, quoteResponse, correlationId }) => change(id, 'quoting', {
      status: 'quote_failed',
      quoteError: error,
      ...quoteResponse === undefined ? {} : { quoteResponse },
      ...correlationId === undefined ? {} : { correlationId },
    }),
    markQuoteUnknown: (id, reason) => change(id, 'quoting', { status: 'quote_unknown', quoteError: reason }),
    listStuckQuoting: async ({ before, limit }) => {
      const rows = await db.select().from(topups)
        .where(and(eq(topups.status, 'quoting'), lt(topups.createdAt, before)))
        .orderBy(asc(topups.createdAt), asc(topups.id))
        .limit(limit);

      return rows.map(toTopup);
    },
    findForAccount: async (id, accountId) => {
      const [row] = await db.select().from(topups).where(and(eq(topups.id, id), eq(topups.accountId, accountId)));

      return row ? toTopup(row) : undefined;
    },
    find: async id => {
      const [row] = await db.select().from(topups).where(eq(topups.id, id));

      return row ? toTopup(row) : undefined;
    },
  };
};
