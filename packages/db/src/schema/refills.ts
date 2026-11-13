import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import type { JsonObject } from '@anyfare/core';

import { atomicAmount } from './columns.js';
import { ledgerTransactions } from './ledger.js';

// Refills: the workers ask the Signer to refill its hot wallet on Base or Solana from its NEAR hot
// wallet through 1Click, follow 1Click's status for the deposit address, and book what arrived. IDs
// and times come from the IdGenerator and Clock ports, never from column defaults.

/**
 * A refill's statuses. `requested`: the row is made, and the Signer's answer hasn't arrived. `sent`: the
 * Signer sent the source asset. `unknown`: the Signer's transaction may have landed. `not_sent`: the
 * Signer refused or was busy, and nothing moved. `review`: money may have moved, and an operator decides.
 */
export const refillStatuses = ['requested', 'sent', 'unknown', 'succeeded', 'refunded', 'failed', 'not_sent', 'review'] as const;
export type RefillStatus = typeof refillStatuses[number];

/**
 * The statuses of a refill in flight: at most one per asset. A `review` one blocks new refills of its
 * asset until an operator changes its status by hand, since money may have moved.
 */
export const inFlightRefillStatuses = ['requested', 'sent', 'unknown', 'review'] as const satisfies readonly RefillStatus[];

const listOf = (values: readonly string[]) => sql.raw(values.map(value => `'${value}'`).join(', '));

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

/** One row per refill, from the workers' decision to the ledger transaction that booked it. */
export const refills = pgTable('refills', {
  // ref_<uuid>, the refill ID the Signer is asked with
  id: text('id').primaryKey(),
  // The target asset's registry name, and the NEAR asset that paid
  asset: text('asset').notNull(),
  sourceAsset: text('source_asset').notNull(),
  // What the target wallet was to receive, in micro-USD
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  status: text('status').$type<RefillStatus>().notNull(),
  // Why a refill wasn't sent, failed or needs review
  reason: text('reason'),
  // From the Signer's answer: 1Click's deposit address, the quote's amounts in each asset's atomic units, and its deadline
  depositAddress: text('deposit_address'),
  amountIn: atomicAmount('amount_in'),
  amountOut: atomicAmount('amount_out'),
  // What left NEAR and what arrived, in micro-USD, once 1Click says SUCCESS
  amountInUsd: bigint('amount_in_usd', { mode: 'bigint' }),
  amountOutUsd: bigint('amount_out_usd', { mode: 'bigint' }),
  quoteDeadline: time('quote_deadline'),
  correlationId: text('correlation_id'),
  nearTransactionHash: text('near_transaction_hash'),
  // The delivery's transactions on the target's chain
  deliveryTransactionHashes: text('delivery_transaction_hashes').array().notNull(),
  // 1Click's quote as the Signer got it, and 1Click's last status answer, each as it came
  quote: jsonb('quote').$type<JsonObject>(),
  lastStatus: jsonb('last_status').$type<JsonObject>(),
  // What 1Click returned to the NEAR hot wallet, in the source asset's atomic units, its fee, and why
  refundedAmount: atomicAmount('refunded_amount'),
  refundFee: atomicAmount('refund_fee'),
  refundReason: text('refund_reason'),
  // Set while the workers follow 1Click's status; a final status clears it
  nextPollAt: time('next_poll_at'),
  polls: integer('polls').notNull(),
  ledgerTransactionId: text('ledger_transaction_id'),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
  sentAt: time('sent_at'),
  finishedAt: time('finished_at'),
}, table => [
  // Named here, as treasury_transfers names its own
  foreignKey({ name: 'refills_ledger_transaction_fk', columns: [table.ledgerTransactionId], foreignColumns: [ledgerTransactions.id] }),
  // One refill in flight per asset: a second could fund the wallet twice while money may have moved
  uniqueIndex('refills_in_flight_idx').on(table.asset).where(sql`status in (${listOf(inFlightRefillStatuses)})`),
  // 1Click makes a new address for each quote, so an address names one refill
  uniqueIndex('refills_deposit_address_idx').on(table.depositAddress).where(sql`deposit_address is not null`),
  // The refills the workers poll, soonest first: few, while most rows are final
  index('refills_next_poll_idx').on(table.nextPollAt).where(sql`next_poll_at is not null`),
  check('refills_status_check', sql`${table.status} in (${listOf(refillStatuses)})`),
  check('refills_amount_check', sql`${table.amount} > 0 and ${table.polls} >= 0`),
  // A sent or unknown refill has its deposit address: the workers follow 1Click's status for it
  check('refills_deposit_address_check', sql`${table.status} not in ('sent', 'unknown', 'succeeded', 'refunded') or ${table.depositAddress} is not null`),
  // A succeeded refill was booked
  check('refills_booked_check', sql`${table.status} <> 'succeeded' or ${table.ledgerTransactionId} is not null`),
]);
