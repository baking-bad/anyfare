import { and, asc, eq, isNotNull, lt, lte } from 'drizzle-orm';

import type { Clock, MicroUsd } from '@anyfare/common';
import type { JsonObject, TopupStatus } from '@anyfare/core';

import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from './postgres.js';
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

/** What one poll of 1Click's status said, as the row keeps it. */
export interface TopupPoll {
  // 1Click's status, as it answered it
  readonly oneClickStatus: string;
  // The whole answer
  readonly lastStatus: JsonObject;
  readonly polledAt: Date;
  // In the token's atomic units. Undefined leaves the row's value.
  readonly depositedAmount?: bigint | undefined;
  // The deposit's transactions on the origin chain. Undefined or empty leaves the row's list.
  readonly originTxHashes?: readonly string[] | undefined;
}

/** The statuses a top-up is polled in, and the one it shows while it is. */
export type PolledTopupStatus = 'waiting' | 'incomplete' | 'processing' | 'expired';

/** A swap 1Click completed, as the row keeps it once its Credits are booked. */
export interface TopupCredit {
  readonly poll: TopupPoll;
  // In micro-USD
  readonly creditedAmount: MicroUsd;
  // The delivery's transaction on NEAR
  readonly deliveryTxHash: string | undefined;
  // What 1Click returned of the deposit, in the token's atomic units: undefined for nothing
  readonly refundedAmount: bigint | undefined;
}

/** A swap 1Click refunded. */
export interface TopupRefund {
  readonly poll: TopupPoll;
  // In the token's atomic units
  readonly refundedAmount: bigint | undefined;
  readonly refundReason: string | undefined;
  readonly refundTxHash: string | undefined;
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
  /** Top-ups whose next poll is at or before `now`, soonest first. A final state has none. */
  listDue(input: { readonly now: Date; readonly limit: number }): Promise<readonly Topup[]>;
  /**
   * Claims a listed top-up for one poll: moves its next poll to `nextPollAt`, only while the row is
   * as it was listed, unchanged since `seenUpdatedAt` and still polled. Of two runners that listed it,
   * one gets the top-up back; the other gets undefined and leaves it alone.
   */
  claimPoll(input: { readonly id: string; readonly seenUpdatedAt: Date; readonly nextPollAt: Date }): Promise<Topup | undefined>;
  /** `from` → `to`, still polled at `nextPollAt`, with what the poll said. */
  recordPoll(id: string, from: TopupStatus, change: { readonly to: PolledTopupStatus; readonly poll: TopupPoll; readonly nextPollAt: Date }): Promise<Topup | undefined>;
  /**
   * `from` → `credited`, in one transaction with `book`, which books the Credits on the transaction it
   * is given and returns the ledger transaction. The row is locked and checked first: from any other
   * status, or flagged for review, nothing is booked, and the result is undefined. Polling stops.
   */
  markCredited(input: {
    readonly id: string;
    readonly from: TopupStatus;
    readonly credit: TopupCredit;
    readonly book: (tx: DatabaseTransaction) => Promise<{ readonly transactionId: string }>;
  }): Promise<Topup | undefined>;
  /** `from` → `refunded`. Polling stops. */
  markRefunded(id: string, from: TopupStatus, refund: TopupRefund): Promise<Topup | undefined>;
  /** `from` → `failed`, flagged for review with the reason. Polling stops. */
  markFailed(id: string, from: TopupStatus, failure: { readonly poll: TopupPoll; readonly reason: string }): Promise<Topup | undefined>;
  /** `from` → `expired` for good: the address takes no more transfers. Polling stops. */
  markExpired(id: string, from: TopupStatus, poll: TopupPoll): Promise<Topup | undefined>;
  /** Flags the top-up for review with the reason, in its status `from`, with what the poll said if there was one. Polling stops. */
  flagForReview(id: string, from: TopupStatus, review: { readonly reason: string; readonly poll?: TopupPoll | undefined }): Promise<Topup | undefined>;
}

