import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { topupStatuses, type JsonObject, type TopupStatus } from '@anyfare/core';

import { accounts } from './accounts.js';
import { atomicAmount } from './columns.js';
import { ledgerTransactions } from './ledger.js';

// Top-ups: a token sent on some chain to a deposit address that 1Click made, swapped to the platform's
// asset and added to an account's balance. IDs and times come from the IdGenerator and Clock ports,
// never from column defaults.

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

const statusList = sql.raw(topupStatuses.map(status => `'${status}'`).join(', '));
// Before a deposit address: still asking 1Click, or no address came of it
const statusesWithoutAddress = sql.raw(['quoting', 'quote_failed', 'quote_unknown'].map(status => `'${status}'`).join(', '));

/** One row per top-up, from the quote that made its deposit address to the Credits it added. */
export const topups = pgTable('topups', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  requestId: text('request_id'),
  status: text('status').$type<TopupStatus>().notNull(),
  // What the client asked for: our network's name and 1Click's, the token, and the amount in its atomic units
  network: text('network').notNull(),
  blockchain: text('blockchain').notNull(),
  tokenSymbol: text('token_symbol').notNull(),
  // 1Click's asset ID
  originAsset: text('origin_asset').notNull(),
  tokenDecimals: integer('token_decimals').notNull(),
  amount: atomicAmount('amount').notNull(),
  // Where the swap delivers: the registry asset's name, the NEAR account, and the refund account inside intents.near
  destinationAsset: text('destination_asset').notNull(),
  recipient: text('recipient').notNull(),
  refundTo: text('refund_to').notNull(),
  // The deadline we asked 1Click for
  payBy: time('pay_by').notNull(),
  // What we sent for the real quote, and its whole answer with 1Click's signature, kept for a dispute
  quoteRequest: jsonb('quote_request').$type<JsonObject>().notNull(),
  quoteResponse: jsonb('quote_response').$type<JsonObject>(),
  correlationId: text('correlation_id'),
  // From the real quote. After `address_expires_at` the address takes no transfers.
  depositAddress: text('deposit_address'),
  depositMemo: text('deposit_memo'),
  addressExpiresAt: time('address_expires_at'),
  // The quote's amountIn and minAmountIn, in the token's atomic units
  sendAmount: atomicAmount('send_amount'),
  sendAtLeast: atomicAmount('send_at_least'),
  // The quote's amountOut, in micro-USD
  estimatedCredits: bigint('estimated_credits', { mode: 'bigint' }),
  // 1Click's message when it refused the quote, or our reason when the quote didn't answer
  quoteError: text('quote_error'),
  // What the status job learns from 1Click
  oneClickStatus: text('oneclick_status'),
  lastStatus: jsonb('last_status').$type<JsonObject>(),
  depositedAmount: atomicAmount('deposited_amount'),
  // In micro-USD, with the ledger transaction that added it
  creditedAmount: bigint('credited_amount', { mode: 'bigint' }),
  ledgerTransactionId: text('ledger_transaction_id').references(() => ledgerTransactions.id),
  deliveryTxHash: text('delivery_tx_hash'),
  refundedAmount: atomicAmount('refunded_amount'),
  refundReason: text('refund_reason'),
  refundTxHash: text('refund_tx_hash'),
  // The deposit's transactions on the origin chain: an operator reads the sender from them for a refund
  originTxHashes: jsonb('origin_tx_hashes').$type<string[]>().notNull(),
  needsReview: boolean('needs_review').notNull(),
  reviewReason: text('review_reason'),
  // Set while the status job polls the top-up; a final state clears it
  nextPollAt: time('next_poll_at'),
  lastPolledAt: time('last_polled_at'),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
}, table => [
  index('topups_account_idx').on(table.accountId, table.createdAt),
  // The top-ups the status job polls, soonest first: few, while most rows are final
  index('topups_next_poll_idx').on(table.nextPollAt).where(sql`next_poll_at is not null`),
  // Top-ups still asking for their address, oldest first: a few seconds each, unless a write after the quote failed
  index('topups_quoting_idx').on(table.createdAt, table.id).where(sql`status = 'quoting'`),
  // 1Click makes a new address for each quote, so an address names one top-up
  uniqueIndex('topups_deposit_address_idx').on(table.depositAddress).where(sql`deposit_address is not null`),
  check('topups_status_check', sql`${table.status} in (${statusList})`),
  // Every status from waiting on has its deposit address; the ones before it have none
  check('topups_deposit_address_check', sql`(${table.status} in (${statusesWithoutAddress})) = (${table.depositAddress} is null)`),
  check('topups_amount_check', sql`${table.amount} > 0 and ${table.tokenDecimals} >= 0 and ${table.tokenDecimals} <= 36`),
]);
