import { and, asc, desc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';

import type { Clock } from '@anyfare/common';
import {
  InvalidPaymentCursorError, InvalidPaymentStatusChangeError, PaymentFinalizedError, paymentStatuses, statusesBefore, type BillingDecision, type InitialPaymentStatus,
  type JsonObject, type NewPayment, type Payment, type PaymentPage, type PaymentStatus,
} from '@anyfare/core';

import { withTransaction, type DatabaseExecutor } from './postgres.js';
import { finishedCallStatuses, freeCallStatuses, paidCallStatuses, statusIn } from './schema/callStatuses.js';
import { payments } from './schema/ledger.js';

/**
 * Where a payment stands for its buyer: `paid` (charged), `free` (not charged) or `pending` (in flight). Paid and
 * free are the public calls' own lists, so a call is never paid in one place and free in another.
 */
export const paymentStates = ['paid', 'free', 'pending'] as const;
export type PaymentState = typeof paymentStates[number];

const statusesOfState: Readonly<Record<PaymentState, readonly PaymentStatus[]>> = {
  paid: paidCallStatuses,
  free: freeCallStatuses,
  // Every status of a call not finished yet
  pending: paymentStatuses.filter(status => !(finishedCallStatuses as readonly PaymentStatus[]).includes(status)),
};

/** The state a payment's status is in. */
export const paymentStateOf = (status: PaymentStatus): PaymentState => paymentStates.find(state => statusesOfState[state].includes(status))!;

/** What narrows a buyer's list of payments. Every filter given must match. */
export interface PaymentFilter {
  readonly state?: PaymentState;
  // A payment key's ID: another account's key matches none of the buyer's payments
  readonly keyId?: string;
  // The exact host, as routing keeps it: lowercase, with its port when it has one
  readonly targetHost?: string;
}

export interface PaymentRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
}

export interface StatusChange {
  readonly paymentId: string;
  readonly to: PaymentStatus;
  // Only from this status: of two writers that read the same status, one wins
  readonly from?: PaymentStatus;
  readonly fee?: bigint;
  readonly transactionHash?: string;
  readonly receipt?: string;
  readonly needsReview?: boolean;
  // The settle request to repeat while `settling`. Null clears it, as a final status should.
  readonly settlementRequest?: JsonObject | null;
}

/** A payment still `settling`, with the settle request that a follow-up repeats as it was. */
export interface SettlingPayment {
  readonly payment: Payment;
  readonly settlementRequest: JsonObject | undefined;
}

/** The `payments` rows: one per paid call, moving along the payment status graph. */
export interface PaymentRepository {
  create(payment: NewPayment & { readonly status: InitialPaymentStatus; readonly transactionHash?: string }): Promise<Payment>;
  recordDecision(input: {
    readonly paymentId: string;
    readonly decision: BillingDecision;
    readonly upstreamStatus: number | undefined;
    readonly upstreamLatencyMs: number | undefined;
  }): Promise<Payment>;
  /**
   * Throws InvalidPaymentStatusChangeError unless the status graph allows the change from the current
   * status, and with `from`, unless the current status is `from`. Only the ledger moves a payment to
   * `captured` or `released`, because it books the money in the same transaction as the change.
   */
  changeStatus(change: StatusChange): Promise<Payment>;
  find(paymentId: string): Promise<Payment | undefined>;
  /** Reads the payment and locks its row until the transaction ends. */
  lock(paymentId: string): Promise<Payment | undefined>;
  /**
   * A buyer's payments, newest first, those the filter matches. `after` is the `next` of the previous page, with
   * these filters or others: it only says where the page starts. Read by the buyer index, the filters checked on the
   * rows it walks. With `timeoutMs`, the read is one statement that gives up after it, in a transaction of its own.
   * Throws InvalidPaymentCursorError for an `after` no page gave.
   */
  listForBuyer(input: {
    readonly buyerAccountId: string;
    readonly limit: number;
    readonly after?: string;
    readonly filter?: PaymentFilter;
    readonly timeoutMs?: number;
  }): Promise<PaymentPage>;
  /**
   * Payments still `held` that were created before `createdBefore`, oldest first: the holds a crash
   * left behind. `after` is the last payment of the previous page.
   */
  listExpiredHolds(input: {
    readonly createdBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly id: string };
  }): Promise<readonly Payment[]>;
  /**
   * Payments still `settling`, oldest first, with their settle requests. `after` is the last of the
   * previous page. With `updatedBefore`, only those last updated before it, so a payment whose
   * finalize may still be running is left to it.
   */
  listSettling(input: {
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly id: string };
    readonly updatedBefore?: Date;
  }): Promise<readonly SettlingPayment[]>;
  /**
   * Claims a `settling` payment for one follow-up: moves its `updated_at` to now, only while it is
   * still `settling` and last updated at `seenUpdatedAt`, as listed. Of two follow-ups that listed the
   * same row, one claims it; the other gets false. The new time keeps it off the lists that filter
   * by `updatedBefore` until it ages again.
   */
  claimSettling(input: { readonly paymentId: string; readonly seenUpdatedAt: Date }): Promise<boolean>;
}

