import { and, asc, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import type { Clock } from '@anyfare/common';
import { hostSuffixes, parentDomainOf, type PaymentStatus } from '@anyfare/core';

import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from './postgres.js';
import { payments } from './schema/ledger.js';
import {
  checkedHosts, hostBlocklist, routedEndpoints, signatures, targetPayments, type CheckedMethod, type RoutedEndpointStatus, type TargetPaymentStatus,
} from './schema/routing.js';
import { statsServices } from './schema/stats.js';

// At most this many endpoints reached by a paid call per host
export const maxRoutedEndpointsPerHost = 1_000;
// At most this many endpoints listed only by a check per host, beside those: a check never takes a paid one's place
export const maxCheckedEndpointsPerHost = 20;
// At most this many endpoints listed only by a check in all: the pool's 1,000 hosts with 20 each, and room for the
// stored services' own. A new one pushes out the one checked longest ago.
export const maxCheckedEndpoints = 25_000;
// At most this many hosts in the checked pool, the hosts listed because a check listed them: those the count
// doesn't store. A new one pushes out the one checked longest ago.
export const maxCheckedHosts = 1_000;
// At most this many of them per parent domain, its last two labels: the newest are kept
export const maxCheckedHostsPerParent = 20;
// The longest path a check lists: the longest the public reads list, of printable ASCII
export const maxCheckedPathLength = 512;
// Each statement of a check's registration gives up after this, waiting for a lock included
export const checkedRegistrationTimeoutMs = 2_000;

// The advisory lock namespace of endpoint registrations, keyed by host within it. The two-key form
// keeps it apart from the single-key session locks in postgres.ts. Key 0 of the checked hosts' namespace
// guards the caps over every host: the pool's, each parent domain's, and every checked endpoint's.
const routingLockNamespace = 7_301;
const checkedHostsLockNamespace = 7_302;
// The candidates an eviction tries beyond those it needs, each without waiting for its lock
const evictionCandidates = 5;
// The most one registration pushes out of a cap. A pool the count left over its cap, by dropping stored hosts
// that checks had reached, so shrinks by nine or more with each host that joins, never in one long transaction.
export const maxEvictionsPerRegistration = 10;

/**
 * `limited`: the host joins the checked pool, and the check that sent it wasn't counted as a new host for its
 * client. `capped`: the host holds its cap of endpoints of this kind, or nothing could make room. `blocked`:
 * the blocklist names the host or a parent domain of it.
 */
export type EndpointRegistration = 'created' | 'exists' | 'capped' | 'limited' | 'blocked';

/** A registration: by a billable call, unless `checked` names the check that found it payable. */
export interface EndpointInput {
  readonly host: string;
  readonly path: string;
  readonly lastPrice?: bigint;
  readonly checked?: {
    readonly method: CheckedMethod;
    // The check's client was counted for a new host: it may add one to the checked pool
    readonly mayAddHost: boolean;
  };
}

/** What the proxy knows of an endpoint before a check lists it. */
export interface EndpointListing {
  // Undefined: not listed
  readonly status: RoutedEndpointStatus | undefined;
  // The host has a listed endpoint
  readonly hostListed: boolean;
  // Its endpoints listed only by a check: at most 20
  readonly checkedEndpoints: number;
  // The count stores the host: it isn't in the checked pool
  readonly stored: boolean;
  // A check reached the host before: it has a checked host's row
  readonly checkedHost: boolean;
  // The blocklist names the host or a parent domain of it
  readonly blocked: boolean;
}

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
  /** Whether the blocklist names this exact host, as routing a call refuses it. Listing also covers parent domains. */
  isBlocked(host: string): Promise<boolean>;
  /** Blocks a host, or updates the reason of a host already blocked. */
  block(input: { readonly host: string; readonly reason: string }): Promise<void>;
  /** Returns whether the host was blocked. */
  unblock(host: string): Promise<boolean>;
  /**
   * Registers a routed endpoint once, even under concurrent registrations. An endpoint already registered
   * keeps its row, with `lastPrice` updated when one is given. A billable call's endpoint counts against
   * `maxRoutedEndpointsPerHost`, and a checked one becomes paid at it. A check's endpoint counts against
   * `maxCheckedEndpointsPerHost`, and its time and method are kept; it adds a host only when `mayAddHost`,
   * and a host listed only by checks past `maxCheckedHosts` pushes out the one checked longest ago.
   */
  registerEndpoint(input: EndpointInput): Promise<EndpointRegistration>;
  /** Whether an endpoint and its host are listed, in one statement giving up after `timeoutMs`. */
  endpointListing(host: string, path: string, options: { readonly timeoutMs: number }): Promise<EndpointListing>;
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
const ofHost = (host: string, status: RoutedEndpointStatus) => and(eq(routedEndpoints.host, host), eq(routedEndpoints.status, status));
const json = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;

// Whether a host has a listed endpoint: its first by the key's order, so only the key serves it. An unordered
// probe the planner may take as a scan it expects to stop early, which reads every row before a host's.
const hostListedSql = (host: string) => sql`(select ${routedEndpoints.path} from ${routedEndpoints} where ${routedEndpoints.host} = ${host}
  order by ${routedEndpoints.path} limit 1) is not null`;
const hostListed = async (tx: DatabaseExecutor, host: string): Promise<boolean> =>
  (await tx.execute<{ listed: boolean }>(sql`select ${hostListedSql(host)} as listed`)).rows[0]?.listed === true;

/**
 * Whether the blocklist names the host or a parent domain of it, each name by the blocklist's key. This is for
 * listing only: routing a call refuses the exact name alone, as `isBlocked` reads it, since that is the paid path.
 */
const blockedForListingSql = (host: string): SQL => sql`exists (select 1 from ${hostBlocklist}
  where ${hostBlocklist.host} in (select jsonb_array_elements_text(${json(hostSuffixes(host))})))`;
// The count stores the host, by its key: it isn't in the checked pool
const storedSql = (host: SQL): SQL => sql`exists (select 1 from ${statsServices} where ${statsServices.hostHash} = md5(${host}))`;
// An operator set a fee on one of the host's endpoints: it is never pushed out
const feeSetSql = (host: SQL): SQL => sql`exists (select 1 from ${routedEndpoints} where ${routedEndpoints.host} = ${host} and ${routedEndpoints.feeBps} is not null)`;

// One change of a host's endpoints at a time, until the commit, so concurrent registrations can't count past a cap
const lockHost = async (tx: DatabaseTransaction, host: string): Promise<void> => {
  await tx.execute(sql`select pg_advisory_xact_lock(${routingLockNamespace}, hashtext(${host}))`);
};
// Without waiting: held by another registration of that host, it is left alone
const tryLockHost = async (tx: DatabaseTransaction, host: string): Promise<boolean> =>
  (await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${routingLockNamespace}, hashtext(${host})) as locked`)).rows[0]?.locked === true;
// The caps over every host: taken after a host's own lock, and only to add to them
const lockCaps = async (tx: DatabaseTransaction): Promise<void> => {
  await tx.execute(sql`select pg_advisory_xact_lock(${checkedHostsLockNamespace}, 0)`);
};

/**
 * The host's row of checked hosts, under its lock: its endpoints listed only by a check, at most 20 by their
 * index, and the time of the check. A new row keeps when the host's first endpoint was listed, its parent
 * domain, and, for a host a paid call reached, that host's first paid endpoint's time. Without `checkedAt`, a
 * row that exists keeps its time, and none is made.
 */
const keepCheckedHost = async (tx: DatabaseTransaction, host: string, change: { readonly checkedAt?: Date; readonly paidAt?: Date }): Promise<void> => {
  const counted = sql`select count(*)::int as endpoints, min(${routedEndpoints.lastPrice}) as price_from from ${routedEndpoints}
    where ${routedEndpoints.host} = ${host} and ${routedEndpoints.status} = 'checked'`;
  if (change.checkedAt === undefined) {
    await tx.execute(sql`update ${checkedHosts} set checked_endpoints = counted.endpoints, price_from = counted.price_from,
      paid_at = coalesce(${checkedHosts.paidAt}, ${change.paidAt ?? null}::timestamptz)
      from (${counted}) as counted where ${checkedHosts.host} = ${host}`);
    return;
  }
  // Its first paid endpoint by routed_endpoints_listed_idx, its first checked one of at most 20
  const firstPaid = sql`(select min(${routedEndpoints.createdAt}) from ${routedEndpoints} where ${ofHost(host, 'paid')})`;
  // Fenced, so the at most 20 come by their index: as a bare minimum the planner may walk the catalog's index of every endpoint
  const firstChecked = sql`(select min(listed.created_at) from (select ${routedEndpoints.createdAt} as created_at from ${routedEndpoints}
    where ${ofHost(host, 'checked')} offset 0) as listed)`;
  await tx.execute(sql`insert into ${checkedHosts} (host, parent, listed_at, checked_at, paid_at, checked_endpoints, price_from)
    select ${host}, ${parentDomainOf(host)}, coalesce(least(${firstPaid}, ${firstChecked}), ${change.checkedAt}::timestamptz), ${change.checkedAt},
      coalesce(${change.paidAt ?? null}::timestamptz, ${firstPaid}), counted.endpoints, counted.price_from from (${counted}) as counted
    on conflict (host) do update set checked_at = excluded.checked_at, checked_endpoints = excluded.checked_endpoints, price_from = excluded.price_from,
      paid_at = coalesce(${checkedHosts.paidAt}, excluded.paid_at)`);
};

/**
 * Pushes a host out of the checked pool, once its lock is held: its row, only while it is still in the pool (the
 * count doesn't store it) and no endpoint of it has a fee, and only then its endpoints listed only by a check.
 * Returns whether it went. Exported for its test.
 */
export const evictCheckedHost = async (tx: DatabaseTransaction, host: string): Promise<boolean> => {
  const { rows } = await tx.execute(sql`delete from ${checkedHosts} where ${checkedHosts.host} = ${host}
    and not ${storedSql(sql`${host}::text`)} and not ${feeSetSql(sql`${host}::text`)} returning 1`);
  if (rows.length === 0)
    return false;
  await tx.delete(routedEndpoints).where(and(ofHost(host, 'checked'), isNull(routedEndpoints.feeBps)));

  return true;
};

/**
 * Pushes out of the checked pool the hosts checked longest ago, of one parent domain or of all, until it holds
 * fewer than `cap`, or `maxEvictionsPerRegistration` went: only hosts the count doesn't store, with no fee,
 * whose own lock is free. False: no room.
 */
const makeRoomIn = async (tx: DatabaseTransaction, cap: number, parent: string | undefined): Promise<boolean> => {
  const ofParent = parent === undefined ? sql`true` : sql`${checkedHosts.parent} = ${parent}`;
  const inPool = sql`${ofParent} and not ${storedSql(sql`${checkedHosts.host}`)}`;
  const { rows: [counted] } = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${checkedHosts} where ${inPool}`);
  let needed = Math.min((counted?.count ?? 0) - cap + 1, maxEvictionsPerRegistration);
  if (needed <= 0)
    return true;
  const { rows: oldest } = await tx.execute<{ host: string }>(sql`select ${checkedHosts.host} as host from ${checkedHosts}
    where ${inPool} and not ${feeSetSql(sql`${checkedHosts.host}`)}
    order by ${checkedHosts.checkedAt}, ${checkedHosts.host} limit ${needed + evictionCandidates}`);
  for (const { host } of oldest) {
    if (needed <= 0)
      break;
    if (await tryLockHost(tx, host) && await evictCheckedHost(tx, host))
      needed -= 1;
  }

  return needed <= 0;
};

