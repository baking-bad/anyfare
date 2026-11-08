import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Clock, IdGenerator, MicroUsd } from '@anyfare/common';
import {
  CreditReferenceConflictError, HoldReferenceConflictError, InvalidPaymentStatusChangeError, utcDay, type CreditsBalance, type HoldInput,
  type HoldRefusal, type HoldResult, type KeySpend, type Payment,
} from '@anyfare/core';

import { createPaymentRepository } from './paymentRepository.js';
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from './postgres.js';
import { balances, keyDailySpend, keyTotalSpend, ledgerAccounts, ledgerEntries, ledgerTransactions } from './schema/ledger.js';

/** The ledger accounts' IDs: an account's own, and the platform's. */
export const ledgerAccountIds = {
  available: (accountId: string) => `${accountId}:available`,
  held: (accountId: string) => `${accountId}:held`,
  depositsClearing: 'platform:deposits_clearing',
} as const;

export interface LedgerOptions {
  // The database, or a transaction to join: each operation then runs in a savepoint of it
  readonly db: DatabaseExecutor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface CreditResult {
  readonly transactionId: string;
  readonly createdAt: Date;
  // The reference was used before, for the same account and amount: nothing moved this time
  readonly replayed: boolean;
}

/** The ledger's money movements: double entry, one database transaction each, keyed by operation and reference. */
export interface Ledger {
  /** Deposits clearing → the buyer's available credits. Idempotent by `reference`. Throws CreditReferenceConflictError for a reused one. */
  credit(input: { readonly accountId: string; readonly amount: MicroUsd; readonly reference: string; readonly requestId?: string }): Promise<CreditResult>;
  /**
   * Available → held for a credits payment, counted on its key against the daily budget and the
   * allowance, with the payment row, in one transaction. A refusal moves nothing. The same payment
   * held again returns the first hold; held again for another buyer, key or amount, it throws
   * HoldReferenceConflictError.
   */
  hold(input: HoldInput): Promise<HoldResult>;
  /**
   * Held → available: what the hold moved, and the key's spend given back to the UTC day the hold
   * counted on. A second release moves nothing. Throws InvalidPaymentStatusChangeError for a payment
   * that isn't held.
   */
  release(input: { readonly paymentId: string }): Promise<{ readonly payment: Payment }>;
  balance(accountId: string): Promise<CreditsBalance>;
  /** Ledger accounts' balances by ID. An account never used is absent. */
  balancesOf(ledgerAccountIds: readonly string[]): Promise<ReadonlyMap<string, bigint>>;
  /** Each key's spend: on the given UTC day, and in total. Keys without spend aren't in the map. */
  keySpend(keyIds: readonly string[], day: string): Promise<ReadonlyMap<string, KeySpend>>;
}

interface Posting {
  readonly ledgerAccountId: string;
  // Added to the account's balance
  readonly amount: bigint;
}

interface LedgerAccount {
  readonly id: string;
  readonly accountId: string | undefined;
  readonly type: string;
  readonly mayGoNegative: boolean;
}

// A refused hold rolls its transaction back, then becomes a result
class HoldRefused extends Error {
  constructor(readonly refusal: HoldRefusal) {
    super(refusal);
  }
}

const platformPrefix = 'platform:';

const accountsOf = (accountId: string, ...types: readonly ('available' | 'held')[]): LedgerAccount[] =>
  types.map(type => ({ id: ledgerAccountIds[type](accountId), accountId, type, mayGoNegative: false }));
// A platform account's type is its ID without the prefix
const platformAccount = (id: string, mayGoNegative: boolean): LedgerAccount =>
  ({ id, accountId: undefined, type: id.slice(platformPrefix.length), mayGoNegative });
// Credits come from it, so its balance is minus everything credited
const depositsClearing = platformAccount(ledgerAccountIds.depositsClearing, true);

const isPlatformAccount = (ledgerAccountId: string): boolean => ledgerAccountId.startsWith(platformPrefix);

/**
 * The one order every transaction updates balances in, so none deadlock: the platform's accounts
 * last, since many transactions share them and should hold them only until the commit, then by ID.
 */
const lockOrder = (left: Posting, right: Posting): number =>
  Number(isPlatformAccount(left.ledgerAccountId)) - Number(isPlatformAccount(right.ledgerAccountId))
  || (left.ledgerAccountId < right.ledgerAccountId ? -1 : left.ledgerAccountId > right.ledgerAccountId ? 1 : 0);

export const createLedger = ({ db, clock, ids }: LedgerOptions): Ledger => {
  const ensureAccounts = async (tx: DatabaseTransaction, list: readonly LedgerAccount[], now: Date): Promise<void> => {
    await tx.insert(ledgerAccounts)
      .values(list.map(account => ({ id: account.id, accountId: account.accountId ?? null, type: account.type, createdAt: now })))
      .onConflictDoNothing();
    await tx.insert(balances)
      .values(list.map(account => ({ ledgerAccountId: account.id, balance: 0n, mayGoNegative: account.mayGoNegative, updatedAt: now })))
      .onConflictDoNothing();
  };

  // The transaction's ID, or undefined when this operation and reference already moved money
  const insertTransaction = async (tx: DatabaseTransaction, operation: string, reference: string, requestId: string | undefined, now: Date) => {
    const [row] = await tx.insert(ledgerTransactions)
      .values({ id: ids.next(), operation, reference, requestId: requestId ?? null, createdAt: now })
      .onConflictDoNothing({ target: [ledgerTransactions.operation, ledgerTransactions.reference] })
      .returning({ id: ledgerTransactions.id });

    return row?.id;
  };

  // Adds to each balance in turn. The first account that would go below zero, or doesn't exist.
  const updateBalances = async (tx: DatabaseTransaction, postings: readonly Posting[], now: Date): Promise<string | undefined> => {
    for (const { ledgerAccountId, amount } of postings) {
      const updated = await tx.update(balances)
        .set({ balance: sql`${balances.balance} + ${amount}::bigint`, updatedAt: now })
        .where(and(eq(balances.ledgerAccountId, ledgerAccountId), sql`(${balances.mayGoNegative} or ${balances.balance} + ${amount}::bigint >= 0)`))
        .returning({ id: balances.ledgerAccountId });
      if (updated.length === 0)
        return ledgerAccountId;
    }

    return undefined;
  };

  /**
   * Posts the entries and updates the balances in `lockOrder`, so concurrent postings never
   * deadlock: the members' balances by ID, then the entries, then the platform's balances, which
   * many transactions share, so their row locks are held only until the commit. Returns the first
   * account that would go below zero, or doesn't exist: the caller rolls back.
   */
  const post = async (tx: DatabaseTransaction, transactionId: string, postings: readonly Posting[], now: Date): Promise<string | undefined> => {
    const entries = postings.filter(posting => posting.amount !== 0n);
    if (entries.reduce((sum, posting) => sum + posting.amount, 0n) !== 0n)
      throw new Error('A ledger transaction\'s entries must sum to zero');

    const ordered = [...entries].sort(lockOrder);
    const refused = await updateBalances(tx, ordered.filter(posting => !isPlatformAccount(posting.ledgerAccountId)), now);
    if (refused !== undefined)
      return refused;
    if (entries.length > 0)
      await tx.insert(ledgerEntries).values(entries.map(posting => ({ id: ids.next(), transactionId, ...posting })));

    return updateBalances(tx, ordered.filter(posting => isPlatformAccount(posting.ledgerAccountId)), now);
  };

  const hasTransaction = async (tx: DatabaseTransaction, operation: string, reference: string): Promise<boolean> => {
    const [row] = await tx.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.operation, operation), eq(ledgerTransactions.reference, reference)));

    return row !== undefined;
  };

  // What a payment's hold moved to the buyer's held balance, or undefined when the ledger never held it
  const heldByHold = async (tx: DatabaseTransaction, paymentId: string, buyerAccountId: string): Promise<bigint | undefined> => {
    const [row] = await tx.select({ amount: ledgerEntries.amount }).from(ledgerTransactions)
      .leftJoin(ledgerEntries, and(
        eq(ledgerEntries.transactionId, ledgerTransactions.id),
        eq(ledgerEntries.ledgerAccountId, ledgerAccountIds.held(buyerAccountId)),
      ))
      .where(and(eq(ledgerTransactions.operation, 'hold'), eq(ledgerTransactions.reference, paymentId)));

    // A hold of zero posts no entries
    return row && (row.amount ?? 0n);
  };

  // A held amount counts against the key's spend: today's, then the total. A release gives it back.
  const addSpend = async (tx: DatabaseTransaction, keyId: string, day: string, amount: bigint, dailyBudget: bigint, allowance: bigint | undefined): Promise<HoldRefusal | undefined> => {
    if (amount > dailyBudget)
      return 'key_budget_exceeded';
    const [daily] = await tx.insert(keyDailySpend).values({ keyId, day, spent: amount })
      .onConflictDoUpdate({
        target: [keyDailySpend.keyId, keyDailySpend.day],
        set: { spent: sql`${keyDailySpend.spent} + ${amount}::bigint` },
        setWhere: sql`${keyDailySpend.spent} + ${amount}::bigint <= ${dailyBudget}::bigint`,
      })
      .returning({ spent: keyDailySpend.spent });
    if (!daily)
      return 'key_budget_exceeded';

    if (allowance !== undefined && amount > allowance)
      return 'key_allowance_exceeded';
    const [total] = await tx.insert(keyTotalSpend).values({ keyId, spent: amount })
      .onConflictDoUpdate({
        target: keyTotalSpend.keyId,
        set: { spent: sql`${keyTotalSpend.spent} + ${amount}::bigint` },
        ...(allowance === undefined ? {} : { setWhere: sql`${keyTotalSpend.spent} + ${amount}::bigint <= ${allowance}::bigint` }),
      })
      .returning({ spent: keyTotalSpend.spent });

    return total ? undefined : 'key_allowance_exceeded';
  };

  const giveBackSpend = async (tx: DatabaseTransaction, keyId: string, day: string, amount: bigint): Promise<void> => {
    await tx.update(keyDailySpend).set({ spent: sql`${keyDailySpend.spent} - ${amount}::bigint` })
      .where(and(eq(keyDailySpend.keyId, keyId), eq(keyDailySpend.day, day)));
    await tx.update(keyTotalSpend).set({ spent: sql`${keyTotalSpend.spent} - ${amount}::bigint` })
      .where(eq(keyTotalSpend.keyId, keyId));
  };

  return {
    credit: ({ accountId, amount, reference, requestId }) => withTransaction(db, async tx => {
      if (amount <= 0n)
        throw new RangeError('A credit must be more than zero');

      const now = clock.now();
      const available = ledgerAccountIds.available(accountId);
      await ensureAccounts(tx, [...accountsOf(accountId, 'available', 'held'), depositsClearing], now);
      const transactionId = await insertTransaction(tx, 'credit', reference, requestId, now);
      if (!transactionId) {
        // The reference was used before: the same credit again is a replay, anything else a conflict
        const [existing] = await tx.select({ id: ledgerTransactions.id, createdAt: ledgerTransactions.createdAt, ledgerAccountId: ledgerEntries.ledgerAccountId, amount: ledgerEntries.amount })
          .from(ledgerTransactions)
          .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
          .where(and(eq(ledgerTransactions.operation, 'credit'), eq(ledgerTransactions.reference, reference), sql`${ledgerEntries.amount} > 0`));
        if (existing?.ledgerAccountId !== available || existing.amount !== amount)
          throw new CreditReferenceConflictError();

        return { transactionId: existing.id, createdAt: existing.createdAt, replayed: true };
      }

      const refused = await post(tx, transactionId, [{ ledgerAccountId: depositsClearing.id, amount: -amount }, { ledgerAccountId: available, amount }], now);
      if (refused !== undefined)
        throw new Error(`The credit could not be posted: the balance of ${refused} is missing or may not go below zero`);

      return { transactionId, createdAt: now, replayed: false };
    }),

    hold: async ({ payment, dailyBudget, allowance }) => {
      try {
        return await withTransaction(db, async (tx): Promise<HoldResult> => {
          // One clock read: the day the spend counts on is the day of the payment's createdAt, which a
          // release gives the spend back to
          const now = clock.now();
          const payments = createPaymentRepository({ db: tx, clock: { now: () => new Date(now) } });
          const transactionId = await insertTransaction(tx, 'hold', payment.id, payment.requestId, now);
          if (!transactionId) {
            // The same hold again: the first one stands, whatever happened to it since. Another
            // buyer, key or amount under the same payment ID is a conflict.
            const existing = await payments.find(payment.id);
            if (!existing)
              throw new Error('A hold transaction exists without its payment');
            if (existing.buyerAccountId !== payment.buyerAccountId || existing.keyId !== payment.keyId || existing.amount !== payment.amount)
              throw new HoldReferenceConflictError();

            return { ok: true, payment: existing };
          }

          const { buyerAccountId, keyId, amount } = payment;
          // The payment row first: it is new, so it locks nothing that other transactions wait on
          const created = await payments.create({ ...payment, status: 'held' });
          // The balances, then today's spend, then the total: every hold locks rows in the same order
          if (await post(tx, transactionId, [
            { ledgerAccountId: ledgerAccountIds.available(buyerAccountId), amount: -amount },
            { ledgerAccountId: ledgerAccountIds.held(buyerAccountId), amount },
          ], now))
            throw new HoldRefused('insufficient_balance');
          const refusal = await addSpend(tx, keyId, utcDay(now), amount, dailyBudget, allowance);
          if (refusal)
            throw new HoldRefused(refusal);

          return { ok: true, payment: created };
        });
      }
      catch (error) {
        if (error instanceof HoldRefused)
          return { ok: false, refusal: error.refusal };
        throw error;
      }
    },

    release: ({ paymentId }) => withTransaction(db, async tx => {
      const payments = createPaymentRepository({ db: tx, clock });
      const current = await payments.lock(paymentId);
      // A second release moves nothing, but only a release the ledger booked is one
      if (current?.status === 'released') {
        if (!await hasTransaction(tx, 'release', paymentId))
          throw new Error(`The payment ${paymentId} was released outside the ledger, so its hold was never given back`);

        return { payment: current };
      }
      if (!current || current.status !== 'held' || current.rail !== 'credits' || !current.buyerAccountId)
        throw new InvalidPaymentStatusChangeError(paymentId, current?.status, 'released');

      const buyer = current.buyerAccountId;
      // What goes back is what the hold moved, not what the row says
      const amount = await heldByHold(tx, paymentId, buyer);
      if (amount === undefined)
        throw new Error(`The payment ${paymentId} has no hold, so there is nothing to release`);
      const now = clock.now();
      const transactionId = await insertTransaction(tx, 'release', paymentId, current.requestId, now);
      if (!transactionId)
        throw new Error('A release transaction exists for a payment still held');
      const released = await payments.changeStatus({ paymentId, to: 'released' });
      // The same lock order as a hold: the payment row, the balances, then the key's spend
      if (await post(tx, transactionId, [
        { ledgerAccountId: ledgerAccountIds.held(buyer), amount: -amount },
        { ledgerAccountId: ledgerAccountIds.available(buyer), amount },
      ], now))
        throw new Error('The held amount is missing from the buyer\'s held balance');
      // The spend goes back to the day it was counted on
      if (current.keyId)
        await giveBackSpend(tx, current.keyId, utcDay(current.createdAt), amount);

      return { payment: released };
    }),

    balance: async accountId => {
      const available = ledgerAccountIds.available(accountId);
      const rows = await db.select({ id: balances.ledgerAccountId, balance: balances.balance }).from(balances)
        .where(inArray(balances.ledgerAccountId, [available, ledgerAccountIds.held(accountId)]));

      return {
        available: rows.find(row => row.id === available)?.balance ?? 0n,
        held: rows.find(row => row.id !== available)?.balance ?? 0n,
      };
    },

    balancesOf: async ids => {
      if (ids.length === 0)
        return new Map();
      const rows = await db.select({ id: balances.ledgerAccountId, balance: balances.balance }).from(balances).where(inArray(balances.ledgerAccountId, [...ids]));

      return new Map(rows.map(row => [row.id, row.balance]));
    },

    keySpend: async (keyIds, day) => {
      const spend = new Map<string, KeySpend>();
      if (keyIds.length === 0)
        return spend;

      const [daily, totals] = await Promise.all([
        db.select().from(keyDailySpend).where(and(inArray(keyDailySpend.keyId, [...keyIds]), eq(keyDailySpend.day, day))),
        db.select().from(keyTotalSpend).where(inArray(keyTotalSpend.keyId, [...keyIds])),
      ]);
      for (const { keyId, spent } of totals)
        spend.set(keyId, { today: 0n, total: spent });
      for (const { keyId, spent } of daily)
        spend.set(keyId, { today: spent, total: spend.get(keyId)?.total ?? 0n });

      return spend;
    },
  };
};