const optional = <TValue>(value: TValue | null): TValue | undefined => value ?? undefined;

const toPayment = (row: typeof payments.$inferSelect): Payment => ({
  id: row.id,
  requestId: optional(row.requestId),
  rail: row.rail,
  buyerAccountId: optional(row.buyerAccountId),
  keyId: optional(row.keyId),
  targetHost: row.targetHost,
  targetPath: row.targetPath,
  network: optional(row.network),
  asset: optional(row.asset),
  atomicAmount: optional(row.atomicAmount),
  amount: row.amount,
  status: row.status,
  fee: optional(row.fee),
  decision: optional(row.decision),
  upstreamStatus: optional(row.upstreamStatus),
  upstreamLatencyMs: optional(row.upstreamLatencyMs),
  transactionHash: optional(row.transactionHash),
  receipt: optional(row.receipt),
  needsReview: row.needsReview,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Where a page of rows newest first stops: the last row's creation time and ID. */
export interface PageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** The page cursor, opaque: the last row's time and ID, so rows made in the same millisecond keep their order. */
export const encodePageCursor = ({ createdAt, id }: PageCursor): string => Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
// Rows are from this year on, so an earlier time is no cursor of ours
const earliestCursorTime = Date.UTC(2000, 0, 1);
// Postgres takes no year past 9999
const latestCursorTime = Date.UTC(9999, 11, 31);
// Our IDs: printable ASCII without a space. Anything else, a NUL above all, which Postgres can't take, is no cursor of ours.
const cursorIdPattern = /^[\x21-\x7e]{1,128}$/;
/** Throws InvalidPaymentCursorError unless the cursor is one `encodePageCursor` made. */
export const decodePageCursor = (cursor: string): PageCursor => {
  const [time = '', id = '', ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(time);
  if (rest.length > 0 || !cursorIdPattern.test(id) || !Number.isFinite(createdAt.getTime()) || createdAt.getTime() < earliestCursorTime || createdAt.getTime() > latestCursorTime)
    throw new InvalidPaymentCursorError();

  return { createdAt, id };
};

// A statement timeout for the rest of the transaction it runs in, so the connection goes back to the pool without it
const statementTimeout = (timeoutMs: number) => sql.raw(`set local statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);

export const createPaymentRepository = ({ db, clock }: PaymentRepositoryOptions): PaymentRepository => {
  const find = async (paymentId: string): Promise<Payment | undefined> => {
    const [row] = await db.select().from(payments).where(eq(payments.id, paymentId));

    return row ? toPayment(row) : undefined;
  };

  return {
    create: async payment => {
      const now = clock.now();
      const [row] = await db.insert(payments).values({
        id: payment.id,
        requestId: payment.requestId ?? null,
        rail: payment.rail,
        buyerAccountId: payment.buyerAccountId ?? null,
        keyId: payment.keyId ?? null,
        targetHost: payment.targetHost,
        targetPath: payment.targetPath,
        network: payment.network ?? null,
        asset: payment.asset ?? null,
        atomicAmount: payment.atomicAmount ?? null,
        amount: payment.amount,
        status: payment.status,
        transactionHash: payment.transactionHash ?? null,
        needsReview: false,
        createdAt: now,
        updatedAt: now,
      }).returning();

      return toPayment(row!);
    },
    recordDecision: async ({ paymentId, decision, upstreamStatus, upstreamLatencyMs }) => {
      // Only while the payment can still be finalized: a decision never changes a finished payment
      const [row] = await db.update(payments)
        .set({ decision, upstreamStatus: upstreamStatus ?? null, upstreamLatencyMs: upstreamLatencyMs ?? null, updatedAt: clock.now() })
        .where(and(eq(payments.id, paymentId), inArray(payments.status, ['held', 'verified'])))
        .returning();
      if (!row)
        throw new PaymentFinalizedError(paymentId, (await find(paymentId))?.status);

      return toPayment(row);
    },
    changeStatus: async ({ paymentId, to, from, fee, transactionHash, receipt, needsReview, settlementRequest }) => {
      const [row] = await db.update(payments)
        .set({
          status: to,
          updatedAt: clock.now(),
          ...(fee === undefined ? {} : { fee }),
          ...(transactionHash === undefined ? {} : { transactionHash }),
          ...(receipt === undefined ? {} : { receipt }),
          ...(needsReview === undefined ? {} : { needsReview }),
          ...(settlementRequest === undefined ? {} : { settlementRequest }),
        })
        // Only from a status the change is allowed from, and from `from` when given, checked and
        // written in one statement
        .where(and(
          eq(payments.id, paymentId),
          inArray(payments.status, [...statusesBefore(to)]),
          from === undefined ? undefined : eq(payments.status, from),
        ))
        .returning();
      if (!row)
        throw new InvalidPaymentStatusChangeError(paymentId, (await find(paymentId))?.status, to);

      return toPayment(row);
    },
    find,
    lock: async paymentId => {
      const [row] = await db.select().from(payments).where(eq(payments.id, paymentId)).for('update');

      return row ? toPayment(row) : undefined;
    },
    listForBuyer: async ({ buyerAccountId, limit, after, filter = {}, timeoutMs }) => {
      const cursor = after === undefined ? undefined : decodePageCursor(after);
      const { state, keyId, targetHost } = filter;
      const read = (executor: DatabaseExecutor) => executor.select().from(payments)
        .where(and(
          eq(payments.buyerAccountId, buyerAccountId),
          // The plain bound and the pair are both bounds of the buyer index, so a later page starts where the last one stopped
          cursor && lte(payments.createdAt, cursor.createdAt),
          cursor && sql`(${payments.createdAt}, ${payments.id}) < (${cursor.createdAt}, ${cursor.id})`,
          // The filters, checked on the rows the index gives
          state && statusIn(payments.status, statusesOfState[state]),
          keyId === undefined ? undefined : eq(payments.keyId, keyId),
          targetHost === undefined ? undefined : eq(payments.targetHost, targetHost),
        ))
        .orderBy(desc(payments.createdAt), desc(payments.id))
        .limit(limit + 1);
      const rows = timeoutMs === undefined
        ? await read(db)
        : await withTransaction(db, async tx => {
          await tx.execute(statementTimeout(timeoutMs));

          return read(tx);
        });
      const page = rows.slice(0, limit).map(toPayment);

      return { payments: page, next: rows.length > limit ? encodePageCursor(page.at(-1)!) : undefined };
    },
    listExpiredHolds: async ({ createdBefore, limit, after }) => {
      const rows = await db.select().from(payments)
        .where(and(
          eq(payments.status, 'held'),
          lt(payments.createdAt, createdBefore),
          after && or(gt(payments.createdAt, after.createdAt), and(eq(payments.createdAt, after.createdAt), gt(payments.id, after.id))),
        ))
        .orderBy(asc(payments.createdAt), asc(payments.id))
        .limit(limit);

      return rows.map(toPayment);
    },
    listSettling: async ({ limit, after, updatedBefore }) => {
      const rows = await db.select().from(payments)
        .where(and(
          eq(payments.status, 'settling'),
          updatedBefore && lt(payments.updatedAt, updatedBefore),
          after && or(gt(payments.createdAt, after.createdAt), and(eq(payments.createdAt, after.createdAt), gt(payments.id, after.id))),
        ))
        .orderBy(asc(payments.createdAt), asc(payments.id))
        .limit(limit);

      return rows.map(row => ({ payment: toPayment(row), settlementRequest: row.settlementRequest ?? undefined }));
    },
    claimSettling: async ({ paymentId, seenUpdatedAt }) => {
      const claimed = await db.update(payments)
        .set({ updatedAt: clock.now() })
        .where(and(eq(payments.id, paymentId), eq(payments.status, 'settling'), eq(payments.updatedAt, seenUpdatedAt)))
        .returning({ id: payments.id });

      return claimed.length > 0;
    },
  };
};