/**
 * Room for one more endpoint listed only by a check, of 25,000 in all: the one checked longest ago leaves, never
 * one with a fee, nor of a host whose lock another registration holds. Its host keeps its row; one listed only by
 * checks and left with none leaves the pool. False: no room.
 */
const makeEndpointRoom = async (tx: DatabaseTransaction, own: string): Promise<boolean> => {
  const [listed] = await tx.select({ count: count() }).from(routedEndpoints).where(eq(routedEndpoints.status, 'checked'));
  let excess = Math.min((listed?.count ?? 0) - maxCheckedEndpoints + 1, maxEvictionsPerRegistration);
  if (excess <= 0)
    return true;
  const oldest = await tx.select({ host: routedEndpoints.host, path: routedEndpoints.path }).from(routedEndpoints)
    .where(and(eq(routedEndpoints.status, 'checked'), isNull(routedEndpoints.feeBps)))
    .orderBy(asc(routedEndpoints.checkedAt)).limit(excess + evictionCandidates);
  for (const { host, path } of oldest) {
    if (excess <= 0)
      break;
    if (host !== own && !await tryLockHost(tx, host))
      continue;
    const gone = await tx.delete(routedEndpoints).where(and(endpointIs(host, path), eq(routedEndpoints.status, 'checked'), isNull(routedEndpoints.feeBps)))
      .returning({ host: routedEndpoints.host });
    if (gone.length === 0)
      continue;
    excess -= 1;
    await keepCheckedHost(tx, host, {});
    await tx.delete(checkedHosts).where(and(eq(checkedHosts.host, host), eq(checkedHosts.checkedEndpoints, 0), isNull(checkedHosts.paidAt)));
  }

  return excess <= 0;
};