// The row's fields a poll writes
const pollFields = (poll: TopupPoll): Partial<typeof topups.$inferInsert> => ({
  oneClickStatus: poll.oneClickStatus,
  lastStatus: poll.lastStatus,
  lastPolledAt: poll.polledAt,
  ...poll.depositedAmount === undefined ? {} : { depositedAmount: poll.depositedAmount },
  ...poll.originTxHashes === undefined || poll.originTxHashes.length === 0 ? {} : { originTxHashes: [...poll.originTxHashes] },
});

// A change was refused inside a transaction: it rolls back, and the caller gets undefined
class Unchanged extends Error {}

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
  const changeOn = async (
    executor: DatabaseExecutor,
    id: string,
    from: TopupStatus,
    set: Partial<typeof topups.$inferInsert> & { readonly status: TopupStatus },
  ): Promise<Topup | undefined> => {
    const [row] = await executor.update(topups)
      .set({ ...set, updatedAt: clock.now() })
      .where(and(eq(topups.id, id), eq(topups.status, from)))
      .returning();

    return row ? toTopup(row) : undefined;
  };
  const change = (id: string, from: TopupStatus, set: Partial<typeof topups.$inferInsert> & { readonly status: TopupStatus }) => changeOn(db, id, from, set);

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
    listDue: async ({ now, limit }) => {
      const rows = await db.select().from(topups)
        .where(and(isNotNull(topups.nextPollAt), lte(topups.nextPollAt, now)))
        .orderBy(asc(topups.nextPollAt), asc(topups.id))
        .limit(limit);

      return rows.map(toTopup);
    },
    claimPoll: async ({ id, seenUpdatedAt, nextPollAt }) => {
      const [row] = await db.update(topups)
        .set({ nextPollAt, updatedAt: clock.now() })
        .where(and(eq(topups.id, id), eq(topups.updatedAt, seenUpdatedAt), isNotNull(topups.nextPollAt)))
        .returning();

      return row ? toTopup(row) : undefined;
    },
    recordPoll: (id, from, { to, poll, nextPollAt }) => change(id, from, { status: to, ...pollFields(poll), nextPollAt }),
    markCredited: async ({ id, from, credit, book }) => {
      try {
        return await withTransaction(db, async tx => {
          // Locked first, so a second runner waits here, then finds it credited, or flagged, and books nothing
          const [locked] = await tx.select({ id: topups.id }).from(topups)
            .where(and(eq(topups.id, id), eq(topups.status, from), eq(topups.needsReview, false)))
            .for('update');
          if (!locked)
            throw new Unchanged();
          const { transactionId } = await book(tx);
          const credited = await changeOn(tx, id, from, {
            status: 'credited',
            ...pollFields(credit.poll),
            creditedAmount: credit.creditedAmount,
            ledgerTransactionId: transactionId,
            deliveryTxHash: credit.deliveryTxHash ?? null,
            ...credit.refundedAmount === undefined ? {} : { refundedAmount: credit.refundedAmount },
            nextPollAt: null,
          });
          if (!credited)
            throw new Unchanged();

          return credited;
        });
      }
      catch (error) {
        if (error instanceof Unchanged)
          return undefined;
        throw error;
      }
    },
    markRefunded: (id, from, { poll, refundedAmount, refundReason, refundTxHash }) => change(id, from, {
      status: 'refunded',
      ...pollFields(poll),
      ...refundedAmount === undefined ? {} : { refundedAmount },
      refundReason: refundReason ?? null,
      refundTxHash: refundTxHash ?? null,
      nextPollAt: null,
    }),
    markFailed: (id, from, { poll, reason }) => change(id, from, {
      status: 'failed', ...pollFields(poll), needsReview: true, reviewReason: reason, nextPollAt: null,
    }),
    markExpired: (id, from, poll) => change(id, from, { status: 'expired', ...pollFields(poll), nextPollAt: null }),
    flagForReview: (id, from, { reason, poll }) => change(id, from, {
      status: from, ...poll === undefined ? {} : pollFields(poll), needsReview: true, reviewReason: reason, nextPollAt: null,
    }),
  };
};
