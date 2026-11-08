import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Clock, IdGenerator, MicroUsd } from '@anyfare/common';
import { CreditReferenceConflictError, type CreditsBalance, type HoldInput, type HoldResult, type KeySpend, type Payment } from '@anyfare/core';

import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from './postgres.js';
import { balances, ledgerAccounts, ledgerEntries, ledgerTransactions } from './schema/ledger.js';

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
  hold(input: HoldInput): Promise<HoldResult>;
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

    hold: async () => {
      throw new Error('not implemented');
    },

    release: async () => {
      throw new Error('not implemented');
    },

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

    keySpend: async () => {
      throw new Error('not implemented');
    },
  };
};