/**
 * A billable call's endpoint: a new one up to the cap of paid ones, and a checked one becomes paid. At the paid
 * cap a checked one can't, so it leaves the routed endpoints, as any paid one past the cap is never in them:
 * its calls still count it once, as paid.
 */
const registerPaid = async (tx: DatabaseTransaction, { host, path, lastPrice }: EndpointInput, now: Date): Promise<EndpointRegistration> => {
  const priced = lastPrice === undefined ? {} : { lastPrice };
  const [known] = await tx.select({ status: routedEndpoints.status }).from(routedEndpoints).where(endpointIs(host, path));
  if (known?.status === 'paid') {
    if (lastPrice !== undefined)
      await tx.update(routedEndpoints).set(priced).where(endpointIs(host, path));

    return 'exists';
  }
  await lockHost(tx, host);
  // Read again under the lock: a check may have listed it meanwhile
  const [existing] = await tx.select({ status: routedEndpoints.status }).from(routedEndpoints).where(endpointIs(host, path));
  const [paid] = await tx.select({ count: count() }).from(routedEndpoints).where(ofHost(host, 'paid'));
  const room = (paid?.count ?? 0) < maxRoutedEndpointsPerHost;
  if (existing) {
    if (existing.status === 'checked' && room) {
      // It becomes paid, and stops counting against the checked ones
      await tx.update(routedEndpoints).set({ ...priced, status: 'paid' }).where(endpointIs(host, path));
      await keepCheckedHost(tx, host, { paidAt: now });
    }
    else if (existing.status === 'checked') {
      await tx.delete(routedEndpoints).where(and(endpointIs(host, path), eq(routedEndpoints.status, 'checked'), isNull(routedEndpoints.feeBps)));
      await keepCheckedHost(tx, host, {});

      return 'capped';
    }
    else if (lastPrice !== undefined)
      await tx.update(routedEndpoints).set(priced).where(endpointIs(host, path));

    return 'exists';
  }
  if (!room)
    return 'capped';
  const created = await tx.insert(routedEndpoints).values({ host, path, lastPrice: lastPrice ?? null, createdAt: now, status: 'paid' }).onConflictDoNothing().returning();
  if (created.length === 0)
    return 'exists';
  await tx.update(checkedHosts).set({ paidAt: sql`coalesce(${checkedHosts.paidAt}, ${now}::timestamptz)` }).where(eq(checkedHosts.host, host));

  return 'created';
};

