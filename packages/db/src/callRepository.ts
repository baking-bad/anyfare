import { and, asc, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';

import type { MicroUsd } from '@anyfare/common';
import type { PaymentStatus, RailName } from '@anyfare/core';

import { withTransaction, type DatabaseExecutor } from './postgres.js';
import { callDetails } from './schema/calls.js';
import { finalCallStatuses, finishedCallStatuses, freeCallStatuses, paidCallStatuses, statusIn } from './schema/callStatuses.js';
import { payments } from './schema/ledger.js';
import { targetPayments, type TargetPaymentStatus } from './schema/routing.js';

export interface CallRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
}

/** What the proxy keeps about a paid call when it starts. */
export interface NewCallDetails {
  readonly paymentId: string;
  readonly method: string;
  // The payer's address, for a payment on a chain only
  readonly payer: string | undefined;
  readonly arrivedAt: Date;
}

/** Our payment of the API for one call. */
export interface CallLeg {
  readonly protocol: 'x402' | 'mpp';
  readonly network: string;
  // The registry's asset name
  readonly asset: string;
  readonly amount: MicroUsd;
  readonly payTo: string;
  readonly status: TargetPaymentStatus;
  readonly transactionHash: string | undefined;
  // When we signed it
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A finished call, as public reads may show it. It holds no buyer account, key, request ID, receipt or
 * settle request: those columns are never read.
 */
export interface CallRecord {
  readonly id: string;
  readonly rail: RailName;
  readonly status: PaymentStatus;
  readonly targetHost: string;
  // The path only: a routed call's query string is never kept
  readonly targetPath: string;
  readonly network: string | undefined;
  readonly asset: string | undefined;
  readonly amount: MicroUsd;
  readonly fee: MicroUsd | undefined;
  readonly upstreamStatus: number | undefined;
  readonly upstreamLatencyMs: number | undefined;
  // The buyer's transaction, for a payment on a chain
  readonly transactionHash: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  // Undefined for a call recorded before details were kept, or whose details couldn't be written
  readonly details: { readonly method: string; readonly payer: string | undefined; readonly arrivedAt: Date } | undefined;
  // Undefined when we never signed for the API
  readonly leg: CallLeg | undefined;
}

/** Each filter of the public list. */
export interface CallFilter {
  // How the buyer paid: Credits, or a rail on one network
  readonly paidWith?: { readonly rail: 'credits' } | { readonly rail: 'x402' | 'mpp'; readonly network: string };
  // The exact host, as routing keeps it: lowercase, with its port when it has one
  readonly host?: string;
  // A part of the host, without case
  readonly hostContains?: string;
  // The exact path
  readonly path?: string;
  readonly outcome?: 'paid' | 'free';
}

export interface CallPage {
  // Newest first
  readonly calls: readonly CallRecord[];
  // The matching calls, up to the cap
  readonly total: number;
  // There may be more than `total`: more matches than the cap, or a filter applied to the newest calls only
  readonly totalCapped: boolean;
}

/** The public reads of finished calls, and the details the proxy keeps about them. */
export interface CallRepository {
  /** Keeps the details of a call once. A second write for the same payment does nothing. */
  recordDetails(details: NewCallDetails): Promise<void>;
  /**
   * Finished calls, newest first. One index path serves the exact path, else the exact host, else how
   * the buyer paid, else every finished call. The other filters apply to the newest `cap + 1` calls on
   * that path, so no read goes deeper than that; the total is counted on the same rows. With a path
   * and a host, the path's index reads: a path is the narrower of the two.
   */
  list(input: { readonly filter: CallFilter; readonly offset: number; readonly limit: number; readonly cap: number }): Promise<CallPage>;
  /** A finished call, or undefined for an unknown payment or one still in flight. */
  find(paymentId: string): Promise<CallRecord | undefined>;
  /**
   * Calls whose payments became final after `after`, a payment's last update and ID, in that order.
   * `settling` is not final: such a call comes once it settles or fails.
   */
  finalizedAfter(input: { readonly after: { readonly updatedAt: Date; readonly id: string }; readonly limit: number }): Promise<readonly CallRecord[]>;
}

// A details write gives up after this, waiting on a lock included, so it never holds a connection long:
// nobody waits for it
export const callDetailsTimeoutMs = 2_000;

// How the buyer paid, as the paid-with index keeps it: the rail, and a chain payment's network after a space
const paidWithKey = sql`(${payments.rail} || coalesce(' ' || ${payments.network}, ''))`;
const optional = <TValue>(value: TValue | null): TValue | undefined => value ?? undefined;
// LIKE's own characters match themselves
const containing = (text: string): string => `%${text.replace(/[%_\\]/g, '\\$&')}%`;

const columns = {
  id: payments.id,
  rail: payments.rail,
  status: payments.status,
  targetHost: payments.targetHost,
  targetPath: payments.targetPath,
  network: payments.network,
  asset: payments.asset,
  amount: payments.amount,
  fee: payments.fee,
  upstreamStatus: payments.upstreamStatus,
  upstreamLatencyMs: payments.upstreamLatencyMs,
  transactionHash: payments.transactionHash,
  createdAt: payments.createdAt,
  updatedAt: payments.updatedAt,
  method: callDetails.method,
  payer: callDetails.payer,
  arrivedAt: callDetails.arrivedAt,
  legProtocol: targetPayments.protocol,
  legNetwork: targetPayments.network,
  legAsset: targetPayments.asset,
  legAmount: targetPayments.amount,
  legPayTo: targetPayments.payTo,
  legStatus: targetPayments.status,
  legTransactionHash: targetPayments.transactionHash,
  legCreatedAt: targetPayments.createdAt,
  legUpdatedAt: targetPayments.updatedAt,
};

// A payment with its API leg and its details, when it has them
const selectCalls = (db: DatabaseExecutor) => db.select(columns).from(payments)
  .leftJoin(targetPayments, eq(targetPayments.paymentId, payments.id))
  .leftJoin(callDetails, eq(callDetails.paymentId, payments.id));

type CallRow = Awaited<ReturnType<typeof selectCalls>>[number];

const toCall = (row: CallRow): CallRecord => ({
  id: row.id,
  rail: row.rail,
  status: row.status,
  targetHost: row.targetHost,
  targetPath: row.targetPath,
  network: optional(row.network),
  asset: optional(row.asset),
  amount: row.amount,
  fee: optional(row.fee),
  upstreamStatus: optional(row.upstreamStatus),
  upstreamLatencyMs: optional(row.upstreamLatencyMs),
  transactionHash: optional(row.transactionHash),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  details: row.method === null || row.arrivedAt === null
    ? undefined
    // Credits never show a payer, whatever the row holds
    : { method: row.method, payer: row.rail === 'credits' ? undefined : optional(row.payer), arrivedAt: row.arrivedAt },
  leg: row.legProtocol === null || row.legNetwork === null || row.legAsset === null || row.legAmount === null || row.legPayTo === null
    || row.legStatus === null || row.legCreatedAt === null || row.legUpdatedAt === null
    ? undefined
    : {
      protocol: row.legProtocol,
      network: row.legNetwork,
      asset: row.legAsset,
      amount: row.legAmount,
      payTo: row.legPayTo,
      status: row.legStatus,
      transactionHash: optional(row.legTransactionHash),
      createdAt: row.legCreatedAt,
      updatedAt: row.legUpdatedAt,
    },
});

export const createCallRepository = ({ db }: CallRepositoryOptions): CallRepository => {
  const joined = () => selectCalls(db);

  return {
    recordDetails: ({ paymentId, method, payer, arrivedAt }) => withTransaction(db, async tx => {
      // For this transaction only, so the connection goes back to the pool without it
      await tx.execute(sql.raw(`set local statement_timeout = ${callDetailsTimeoutMs}`));
      await tx.insert(callDetails).values({ paymentId, method, payer: payer ?? null, arrivedAt }).onConflictDoNothing();
    }),

    list: async ({ filter, offset, limit, cap }) => {
      const { paidWith, host, hostContains, path, outcome } = filter;
      // The index path: the exact path, else the exact host, else how the buyer paid, else every finished call
      const byPath = path !== undefined;
      const byHost = !byPath && host !== undefined;
      const byPaidWith = !byPath && !byHost && paidWith !== undefined;
      const paidWithValue = paidWith === undefined ? undefined : paidWith.rail === 'credits' ? 'credits' : `${paidWith.rail} ${paidWith.network}`;
      const indexed: SQL[] = [
        statusIn(payments.status, finishedCallStatuses),
        // The indexes hold the md5 of the host and the path; the text itself rules out a collision
        ...byPath ? [sql`md5(${payments.targetPath}) = md5(${path})`, eq(payments.targetPath, path)] : [],
        ...byHost ? [sql`md5(${payments.targetHost}) = md5(${host})`, eq(payments.targetHost, host)] : [],
        ...byPaidWith ? [sql`${paidWithKey} = ${paidWithValue}`] : [],
      ];
      const newest = desc(payments.createdAt);
      // The newest calls on that path: no read goes deeper
      const window = db.select({
        id: payments.id, createdAt: payments.createdAt, status: payments.status, targetHost: payments.targetHost,
        paidWith: sql<string>`${paidWithKey}`.as('paid_with'),
      }).from(payments).where(and(...indexed)).orderBy(newest, desc(payments.id)).limit(cap + 1).as('w');
      const rest: SQL[] = [
        ...paidWith === undefined || byPaidWith ? [] : [sql`${window.paidWith} = ${paidWithValue}`],
        ...host === undefined || byHost ? [] : [eq(window.targetHost, host)],
        ...hostContains === undefined ? [] : [sql`${window.targetHost} ilike ${containing(hostContains)}`],
        ...outcome === undefined ? [] : [statusIn(window.status, outcome === 'paid' ? paidCallStatuses : freeCallStatuses)],
      ];
      const matching = rest.length > 0 ? and(...rest) : undefined;
      const [counted] = await db.select({
        matches: matching === undefined ? sql<number>`count(*)::int` : sql<number>`(count(*) filter (where ${matching}))::int`,
        read: sql<number>`count(*)::int`,
      }).from(window);
      const matches = counted?.matches ?? 0;
      const read = counted?.read ?? 0;
      // Never past the cap: the window's last row only tells whether there are more
      const pageSize = Math.min(limit, cap - offset);
      const ids = pageSize <= 0
        ? []
        : matching === undefined
          // Nothing more to match: the page alone, straight from the index
          ? await db.select({ id: payments.id }).from(payments).where(and(...indexed)).orderBy(newest, desc(payments.id)).offset(offset).limit(pageSize)
          : await db.select({ id: window.id }).from(window).where(matching).orderBy(desc(window.createdAt), desc(window.id)).offset(offset).limit(pageSize);
      const rows = ids.length === 0
        ? []
        : await joined().where(inArray(payments.id, ids.map(row => row.id))).orderBy(desc(payments.createdAt), desc(payments.id));

      return { calls: rows.map(toCall), total: Math.min(matches, cap), totalCapped: read > cap };
    },

    find: async paymentId => {
      const [row] = await joined().where(and(eq(payments.id, paymentId), statusIn(payments.status, finishedCallStatuses)));

      return row ? toCall(row) : undefined;
    },

    finalizedAfter: async ({ after, limit }) => {
      const rows = await joined()
        .where(and(
          statusIn(payments.status, finalCallStatuses),
          // The plain bound lets the planner see how few rows follow
          gte(payments.updatedAt, after.updatedAt),
          sql`(${payments.updatedAt}, ${payments.id}) > (${after.updatedAt}, ${after.id})`,
        ))
        .orderBy(asc(payments.updatedAt), asc(payments.id))
        .limit(limit);

      return rows.map(toCall);
    },
  };
};
