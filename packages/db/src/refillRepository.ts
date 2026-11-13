import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import type { Clock, IdGenerator, MicroUsd } from '@anyfare/common';
import type { JsonObject } from '@anyfare/core';

import { createLedger } from './ledgerRepository.js';
import { withTransaction, type DatabaseExecutor } from './postgres.js';
import { inFlightRefillStatuses, refills, type RefillStatus } from './schema/refills.js';
import { createTreasuryRepository } from './treasuryRepository.js';

export interface RefillRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
  // The IDs of the ledger transaction and entries a booking makes
  readonly ids: IdGenerator;
}

/** A refill as the code reads it: amounts as bigint, times as Date, and what the row doesn't have yet undefined. */
export interface Refill {
  readonly id: string;
  // The target asset's registry name, and the NEAR asset that paid
  readonly asset: string;
  readonly sourceAsset: string;
  // What the target wallet was to receive
  readonly amount: MicroUsd;
  readonly status: RefillStatus;
  readonly reason: string | undefined;
  readonly depositAddress: string | undefined;
  // The quote's amounts, in the source's and the target's atomic units
  readonly amountIn: bigint | undefined;
  readonly amountOut: bigint | undefined;
  // What left NEAR and what arrived, once booked
  readonly amountInUsd: MicroUsd | undefined;
  readonly amountOutUsd: MicroUsd | undefined;
  readonly quoteDeadline: Date | undefined;
  readonly correlationId: string | undefined;
  readonly nearTransactionHash: string | undefined;
  readonly deliveryTransactionHashes: readonly string[];
  readonly quote: JsonObject | undefined;
  readonly lastStatus: JsonObject | undefined;
  // In the source asset's atomic units
  readonly refundedAmount: bigint | undefined;
  readonly refundFee: bigint | undefined;
  readonly refundReason: string | undefined;
  readonly nextPollAt: Date | undefined;
  readonly polls: number;
  readonly ledgerTransactionId: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sentAt: Date | undefined;
  readonly finishedAt: Date | undefined;
}

/** A refill about to be asked of the Signer. */
export interface NewRefill {
  readonly id: string;
  readonly asset: string;
  readonly sourceAsset: string;
  readonly amount: MicroUsd;
}

/** What the Signer sent, or may have sent: the quote it paid and its NEAR transaction. */
export interface RefillTransfer {
  readonly depositAddress: string;
  // In the source's and the target's atomic units
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly quoteDeadline: Date;
  readonly correlationId: string;
  readonly nearTransactionHash: string;
  // When the workers first ask 1Click about it
  readonly nextPollAt: Date;
}

/** The Signer's answer to a `requested` refill, as the row keeps it. */
export type RefillAnswer =
  // Sent, with 1Click's quote as it came
  | { readonly status: 'sent'; readonly transfer: RefillTransfer; readonly quote: JsonObject }
  // The transaction may have landed
  | { readonly status: 'unknown'; readonly transfer: RefillTransfer }
  // The transaction failed: nothing moved
  | { readonly status: 'failed'; readonly reason: string; readonly nearTransactionHash: string | undefined }
  // Refused or busy: nothing moved
  | { readonly status: 'not_sent'; readonly reason: string };

/** How a refill the workers follow ends without a booking: refunded, or left to an operator. */
export type RefillFinish =
  | {
    readonly status: 'refunded';
    readonly lastStatus: JsonObject;
    // In the source asset's atomic units
    readonly refundedAmount: bigint | undefined;
    readonly refundFee: bigint | undefined;
    readonly refundReason: string | undefined;
  }
  | { readonly status: 'review'; readonly reason: string; readonly lastStatus?: JsonObject | undefined };

/** A refill 1Click completed, to book. */
export interface RefillBooking {
  readonly id: string;
  readonly from: RefillStatus;
  readonly lastStatus: JsonObject;
  // What left the NEAR hot wallet, less what 1Click refunded to it
  readonly amountInUsd: MicroUsd;
  // What arrived in the target wallet
  readonly amountOutUsd: MicroUsd;
  readonly deliveryTransactionHashes: readonly string[];
  // A part 1Click refunded to the NEAR hot wallet, in the source asset's atomic units
  readonly refundedAmount: bigint | undefined;
  readonly refundFee: bigint | undefined;
}

/** The ledger reference a refill is booked under, as a treasury transfer. */
export const refillReference = (id: string): string => `refill:${id}`;
// Who recorded a refill's treasury transfer
export const refillRecordedBy = 'rebalancing';

/**
 * The `refills` rows. A change applies only from the status it names: from any other, or for a refill
 * that doesn't exist, it changes nothing and returns undefined, so of two writers one wins.
 */
