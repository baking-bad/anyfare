import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, integer, json, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { ledgerTransactions } from './ledger.js';

// The treasury: the rebalancings an operator recorded, and the daily reconciliations. Times come
// from the Clock port, never from column defaults.

// A rebalancing between two assets that an operator did and recorded, with the ledger transaction that booked it
export const treasuryTransfers = pgTable('treasury_transfers', {
  reference: text('reference').primaryKey(),
  fromAsset: text('from_asset').notNull(),
  fromAmount: bigint('from_amount', { mode: 'bigint' }).notNull(),
  toAsset: text('to_asset').notNull(),
  toAmount: bigint('to_amount', { mode: 'bigint' }).notNull(),
  // The operator's transaction references: hashes or explorer links, as given
  transactions: json('transactions').$type<string[]>().notNull(),
  recordedBy: text('recorded_by').notNull(),
  ledgerTransactionId: text('ledger_transaction_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  // Named here: the generated name would pass Postgres's 63-character limit
  foreignKey({ name: 'treasury_transfers_ledger_transaction_fk', columns: [table.ledgerTransactionId], foreignColumns: [ledgerTransactions.id] }),
  // One ledger transaction books one transfer
  uniqueIndex('treasury_transfers_ledger_transaction_idx').on(table.ledgerTransactionId),
  // What arrives is at most what left: the platform absorbs conversion costs
  check('treasury_transfers_amounts_check', sql`${table.fromAmount} > 0 and ${table.toAmount} > 0 and ${table.toAmount} <= ${table.fromAmount}`),
]);

// Each daily reconciliation, with what it compared
export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: text('id').primaryKey(),
  ranAt: timestamp('ran_at', { withTimezone: true, precision: 3 }).notNull(),
  // Per asset: the ledger's view, the chain's, and the drift, in USD as decimal strings
  results: json('results').$type<Record<string, { ledger: string; chain: string; drift: string; alert: boolean }>>().notNull(),
  alerts: integer('alerts').notNull(),
}, table => [
  index('reconciliation_runs_ran_at_idx').on(table.ranAt),
]);
