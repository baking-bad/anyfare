import { and, eq, inArray, sql } from 'drizzle-orm';

import { formatUsd, type Clock, type IdGenerator, type MicroUsd } from '@anyfare/common';
import {
  CreditReferenceConflictError, FundingReferenceConflictError, HoldReferenceConflictError, InvalidPaymentStatusChangeError, PromotionReferenceConflictError,
  TopUpReferenceConflictError, TreasuryTransferReferenceConflictError, utcDay,
  type CaptureResult, type CreditsBalance, type HoldInput, type HoldRefusal, type HoldResult, type KeySpend, type Payment, type PaymentStatus,
  type SettleInput,
} from '@anyfare/core';

import { createPaymentRepository } from './paymentRepository.js';
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from './postgres.js';
import { unchargedPaymentStatuses } from './routingRepository.js';
import { balances, keyDailySpend, keyTotalSpend, ledgerAccounts, ledgerEntries, ledgerTransactions } from './schema/ledger.js';
import { targetPayments, type TargetPaymentStatus } from './schema/routing.js';

/** The ledger accounts' IDs: an account's own, and the platform's. */
export const ledgerAccountIds = {
  available: (accountId: string) => `${accountId}:available`,
  held: (accountId: string) => `${accountId}:held`,
  depositsClearing: 'platform:deposits_clearing',
  // The on-chain money of one asset, by its registry name, such as `platform:treasury:base-usdc`
  treasury: (asset: string) => `platform:treasury:${asset}`,
  // What rebalancing cost: the USD lost between two assets
  conversion: 'platform:conversion',
  // The fee on routed calls, and what targets kept while their buyers weren't charged
  routingFees: 'platform:routing_fees',
  routingLosses: 'platform:routing_losses',
  // Free Credits the platform gave away, such as on sign-up
  promotions: 'platform:promotions',
  // The owner's own money put into the platform's wallets from outside
  capital: 'platform:capital',
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
  // The operation already moved money for this reference: nothing moved this time, and the first
  // transaction is returned. A credit replays only for the same account and amount.
  readonly replayed: boolean;
}