/**
 * A payable check's endpoint: its time, method and price for one listed, else a new one within the caps. A host
 * the count doesn't store and no check reached before joins the checked pool: only when its client was counted
 * for a new host, and within the pool's caps. Each statement, a wait for a lock included, gives up after
 * `checkedRegistrationTimeoutMs`: anyone can send one.
 */
const registerChecked = async (
  tx: DatabaseTransaction, { host, path, lastPrice, checked }: EndpointInput & { readonly checked: NonNullable<EndpointInput['checked']> }, now: Date,
): Promise<EndpointRegistration> => {
  await tx.execute(sql.raw(`set local statement_timeout = ${checkedRegistrationTimeoutMs}`));
  await lockHost(tx, host);
  const { rows: [state] } = await tx.execute<{ status: RoutedEndpointStatus | null; checked: number; stored: boolean; known: boolean; blocked: boolean }>(sql`select
    (select ${routedEndpoints.status} from ${routedEndpoints} where ${endpointIs(host, path)}) as status,
    (select count(*)::int from ${routedEndpoints} where ${ofHost(host, 'checked')}) as checked,
    ${storedSql(sql`${host}::text`)} as stored,
    exists (select 1 from ${checkedHosts} where ${checkedHosts.host} = ${host}) as known,
    ${blockedForListingSql(host)} as blocked`);
  if (state?.blocked)
    return 'blocked';
  const existing = state?.status ?? undefined;
  const joinsPool = !state?.stored && !state?.known;
  if (existing === undefined && (state?.checked ?? 0) >= maxCheckedEndpointsPerHost)
    return 'capped';
  if (joinsPool && !checked.mayAddHost)
    return 'limited';
  if (joinsPool || existing === undefined) {
    await lockCaps(tx);
    if (joinsPool && !(await makeRoomIn(tx, maxCheckedHostsPerParent, parentDomainOf(host)) && await makeRoomIn(tx, maxCheckedHosts, undefined)))
      return 'capped';
    if (existing === undefined && !await makeEndpointRoom(tx, host))
      return 'capped';
  }
  if (existing !== undefined) {
    await tx.update(routedEndpoints).set({ checkedAt: now, checkMethod: checked.method, ...lastPrice === undefined ? {} : { lastPrice } }).where(endpointIs(host, path));
    await keepCheckedHost(tx, host, { checkedAt: now });

    return 'exists';
  }
  const created = await tx.insert(routedEndpoints).values({
    host, path, lastPrice: lastPrice ?? null, createdAt: now, status: 'checked', checkedAt: now, checkMethod: checked.method,
  }).onConflictDoNothing().returning();
  await keepCheckedHost(tx, host, { checkedAt: now });

  return created.length > 0 ? 'created' : 'exists';
};