export interface RefillRepository {
  /**
   * Records a refill as `requested`, before the Signer is asked. `busy` when its asset has a refill in
   * flight: the database allows one per asset.
   */
  create(refill: NewRefill): Promise<Refill | 'busy'>;
  find(id: string): Promise<Refill | undefined>;
  /** The asset's newest refill, in any status. */
  findLatest(asset: string): Promise<Refill | undefined>;
  /** The asset's refill in flight: `requested`, `sent`, `unknown` or `review`. */
  findInFlight(asset: string): Promise<Refill | undefined>;
  /** Every refill in flight, oldest first. */
  listInFlight(): Promise<readonly Refill[]>;
  /** `requested` → the Signer's answer. A sent or unknown refill is polled from `nextPollAt`; the others are final. */
  recordAnswer(id: string, answer: RefillAnswer): Promise<Refill | undefined>;
  /** `sent` and `unknown` refills whose next poll is at or before `now`, soonest first. */
  listDue(input: { readonly now: Date; readonly limit: number }): Promise<readonly Refill[]>;
  /**
   * Claims a listed refill for one poll: moves its next poll to `nextPollAt` and counts the poll, only
   * while the row is as it was listed, unchanged since `seenUpdatedAt` and still polled. Of two runners
   * that listed it, one gets it back; the other gets undefined and leaves it alone.
   */
  claimPoll(input: { readonly id: string; readonly seenUpdatedAt: Date; readonly nextPollAt: Date }): Promise<Refill | undefined>;
  /** Keeps 1Click's answer, still polled at `nextPollAt`. */
  recordPoll(id: string, from: RefillStatus, poll: { readonly lastStatus: JsonObject; readonly nextPollAt: Date }): Promise<Refill | undefined>;
  /** `from` → `refunded` or `review`. Polling stops. */
  finish(id: string, from: RefillStatus, outcome: RefillFinish): Promise<Refill | undefined>;
  /**
   * `from` → `succeeded`, in one transaction with the ledger's treasury transfer from the source
   * asset to the target asset under `refill:<id>`, and its record with the NEAR transaction and the
   * delivery's. The row is locked and checked first: from any other status nothing is booked, and the
   * result is undefined, so a replay books nothing twice. Throws the ledger's errors, such as a
   * RangeError for a transfer that would gain USD. Polling stops.
   */
  book(booking: RefillBooking): Promise<Refill | undefined>;
}

// A change was refused inside a transaction: it rolls back, and the caller gets undefined
class Unchanged extends Error {}

const optional = <TValue>(value: TValue | null): TValue | undefined => value ?? undefined;

const toRefill = (row: typeof refills.$inferSelect): Refill => ({
  id: row.id,
  asset: row.asset,
  sourceAsset: row.sourceAsset,
  amount: row.amount,
  status: row.status,
  reason: optional(row.reason),
  depositAddress: optional(row.depositAddress),
  amountIn: optional(row.amountIn),
  amountOut: optional(row.amountOut),
  amountInUsd: optional(row.amountInUsd),
  amountOutUsd: optional(row.amountOutUsd),
  quoteDeadline: optional(row.quoteDeadline),
  correlationId: optional(row.correlationId),
  nearTransactionHash: optional(row.nearTransactionHash),
  deliveryTransactionHashes: row.deliveryTransactionHashes,
  quote: optional(row.quote),
  lastStatus: optional(row.lastStatus),
  refundedAmount: optional(row.refundedAmount),
  refundFee: optional(row.refundFee),
  refundReason: optional(row.refundReason),
  nextPollAt: optional(row.nextPollAt),
  polls: row.polls,
  ledgerTransactionId: optional(row.ledgerTransactionId),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  sentAt: optional(row.sentAt),
  finishedAt: optional(row.finishedAt),
});

// The row's fields a transfer writes
const transferFields = (transfer: RefillTransfer): Partial<typeof refills.$inferInsert> => ({
  depositAddress: transfer.depositAddress,
  amountIn: transfer.amountIn,
  amountOut: transfer.amountOut,
  quoteDeadline: transfer.quoteDeadline,
  correlationId: transfer.correlationId,
  nearTransactionHash: transfer.nearTransactionHash,
  nextPollAt: transfer.nextPollAt,
});

const polledStatuses: readonly RefillStatus[] = ['sent', 'unknown'];

