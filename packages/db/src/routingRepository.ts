import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';

import type { Clock } from '@anyfare/common';
import type { PaymentStatus } from '@anyfare/core';

import { withTransaction, type DatabaseExecutor } from './postgres.js';
import { payments } from './schema/ledger.js';
import { hostBlocklist, routedEndpoints, signatures, targetPayments, type TargetPaymentStatus } from './schema/routing.js';

// At most this many routed endpoints per host
export const maxRoutedEndpointsPerHost = 1_000;

// The advisory lock namespace of endpoint registrations, keyed by host within it. The two-key form
// keeps it apart from the single-key session locks in postgres.ts.
const routingLockNamespace = 7_301;

export type EndpointRegistration = 'created' | 'exists' | 'capped';

export interface RoutingRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
}

export interface NewTargetPayment {
  readonly paymentId: string;
  readonly protocol: 'x402' | 'mpp';
  readonly network: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly atomicAmount: bigint;
  readonly payTo: string;
  readonly signatureId: string;
}

export type TargetPaymentRecord = typeof targetPayments.$inferSelect;

/** A routed call whose target kept our payment while its buyer paid nothing. */
export interface UnbookedRoutingLoss {
  readonly paymentId: string;
  // What the target was paid, in micro-USD
  readonly amount: bigint;
  readonly asset: string;
  readonly targetHost: string;
  readonly buyerStatus: PaymentStatus;
}

/** The statuses a buyer's payment ends in without charging them. Only such a payment can leave a routing loss. */
export const unchargedPaymentStatuses = ['failed', 'released', 'cancelled'] as const satisfies readonly PaymentStatus[];

export type NewSignature = typeof signatures.$inferInsert;

/** The `routed_endpoints`, `host_blocklist` and `target_payments` tables, and the Signer's `signatures`. */
export interface RoutingRepository {
  isBlocked(host: string): Promise<boolean>;
  /** Blocks a host, or updates the reason of a host already blocked. */
  block(input: { readonly host: string; readonly reason: string }): Promise<void>;
  /** Returns whether the host was blocked. */
  unblock(host: string): Promise<boolean>;
  /**
   * Registers a routed endpoint once, up to `maxRoutedEndpointsPerHost` per host, even under
   * concurrent registrations. An endpoint already registered keeps its row, with `lastPrice` updated
   * when one is given.
   */
  registerEndpoint(input: { readonly host: string; readonly path: string; readonly lastPrice?: bigint }): Promise<EndpointRegistration>;
  /** The endpoint's own fee in basis points, if it has one. */
  endpointFee(host: string, path: string): Promise<number | undefined>;
  /** Sets an endpoint's own fee, or back to the default with null. Returns whether the endpoint exists. */
  setEndpointFee(input: { readonly host: string; readonly path: string; readonly feeBps: number | null }): Promise<boolean>;
  /** Records a target leg as `signed`. */
  recordTargetPayment(payment: NewTargetPayment): Promise<void>;
  updateTargetPayment(paymentId: string, change: { readonly status: TargetPaymentStatus; readonly receipt?: string; readonly transactionHash?: string }): Promise<void>;
  findTargetPayment(paymentId: string): Promise<TargetPaymentRecord | undefined>;
  /**
   * Routing losses not booked yet, oldest first: the target leg settled, the buyer wasn't charged,
   * and the buyer's payment failed, was released, or was cancelled, such as an x402 or MPP
   * settlement that failed after the target was paid.
   */
  listUnbookedLosses(limit: number): Promise<readonly UnbookedRoutingLoss[]>;
  recordSignature(signature: NewSignature): Promise<void>;
}

const endpointIs = (host: string, path: string) => and(eq(routedEndpoints.host, host), eq(routedEndpoints.path, path));

export const createRoutingRepository = ({ db, clock }: RoutingRepositoryOptions): RoutingRepository => ({
  isBlocked: async host => (await db.select({ host: hostBlocklist.host }).from(hostBlocklist).where(eq(hostBlocklist.host, host))).length > 0,

  block: async ({ host, reason }) => {
    await db.insert(hostBlocklist).values({ host, reason, createdAt: clock.now() })
      .onConflictDoUpdate({ target: hostBlocklist.host, set: { reason } });
  },

  unblock: async host => (await db.delete(hostBlocklist).where(eq(hostBlocklist.host, host)).returning()).length > 0,

  registerEndpoint: ({ host, path, lastPrice }) => withTransaction(db, async (tx): Promise<EndpointRegistration> => {
    const [existing] = await tx.select({ host: routedEndpoints.host }).from(routedEndpoints).where(endpointIs(host, path));
    if (existing) {
      if (lastPrice !== undefined)
        await tx.update(routedEndpoints).set({ lastPrice }).where(endpointIs(host, path));

      return 'exists';
    }
    // One new endpoint per host at a time, until the commit, so concurrent registrations can't count past the cap
    await tx.execute(sql`select pg_advisory_xact_lock(${routingLockNamespace}, hashtext(${host}))`);
    const [registered] = await tx.select({ count: count() }).from(routedEndpoints).where(eq(routedEndpoints.host, host));
    if ((registered?.count ?? 0) >= maxRoutedEndpointsPerHost)
      return 'capped';
    const created = await tx.insert(routedEndpoints).values({ host, path, lastPrice: lastPrice ?? null, createdAt: clock.now() }).onConflictDoNothing().returning();

    return created.length > 0 ? 'created' : 'exists';
  }),

  endpointFee: async (host, path) => {
    const [row] = await db.select({ feeBps: routedEndpoints.feeBps }).from(routedEndpoints).where(endpointIs(host, path));

    return row?.feeBps ?? undefined;
  },

  setEndpointFee: async ({ host, path, feeBps }) => (await db.update(routedEndpoints).set({ feeBps }).where(endpointIs(host, path)).returning()).length > 0,

  recordTargetPayment: async payment => {
    const now = clock.now();
    await db.insert(targetPayments).values({ ...payment, status: 'signed', createdAt: now, updatedAt: now });
  },

  updateTargetPayment: async (paymentId, { status, receipt, transactionHash }) => {
    await db.update(targetPayments).set({
      status,
      updatedAt: clock.now(),
      ...(receipt === undefined ? {} : { receipt }),
      ...(transactionHash === undefined ? {} : { transactionHash }),
    }).where(eq(targetPayments.paymentId, paymentId));
  },

  findTargetPayment: async paymentId => {
    const [row] = await db.select().from(targetPayments).where(eq(targetPayments.paymentId, paymentId));

    return row;
  },

  listUnbookedLosses: async limit => db.select({
    paymentId: targetPayments.paymentId,
    amount: targetPayments.amount,
    asset: targetPayments.asset,
    targetHost: payments.targetHost,
    buyerStatus: payments.status,
  }).from(targetPayments)
    .innerJoin(payments, eq(payments.id, targetPayments.paymentId))
    .where(and(
      eq(targetPayments.status, 'settled'),
      eq(targetPayments.lossBooked, false),
      eq(targetPayments.buyerCharged, false),
      inArray(payments.status, [...unchargedPaymentStatuses]),
    ))
    .orderBy(asc(targetPayments.createdAt), asc(targetPayments.paymentId))
    .limit(limit),

  recordSignature: async signature => {
    await db.insert(signatures).values(signature);
  },
});