/** The ledger's money movements: double entry, one database transaction each, keyed by operation and reference. */
export interface Ledger {
  /** Deposits clearing → the buyer's available credits. Idempotent by `reference`. Throws CreditReferenceConflictError for a reused one. */
  credit(input: { readonly accountId: string; readonly amount: MicroUsd; readonly reference: string; readonly requestId?: string }): Promise<CreditResult>;
  /**
   * Free Credits the platform gives: promotions → the account's available credits. Idempotent by
   * `reference`, such as the new account's ID: the same gift again is a replay, and another account or
   * amount under the same reference throws PromotionReferenceConflictError. Throws RangeError for an
   * amount of zero or less.
   */
  promotion(input: { readonly accountId: string; readonly amount: MicroUsd; readonly reference: string; readonly requestId?: string }): Promise<CreditResult>;
  /**
   * A top-up that arrived on chain: the treasury of `asset` → the account's available credits. The
   * asset is in the treasury's account on chain, so the treasury's balance falls by the amount: it
   * holds more. Idempotent by `reference`, the top-up's deposit address: the same top-up again is a
   * replay, and another account, asset or amount under the same reference throws
   * TopUpReferenceConflictError. Throws RangeError for an amount of zero or less.
   */
  topUp(input: {
    readonly accountId: string;
    // The registry asset that arrived, such as near-usdc
    readonly asset: string;
    readonly amount: MicroUsd;
    readonly reference: string;
    readonly requestId?: string;
  }): Promise<CreditResult>;
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
  /**
   * Charges a held credits payment for a routed call: held → the treasury of the asset the target was
   * paid in, the target's price, and the routing fees, the rest of the quote. What leaves the held
   * balance is what the hold moved. The key's spend stays counted. Needs the call's target leg,
   * neither refused by the target nor booked as a routing loss, and marks it as charged: for a leg
   * the target refused nothing has moved yet, so the hold is released instead. With the status
   * change to `captured` in the same transaction. A second capture moves nothing. Throws
   * InvalidPaymentStatusChangeError for a payment that isn't a held credits payment.
   */
  capture(input: { readonly paymentId: string }): Promise<CaptureResult>;
  /**
   * Books a settled on-chain payment (x402, MPP) for a routed call: the buyer's money arrived in the
   * treasury of `asset`, the target was paid from the treasury of its leg's asset, and the routing
   * fees take the rest of the quote. Needs the call's target leg, not booked as a routing loss, and
   * marks it as charged. When the target refused our payment, nobody was paid, and the buyer's money
   * is already on chain: no treasury pays out, and the whole quote is the fee. With the status
   * change to `settled` in the same transaction, from `verified` or `settling`, and the settle
   * request cleared. A second settle moves nothing. Throws InvalidPaymentStatusChangeError for a
   * credits payment, or one that can't settle.
   */
  settle(input: SettleInput): Promise<CaptureResult>;
  /**
   * A target kept the platform's payment while the buyer wasn't charged: routing losses → the target
   * asset's treasury, once per payment, and the target leg marked as booked. Only for a settled leg
   * whose buyer was never charged and whose payment failed, was released, or was cancelled.
   */
  routingLoss(input: { readonly paymentId: string }): Promise<CreditResult>;
  /**
   * Books a rebalancing an operator did: one asset's treasury → another's, with the USD lost between
   * them as the conversion cost. Idempotent by reference: the same transfer again is a replay, and
   * another one under the same reference throws TreasuryTransferReferenceConflictError. Throws
   * RangeError for an amount of zero or less, and for a transfer that would gain USD.
   */
  treasuryTransfer(input: {
    readonly reference: string;
    readonly from: { readonly asset: string; readonly amount: MicroUsd };
    readonly to: { readonly asset: string; readonly amount: MicroUsd };
    readonly requestId?: string;
  }): Promise<CreditResult>;
  /**
   * Books money the owner put into a platform wallet from outside, between capital and the treasury
   * of `asset`. The treasury holds more on chain, so its balance falls by the amount, and capital's
   * rises by it.
   * Idempotent by reference: the same funding again is a replay, and another asset or amount under
   * the same reference throws FundingReferenceConflictError. Throws RangeError for an amount of zero
   * or less.
   */
  funding(input: {
    readonly reference: string;
    // The registry asset that arrived, such as near-usdc
    readonly asset: string;
    readonly amount: MicroUsd;
    readonly requestId?: string;
  }): Promise<CreditResult>;
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
// Money enters and leaves the chain through it, so its balance can go either way: minus what it holds
const treasuryOf = (asset: string): LedgerAccount => platformAccount(ledgerAccountIds.treasury(asset), true);
// What rebalancings lost: its balance is minus their total
const conversion = platformAccount(ledgerAccountIds.conversion, true);
// What the platform earned on routed calls
const routingFees = platformAccount(ledgerAccountIds.routingFees, false);
// An expense: its balance is minus what targets kept
const routingLosses = platformAccount(ledgerAccountIds.routingLosses, true);
// Free Credits come from it, so its balance is minus everything given
const promotions = platformAccount(ledgerAccountIds.promotions, true);
// The owner's money put in from outside: its balance is everything put in. It may go below zero,
// should the owner one day take out more than they put in.
const capital = platformAccount(ledgerAccountIds.capital, true);

const isPlatformAccount = (ledgerAccountId: string): boolean => ledgerAccountId.startsWith(platformPrefix);

/**
 * The one order every transaction updates balances in, so none deadlock: the platform's accounts
 * last, since many transactions share them and should hold them only until the commit, then by ID.
 */
const lockOrder = (left: Posting, right: Posting): number =>
  Number(isPlatformAccount(left.ledgerAccountId)) - Number(isPlatformAccount(right.ledgerAccountId))
  || (left.ledgerAccountId < right.ledgerAccountId ? -1 : left.ledgerAccountId > right.ledgerAccountId ? 1 : 0);

// Whether booked entries are the postings, in any order. Postings of zero post no entry.
const samePostings = (entries: readonly Posting[], postings: readonly Posting[]): boolean => {
  const key = (posting: Posting) => `${posting.ledgerAccountId} ${posting.amount}`;
  const left = entries.map(key).sort();
  const right = postings.filter(posting => posting.amount !== 0n).map(key).sort();

  return left.length === right.length && left.every((entry, index) => entry === right[index]);
};

/**
 * The target leg the buyer is charged for, locked after the payment row, the order every operation
 * on a routed payment takes. The proxy records it before it charges the buyer. A leg booked as a
 * routing loss was already counted as the platform's. The caller decides what a leg the target
 * refused (`failed`) means; one still `signed` or `unknown` is charged as paid.
 */
const legToCharge = async (tx: DatabaseTransaction, paymentId: string): Promise<{ readonly asset: string; readonly amount: bigint; readonly status: TargetPaymentStatus }> => {
  const [target] = await tx.select({ asset: targetPayments.asset, amount: targetPayments.amount, status: targetPayments.status, lossBooked: targetPayments.lossBooked })
    .from(targetPayments).where(eq(targetPayments.paymentId, paymentId)).for('update');
  if (!target)
    throw new Error(`The payment ${paymentId} has no target leg: the target must be paid and recorded before the buyer is charged`);
  if (target.lossBooked)
    throw new Error(`The target leg of ${paymentId} is booked as a routing loss, so the buyer can't be charged for it`);

  return target;
};

// The ledger charged the buyer for the leg, in the transaction that books it: the leg is no routing loss
const markCharged = async (tx: DatabaseTransaction, paymentId: string, now: Date): Promise<void> => {
  await tx.update(targetPayments).set({ buyerCharged: true, updatedAt: now }).where(eq(targetPayments.paymentId, paymentId));
};

const isUncharged = (status: PaymentStatus): boolean => (unchargedPaymentStatuses as readonly PaymentStatus[]).includes(status);

// The routing fee is fixed in the quote: what the buyer pays less the target's price
const routingFee = (payment: Payment, targetAmount: bigint): bigint => {
  const fee = payment.amount - targetAmount;
  if (fee < 0n)
    throw new Error(`The target's price, $${formatUsd(targetAmount)}, is more than the quote of the payment ${payment.id}, $${formatUsd(payment.amount)}`);

  return fee;
};

export const createLedger = ({ db, clock, ids }: LedgerOptions): Ledger => {
  const ensureAccounts = async (tx: DatabaseTransaction, accounts: readonly LedgerAccount[], now: Date): Promise<void> => {
    // Once each, and in one order, so concurrent transactions that create the same accounts never deadlock
    const list = [...new Map(accounts.map(account => [account.id, account])).values()]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
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

  const findTransaction = async (tx: DatabaseTransaction, operation: string, reference: string) => {
    const [row] = await tx.select({ id: ledgerTransactions.id, createdAt: ledgerTransactions.createdAt }).from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.operation, operation), eq(ledgerTransactions.reference, reference)));