export const createRefillRepository = ({ db, clock, ids }: RefillRepositoryOptions): RefillRepository => {
  // Only from `from`, checked and written in one statement
  const changeOn = async (
    executor: DatabaseExecutor,
    id: string,
    from: RefillStatus,
    set: Partial<typeof refills.$inferInsert> & { readonly status: RefillStatus },
  ): Promise<Refill | undefined> => {
    const [row] = await executor.update(refills)
      .set({ ...set, updatedAt: clock.now() })
      .where(and(eq(refills.id, id), eq(refills.status, from)))
      .returning();

    return row ? toRefill(row) : undefined;
  };
  const change = (id: string, from: RefillStatus, set: Partial<typeof refills.$inferInsert> & { readonly status: RefillStatus }) => changeOn(db, id, from, set);

  return {
    create: async refill => {
      const now = clock.now();
      // Any conflict is the in-flight index's: the ID is new
      const [row] = await db.insert(refills).values({
        ...refill,
        status: 'requested',
        deliveryTransactionHashes: [],
        polls: 0,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning();

      return row ? toRefill(row) : 'busy';
    },
    find: async id => {
      const [row] = await db.select().from(refills).where(eq(refills.id, id));

      return row ? toRefill(row) : undefined;
    },
    findLatest: async asset => {
      const [row] = await db.select().from(refills).where(eq(refills.asset, asset)).orderBy(desc(refills.createdAt), desc(refills.id)).limit(1);

      return row ? toRefill(row) : undefined;
    },
    findInFlight: async asset => {
      const [row] = await db.select().from(refills).where(and(eq(refills.asset, asset), inArray(refills.status, [...inFlightRefillStatuses])));

      return row ? toRefill(row) : undefined;
    },
    listInFlight: async () => {
      const rows = await db.select().from(refills)
        .where(inArray(refills.status, [...inFlightRefillStatuses]))
        .orderBy(asc(refills.createdAt), asc(refills.id));

      return rows.map(toRefill);
    },
    recordAnswer: (id, answer) => {
      const now = clock.now();
      switch (answer.status) {
        case 'sent':
          return change(id, 'requested', { status: 'sent', ...transferFields(answer.transfer), quote: answer.quote, sentAt: now });
        case 'unknown':
          return change(id, 'requested', { status: 'unknown', ...transferFields(answer.transfer), sentAt: now });
        case 'failed':
          return change(id, 'requested', { status: 'failed', reason: answer.reason, nearTransactionHash: answer.nearTransactionHash ?? null, finishedAt: now });
        case 'not_sent':
          return change(id, 'requested', { status: 'not_sent', reason: answer.reason, finishedAt: now });
      }
    },
    listDue: async ({ now, limit }) => {
      const rows = await db.select().from(refills)
        .where(and(inArray(refills.status, [...polledStatuses]), isNotNull(refills.nextPollAt), lte(refills.nextPollAt, now)))
        .orderBy(asc(refills.nextPollAt), asc(refills.id))
        .limit(limit);

      return rows.map(toRefill);
    },
    claimPoll: async ({ id, seenUpdatedAt, nextPollAt }) => {
      const [row] = await db.update(refills)
        .set({ nextPollAt, polls: sql`${refills.polls} + 1`, updatedAt: clock.now() })
        .where(and(eq(refills.id, id), eq(refills.updatedAt, seenUpdatedAt), inArray(refills.status, [...polledStatuses]), isNotNull(refills.nextPollAt)))
        .returning();

      return row ? toRefill(row) : undefined;
    },
    recordPoll: (id, from, { lastStatus, nextPollAt }) => change(id, from, { status: from, lastStatus, nextPollAt }),
    finish: (id, from, outcome) => outcome.status === 'refunded'
      ? change(id, from, {
        status: 'refunded',
        lastStatus: outcome.lastStatus,
        refundedAmount: outcome.refundedAmount ?? null,
        refundFee: outcome.refundFee ?? null,
        refundReason: outcome.refundReason ?? null,
        nextPollAt: null,
        finishedAt: clock.now(),
      })
      : change(id, from, {
        status: 'review', reason: outcome.reason, ...outcome.lastStatus === undefined ? {} : { lastStatus: outcome.lastStatus }, nextPollAt: null,
      }),
    book: async ({ id, from, lastStatus, amountInUsd, amountOutUsd, deliveryTransactionHashes, refundedAmount, refundFee }) => {
      try {
        return await withTransaction(db, async tx => {
          // Locked first, so a second runner waits here, then finds it booked and books nothing
          const [row] = await tx.select().from(refills).where(and(eq(refills.id, id), eq(refills.status, from))).for('update');
          if (!row)
            throw new Unchanged();
          const reference = refillReference(id);
          const booked = await createLedger({ db: tx, clock, ids }).treasuryTransfer({
            reference, from: { asset: row.sourceAsset, amount: amountInUsd }, to: { asset: row.asset, amount: amountOutUsd },
          });
          // A transfer the ledger booked before, under this reference, was recorded with it
          if (!booked.replayed) {
            await createTreasuryRepository({ db: tx }).recordTransfer({
              reference,
              fromAsset: row.sourceAsset,
              fromAmount: amountInUsd,
              toAsset: row.asset,
              toAmount: amountOutUsd,
              transactions: [...row.nearTransactionHash === null ? [] : [row.nearTransactionHash], ...deliveryTransactionHashes],
              recordedBy: refillRecordedBy,
              ledgerTransactionId: booked.transactionId,
              createdAt: booked.createdAt,
            });
          }
          const succeeded = await changeOn(tx, id, from, {
            status: 'succeeded',
            lastStatus,
            amountInUsd,
            amountOutUsd,
            deliveryTransactionHashes: [...deliveryTransactionHashes],
            refundedAmount: refundedAmount ?? null,
            refundFee: refundFee ?? null,
            ledgerTransactionId: booked.transactionId,
            nextPollAt: null,
            finishedAt: clock.now(),
          });
          if (!succeeded)
            throw new Unchanged();

          return succeeded;
        });
      }
      catch (error) {
        if (error instanceof Unchanged)
          return undefined;
        throw error;
      }
    },
  };
};