export const createRoutingRepository = ({ db, clock }: RoutingRepositoryOptions): RoutingRepository => ({
  isBlocked: async host => (await db.select({ host: hostBlocklist.host }).from(hostBlocklist).where(eq(hostBlocklist.host, host))).length > 0,

  block: async ({ host, reason }) => {
    await db.insert(hostBlocklist).values({ host, reason, createdAt: clock.now() })
      .onConflictDoUpdate({ target: hostBlocklist.host, set: { reason } });
  },

  unblock: async host => (await db.delete(hostBlocklist).where(eq(hostBlocklist.host, host)).returning()).length > 0,

  registerEndpoint: input => withTransaction(db, async (tx): Promise<EndpointRegistration> => {
    const now = clock.now();
    const { checked } = input;

    return checked === undefined ? registerPaid(tx, input, now) : registerChecked(tx, { ...input, checked }, now);
  }),

  endpointListing: async (host, path, { timeoutMs }) => {
    const { rows: [row] } = await withTransaction(db, async tx => {
      await tx.execute(sql.raw(`set local statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`));

      // The endpoint and the host by the key, the host's checked endpoints by their index (at most 20), the
      // count's and the checked hosts' rows and the blocklist's names by their keys
      return tx.execute<{ status: RoutedEndpointStatus | null; host_listed: boolean; checked: number; stored: boolean; known: boolean; blocked: boolean }>(sql`select
        (select ${routedEndpoints.status} from ${routedEndpoints} where ${endpointIs(host, path)}) as status,
        ${hostListedSql(host)} as host_listed,
        (select count(*)::int from ${routedEndpoints} where ${ofHost(host, 'checked')}) as checked,
        ${storedSql(sql`${host}::text`)} as stored,
        exists (select 1 from ${checkedHosts} where ${checkedHosts.host} = ${host}) as known,
        ${blockedForListingSql(host)} as blocked`);
    });

    return {
      status: row?.status ?? undefined, hostListed: row?.host_listed === true, checkedEndpoints: row?.checked ?? 0, stored: row?.stored === true,
      checkedHost: row?.known === true, blocked: row?.blocked === true,
    };
  },

  endpointFee: async (host, path) => {
    const [row] = await db.select({ feeBps: routedEndpoints.feeBps }).from(routedEndpoints).where(endpointIs(host, path));

    return row?.feeBps ?? undefined;
  },

  // Only an endpoint a paid call reached: one listed only by a check has no fee to set, as one never listed
  setEndpointFee: async ({ host, path, feeBps }) => (await db.update(routedEndpoints).set({ feeBps })
    .where(and(endpointIs(host, path), eq(routedEndpoints.status, 'paid'))).returning()).length > 0,

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