    return row;
  };

  const hasTransaction = async (tx: DatabaseTransaction, operation: string, reference: string): Promise<boolean> =>
    (await findTransaction(tx, operation, reference)) !== undefined;

  // The entries an operation booked under a reference: what a replay must match
  const bookedPostings = (tx: DatabaseTransaction, operation: string, reference: string): Promise<Posting[]> =>
    tx.select({ ledgerAccountId: ledgerEntries.ledgerAccountId, amount: ledgerEntries.amount }).from(ledgerTransactions)
      .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
      .where(and(eq(ledgerTransactions.operation, operation), eq(ledgerTransactions.reference, reference)));

  // The first transaction of an operation the reference already used: what a replay returns
  const replayOf = async (tx: DatabaseTransaction, operation: string, reference: string): Promise<CreditResult> => {
    const existing = await findTransaction(tx, operation, reference);
    if (!existing)
      throw new Error(`The ${operation} transaction for ${reference} conflicted but can't be found`);

    return { transactionId: existing.id, createdAt: existing.createdAt, replayed: true };
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

    promotion: ({ accountId, amount, reference, requestId }) => withTransaction(db, async tx => {
      if (amount <= 0n)
        throw new RangeError('A promotion must give more than zero');

      const postings: readonly Posting[] = [
        { ledgerAccountId: promotions.id, amount: -amount },
        { ledgerAccountId: ledgerAccountIds.available(accountId), amount },
      ];
      const now = clock.now();
      await ensureAccounts(tx, [...accountsOf(accountId, 'available', 'held'), promotions], now);
      const transactionId = await insertTransaction(tx, 'promotion', reference, requestId, now);
      if (!transactionId) {
        // The reference was used before: the same gift again is a replay, anything else a conflict
        if (!samePostings(await bookedPostings(tx, 'promotion', reference), postings))
          throw new PromotionReferenceConflictError();

        return replayOf(tx, 'promotion', reference);
      }

      const refused = await post(tx, transactionId, postings, now);
      if (refused !== undefined)
        throw new Error(`The promotion could not be posted: the balance of ${refused} is missing or may not go below zero`);

      return { transactionId, createdAt: now, replayed: false };
    }),

    topUp: ({ accountId, asset, amount, reference, requestId }) => withTransaction(db, async tx => {
      if (amount <= 0n)
        throw new RangeError('A top-up must add more than zero');

      const treasury = treasuryOf(asset);
      const postings: readonly Posting[] = [
        { ledgerAccountId: treasury.id, amount: -amount },
        { ledgerAccountId: ledgerAccountIds.available(accountId), amount },
      ];
      const now = clock.now();
      await ensureAccounts(tx, [...accountsOf(accountId, 'available', 'held'), treasury], now);
      const transactionId = await insertTransaction(tx, 'top_up', reference, requestId, now);
      if (!transactionId) {
        // The reference was used before: the same top-up again is a replay, anything else a conflict
        if (!samePostings(await bookedPostings(tx, 'top_up', reference), postings))
          throw new TopUpReferenceConflictError();

        return replayOf(tx, 'top_up', reference);
      }

      const refused = await post(tx, transactionId, postings, now);
      if (refused !== undefined)
        throw new Error(`The top-up could not be posted: the balance of ${refused} is missing or may not go below zero`);

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

    capture: ({ paymentId }) => withTransaction(db, async (tx): Promise<CaptureResult> => {
      const payments = createPaymentRepository({ db: tx, clock });
      const current = await payments.lock(paymentId);
      // A second capture moves nothing, but only a capture the ledger booked is one
      if (current?.status === 'captured') {
        if (!await hasTransaction(tx, 'capture', paymentId))
          throw new Error(`The payment ${paymentId} was captured outside the ledger, so its held money never moved`);

        return { payment: current, fee: current.fee ?? 0n };
      }
      if (!current || current.status !== 'held' || current.rail !== 'credits' || !current.buyerAccountId)
        throw new InvalidPaymentStatusChangeError(paymentId, current?.status, 'captured');

      const buyer = current.buyerAccountId;
      const target = await legToCharge(tx, paymentId);
      if (target.status === 'failed')
        throw new Error(`The target refused the payment of ${paymentId}'s target leg, so the buyer can't be charged for it`);
      // What leaves the held balance is what the hold moved, not what the row says
      const amount = await heldByHold(tx, paymentId, buyer);
      if (amount === undefined)
        throw new Error(`The payment ${paymentId} has no hold, so there is nothing to capture`);
      if (amount !== current.amount)
        throw new Error(`The hold of the payment ${paymentId} moved $${formatUsd(amount)}, not its amount of $${formatUsd(current.amount)}`);
      const fee = routingFee(current, target.amount);
      const now = clock.now();
      const treasury = treasuryOf(target.asset);
      await ensureAccounts(tx, [treasury, routingFees], now);
      const transactionId = await insertTransaction(tx, 'capture', paymentId, current.requestId, now);
      if (!transactionId)
        throw new Error('A capture transaction exists for a payment still held');
      // The status first, on the row already locked; the buyer's balance, then the shared platform rows, last
      const captured = await payments.changeStatus({ paymentId, to: 'captured', fee });
      if (await post(tx, transactionId, [
        { ledgerAccountId: ledgerAccountIds.held(buyer), amount: -amount },
        { ledgerAccountId: treasury.id, amount: target.amount },
        { ledgerAccountId: routingFees.id, amount: fee },
      ], now))
        throw new Error('The held amount is missing from the buyer\'s held balance');
      await markCharged(tx, paymentId, now);

      return { payment: captured, fee };
    }),

    settle: ({ paymentId, asset, transactionHash, receipt, needsReview }) => withTransaction(db, async (tx): Promise<CaptureResult> => {
      const payments = createPaymentRepository({ db: tx, clock });
      const current = await payments.lock(paymentId);
      // A second settle moves nothing, but only a settlement the ledger booked is one
      if (current?.status === 'settled') {
        if (!await hasTransaction(tx, 'settle', paymentId))
          throw new Error(`The payment ${paymentId} was settled outside the ledger, so its money was never booked`);

        return { payment: current, fee: current.fee ?? 0n };
      }
      if (!current || (current.status !== 'verified' && current.status !== 'settling') || current.rail === 'credits')
        throw new InvalidPaymentStatusChangeError(paymentId, current?.status, 'settled');
      if (current.asset !== undefined && current.asset !== asset)
        throw new Error(`The payment ${paymentId} was paid in ${current.asset}, so it can't settle in ${asset}`);

      const target = await legToCharge(tx, paymentId);
      // The target refused our payment, so nobody was paid: the whole quote, already on chain, is the fee
      const paid = target.status !== 'failed';
      const fee = paid ? routingFee(current, target.amount) : current.amount;
      const now = clock.now();
      // The buyer's money arrived on chain, outside the ledger: the treasury's balance falls by what it took in
      const inflow = treasuryOf(asset);
      const outflow = treasuryOf(target.asset);
      await ensureAccounts(tx, paid ? [inflow, outflow, routingFees] : [inflow, routingFees], now);
      const transactionId = await insertTransaction(tx, 'settle', paymentId, current.requestId, now);
      if (!transactionId)
        throw new Error('A settle transaction exists for a payment not settled');
      const settled = await payments.changeStatus({
        paymentId,
        to: 'settled',
        fee,
        needsReview,
        settlementRequest: null,
        ...(transactionHash === undefined ? {} : { transactionHash }),
        ...(receipt === undefined ? {} : { receipt }),
      });
      const refused = await post(tx, transactionId, [
        { ledgerAccountId: inflow.id, amount: -current.amount },
        ...(paid ? [{ ledgerAccountId: outflow.id, amount: target.amount }] : []),
        { ledgerAccountId: routingFees.id, amount: fee },
      ], now);
      if (refused !== undefined)
        throw new Error(`The settlement could not be posted: the balance of ${refused} is missing or may not go below zero`);
      await markCharged(tx, paymentId, now);

      return { payment: settled, fee };
    }),

    routingLoss: ({ paymentId }) => withTransaction(db, async tx => {
      // The payment row, then its target leg: the order capture and settle lock them in, so a loss
      // and a charge of the same payment run one after the other
      const current = await createPaymentRepository({ db: tx, clock }).lock(paymentId);
      const [target] = await tx.select().from(targetPayments).where(eq(targetPayments.paymentId, paymentId)).for('update');
      if (!current || !target)
        throw new Error(`The payment ${paymentId} has no target leg, so there is no routing loss to book`);
      // A second booking moves nothing, but only a loss the ledger booked is one
      if (target.lossBooked) {
        if (!await hasTransaction(tx, 'routing_loss', paymentId))
          throw new Error(`The target leg of ${paymentId} was marked as a routing loss outside the ledger, so the loss was never booked`);

        return replayOf(tx, 'routing_loss', paymentId);
      }
      if (target.buyerCharged)
        throw new Error(`The buyer of ${paymentId} was charged for the call, so the target's payment is no routing loss`);
      if (!isUncharged(current.status))
        throw new Error(`The payment ${paymentId} is ${current.status}: only a payment that failed, was released, or was cancelled leaves a routing loss`);
      if (target.status !== 'settled')
        throw new Error(`The target leg of ${paymentId} is ${target.status}: only a target that kept our payment leaves a routing loss`);

      const now = clock.now();
      const treasury = treasuryOf(target.asset);
      await ensureAccounts(tx, [treasury, routingLosses], now);
      const transactionId = await insertTransaction(tx, 'routing_loss', paymentId, undefined, now);
      if (!transactionId)
        throw new Error('A routing loss transaction exists for a target leg not booked as one');

      // The target was paid from the treasury, and nobody paid it back
      const refused = await post(tx, transactionId, [
        { ledgerAccountId: routingLosses.id, amount: -target.amount },
        { ledgerAccountId: treasury.id, amount: target.amount },
      ], now);
      if (refused !== undefined)
        throw new Error(`The routing loss could not be posted: the balance of ${refused} is missing or may not go below zero`);
      await tx.update(targetPayments).set({ lossBooked: true, updatedAt: now }).where(eq(targetPayments.paymentId, paymentId));

      return { transactionId, createdAt: now, replayed: false };
    }),

    treasuryTransfer: ({ reference, from, to, requestId }) => withTransaction(db, async tx => {
      if (from.amount <= 0n || to.amount <= 0n)
        throw new RangeError('A treasury transfer must move more than zero');
      if (to.amount > from.amount)
        throw new RangeError('A treasury transfer can\'t gain USD: what arrives is at most what left, and the platform absorbs the conversion cost');

      // The source treasury holds less, so its balance rises; the other holds more, so its balance
      // falls; the difference is the conversion cost
      const postings: readonly Posting[] = [
        { ledgerAccountId: ledgerAccountIds.treasury(from.asset), amount: from.amount },
        { ledgerAccountId: ledgerAccountIds.treasury(to.asset), amount: -to.amount },
        { ledgerAccountId: conversion.id, amount: to.amount - from.amount },
      ];
      const now = clock.now();
      await ensureAccounts(tx, [treasuryOf(from.asset), treasuryOf(to.asset), conversion], now);
      const transactionId = await insertTransaction(tx, 'treasury_transfer', reference, requestId, now);
      if (!transactionId) {
        // The reference was used before: the same transfer again is a replay, anything else a conflict
        if (!samePostings(await bookedPostings(tx, 'treasury_transfer', reference), postings))
          throw new TreasuryTransferReferenceConflictError();

        return replayOf(tx, 'treasury_transfer', reference);
      }

      const refused = await post(tx, transactionId, postings, now);
      if (refused !== undefined)
        throw new Error(`The treasury transfer could not be posted: the balance of ${refused} is missing or may not go below zero`);

      return { transactionId, createdAt: now, replayed: false };
    }),

    funding: ({ reference, asset, amount, requestId }) => withTransaction(db, async tx => {
      if (amount <= 0n)
        throw new RangeError('A funding must add more than zero');

      // The treasury holds more on chain, so its balance falls; the owner put it in, so capital's rises
      const treasury = treasuryOf(asset);
      const postings: readonly Posting[] = [
        { ledgerAccountId: treasury.id, amount: -amount },
        { ledgerAccountId: capital.id, amount },
      ];
      const now = clock.now();
      await ensureAccounts(tx, [treasury, capital], now);
      const transactionId = await insertTransaction(tx, 'funding', reference, requestId, now);
      if (!transactionId) {
        // The reference was used before: the same funding again is a replay, anything else a conflict
        if (!samePostings(await bookedPostings(tx, 'funding', reference), postings))
          throw new FundingReferenceConflictError();

        return replayOf(tx, 'funding', reference);
      }

      const refused = await post(tx, transactionId, postings, now);
      if (refused !== undefined)
        throw new Error(`The funding could not be posted: the balance of ${refused} is missing or may not go below zero`);

      return { transactionId, createdAt: now, replayed: false };
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
