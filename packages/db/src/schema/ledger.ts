import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

import type { BillingDecision, JsonObject, PaymentStatus, RailName } from '@anyfare/core';

import { accounts, apiKeys } from './accounts.js';
import { finalCallStatuses, finishedCallStatuses, statusIn } from './callStatuses.js';
import { atomicAmount } from './columns.js';

// Owned by the ledger. Amounts are integer micro-USD. IDs and times come from the IdGenerator and
// Clock ports, never from column defaults.

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
};

/**
 * One account of the double-entry ledger: an account's available or held money, or a platform
 * account. IDs are readable: `<account ID>:available`, and `platform:` before a platform account's.
 */
export const ledgerAccounts = pgTable('ledger_accounts', {
  id: text('id').primaryKey(),
  // The account it belongs to, or none for a platform account
  accountId: text('account_id').references(() => accounts.id),
  type: text('type').notNull(),
  ...timestamps,
}, table => [
  index('ledger_accounts_account_idx').on(table.accountId),
]);

/**
 * Each ledger account's balance, updated in the transaction that posts its entries. Only an account
 * that is a source of money may go below zero.
 */
export const balances = pgTable('balances', {
  ledgerAccountId: text('ledger_account_id').primaryKey().references(() => ledgerAccounts.id),
  balance: bigint('balance', { mode: 'bigint' }).notNull(),
  mayGoNegative: boolean('may_go_negative').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  check('balances_not_negative_check', sql`${table.mayGoNegative} or ${table.balance} >= 0`),
]);

/**
 * One movement of money, keyed by its operation and reference (a payment ID, or an operator's
 * reference), so a retry never moves money twice.
 */
export const ledgerTransactions = pgTable('ledger_transactions', {
  id: text('id').primaryKey(),
  // credit, hold, release, …
  operation: text('operation').notNull(),
  reference: text('reference').notNull(),
  requestId: text('request_id'),
  ...timestamps,
}, table => [
  uniqueIndex('ledger_transactions_operation_reference_idx').on(table.operation, table.reference),
]);

/** The entries of a transaction. They sum to zero. An amount adds to its account's balance. */
export const ledgerEntries = pgTable('ledger_entries', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id').notNull().references(() => ledgerTransactions.id),
  ledgerAccountId: text('ledger_account_id').notNull().references(() => ledgerAccounts.id),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
}, table => [
  index('ledger_entries_transaction_idx').on(table.transactionId),
  index('ledger_entries_account_idx').on(table.ledgerAccountId),
  check('ledger_entries_amount_check', sql`${table.amount} <> 0`),
]);

/** Every paid call: a routed call to a target host and path, on any rail. */
export const payments = pgTable('payments', {
  id: text('id').primaryKey(),
  requestId: text('request_id'),
  rail: text('rail').$type<RailName>().notNull(),
  buyerAccountId: text('buyer_account_id').references(() => accounts.id),
  keyId: text('key_id').references(() => apiKeys.id),
  targetHost: text('target_host').notNull(),
  targetPath: text('target_path').notNull(),
  network: text('network'),
  asset: text('asset'),
  atomicAmount: atomicAmount('atomic_amount'),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  fee: bigint('fee', { mode: 'bigint' }),
  decision: text('decision').$type<BillingDecision>(),
  upstreamStatus: integer('upstream_status'),
  upstreamLatencyMs: integer('upstream_latency_ms'),
  status: text('status').$type<PaymentStatus>().notNull(),
  transactionHash: text('transaction_hash'),
  receipt: text('receipt'),
  // The settle request a rail repeats until the settlement is final. Cleared once it is.
  settlementRequest: jsonb('settlement_request').$type<JsonObject>(),
  needsReview: boolean('needs_review').notNull(),
  ...timestamps,
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  index('payments_buyer_idx').on(table.buyerAccountId, table.createdAt, table.id),
  index('payments_status_idx').on(table.status, table.createdAt),
  // The public reads of finished calls, newest first: all of them, by how the buyer paid (the rail and
  // a chain payment's network, such as `x402 eip155:8453`, or `credits`), by the exact host, and by the
  // exact path. A call in flight is never read, so none is in them.
  // A btree row holds at most 2,704 bytes, and a payment enters these indexes as it finishes, so a key
  // too long would stop it finishing. Each key is bounded: our own IDs, a rail of three, a network of
  // the platform config, and the buyer's host and path as their md5, since nothing bounds a path.
  index('payments_calls_idx').on(table.createdAt, table.id).where(statusIn(sql.raw('status'), finishedCallStatuses)),
  index('payments_calls_paid_with_idx').on(sql`(${table.rail} || coalesce(' ' || ${table.network}, ''))`, table.createdAt, table.id)
    .where(statusIn(sql.raw('status'), finishedCallStatuses)),
  index('payments_calls_host_idx').on(sql`md5(${table.targetHost})`, table.createdAt, table.id).where(statusIn(sql.raw('status'), finishedCallStatuses)),
  index('payments_calls_path_idx').on(sql`md5(${table.targetPath})`, table.createdAt, table.id).where(statusIn(sql.raw('status'), finishedCallStatuses)),
  // Calls as they become final, for the live stream: a final payment's last update never moves again
  index('payments_calls_final_idx').on(table.updatedAt, table.id).where(statusIn(sql.raw('status'), finalCallStatuses)),
  check('payments_rail_check', sql`${table.rail} in ('credits', 'x402', 'mpp')`),
  check('payments_status_check', sql`${table.status} in ('held', 'verified', 'captured', 'settling', 'settled', 'released', 'cancelled', 'failed')`),
  check('payments_decision_check', sql`${table.decision} in ('billable', 'not_billable')`),
  check('payments_amounts_check', sql`${table.amount} >= 0 and ${table.fee} >= 0 and ${table.fee} <= ${table.amount}`),
  // Credits hold, then capture or release; the on-chain rails never do
  check('payments_rail_status_check', sql`(${table.rail} = 'credits') = (${table.status} in ('held', 'captured', 'released'))`),
  // A credits payment is paid from a buyer's balance, with one of the buyer's payment keys
  check('payments_credits_buyer_check', sql`${table.rail} <> 'credits' or (${table.buyerAccountId} is not null and ${table.keyId} is not null)`),
]);

/** A key's spend per UTC day. A hold adds, a release gives back. */
export const keyDailySpend = pgTable('key_daily_spend', {
  keyId: text('key_id').notNull().references(() => apiKeys.id),
  day: date('day', { mode: 'string' }).notNull(),
  spent: bigint('spent', { mode: 'bigint' }).notNull(),
}, table => [
  primaryKey({ name: 'key_daily_spend_pkey', columns: [table.keyId, table.day] }),
  check('key_daily_spend_spent_check', sql`${table.spent} >= 0`),
]);

/** A key's spend over its life, for its allowance. A hold adds, a release gives back. */
export const keyTotalSpend = pgTable('key_total_spend', {
  keyId: text('key_id').primaryKey().references(() => apiKeys.id),
  spent: bigint('spent', { mode: 'bigint' }).notNull(),
}, table => [
  check('key_total_spend_spent_check', sql`${table.spent} >= 0`),
]);
