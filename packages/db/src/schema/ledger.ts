import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import type { BillingDecision, JsonObject, PaymentStatus, RailName } from '@anyfare/core';

import { accounts, apiKeys } from './accounts.js';

// Owned by the ledger. Amounts are integer micro-USD. IDs and times come from the IdGenerator and
// Clock ports, never from column defaults.

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
};

// An on-chain amount in an asset's atomic units, which can pass a bigint for 18-decimal assets
const atomicAmount = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'numeric(78, 0)',
  toDriver: value => value.toString(),
  fromDriver: value => BigInt(value),
});

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
  check('payments_rail_check', sql`${table.rail} in ('credits', 'x402', 'mpp')`),
  check('payments_status_check', sql`${table.status} in ('held', 'verified', 'captured', 'settling', 'settled', 'released', 'cancelled', 'failed')`),
  check('payments_decision_check', sql`${table.decision} in ('billable', 'not_billable')`),
  check('payments_amounts_check', sql`${table.amount} >= 0 and ${table.fee} >= 0 and ${table.fee} <= ${table.amount}`),
  // Credits hold, then capture or release; the on-chain rails never do
  check('payments_rail_status_check', sql`(${table.rail} = 'credits') = (${table.status} in ('held', 'captured', 'released'))`),
  // A credits payment is paid from a buyer's balance, with one of the buyer's payment keys
  check('payments_credits_buyer_check', sql`${table.rail} <> 'credits' or (${table.buyerAccountId} is not null and ${table.keyId} is not null)`),
]);
