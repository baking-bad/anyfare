import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, index, integer, pgTable, primaryKey, text, timestamp,
} from 'drizzle-orm/pg-core';

import { atomicAmount } from './columns.js';
import { payments } from './ledger.js';

// Routed calls: the endpoints and blocked hosts, each call's target leg, and the Signer's
// signatures. Times come from the Clock port, never from column defaults.

/** `paid`: a billable call reached the endpoint. `checked`: a payable check listed it, and no billable call has yet. */
export type RoutedEndpointStatus = 'paid' | 'checked';
/** The methods a check probes with, as an endpoint keeps the last one. */
export type CheckedMethod = 'GET' | 'POST';

// A paid endpoint the proxy routed to, or a payable link a check listed: the host and path, and its own
// fee, if any. The key is the raw host and path, so both are bounded in bytes: a host name of at most 259
// and a path of at most 2,048, of printable ASCII, which keeps the key's index row under 2,400 bytes.
export const routedEndpoints = pgTable('routed_endpoints', {
  host: text('host').notNull(),
  path: text('path').notNull(),
  // Null: routingFeeBps from platform config
  feeBps: integer('fee_bps'),
  // The last quote in micro-USD (the target's price and the fee), for the catalog
  lastPrice: bigint('last_price', { mode: 'bigint' }),
  // The first routed call, or the check that listed it
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  // Every row from before checks listed endpoints came from a paid call: the default marks them paid.
  // Every insert names its status.
  status: text('status').$type<RoutedEndpointStatus>().notNull().default('paid'),
  // When a payable check last confirmed it, and the method that check probed with. Null: never checked.
  checkedAt: timestamp('checked_at', { withTimezone: true, precision: 3 }),
  checkMethod: text('check_method').$type<CheckedMethod>(),
}, table => [
  primaryKey({ name: 'routed_endpoints_pkey', columns: [table.host, table.path] }),
  // A host's endpoints listed only by a check: at most 20
  index('routed_endpoints_checked_idx').on(table.host).where(sql`status = 'checked'`),
  // When a host first joined the list: its earliest paid endpoint, one entry of this index, or its earliest of
  // the 20 checked ones. Partial, so no lookup of an endpoint by its key, which names no status, ever takes it.
  index('routed_endpoints_listed_idx').on(table.host, table.createdAt).where(sql`status = 'paid'`),
  // Every endpoint listed only by a check, the one checked longest ago first: their count in all, at most
  // 25,000, and the one that leaves for a new one
  index('routed_endpoints_checked_order_idx').on(table.checkedAt).where(sql`status = 'checked'`),
  // The few endpoints an operator set a fee on: a host with one is never pushed out
  index('routed_endpoints_fee_idx').on(table.host).where(sql`fee_bps is not null`),
  // The catalog's order, oldest first
  index('routed_endpoints_created_idx').on(table.createdAt),
  check('routed_endpoints_fee_check', sql`${table.feeBps} is null or (${table.feeBps} >= 0 and ${table.feeBps} <= 10000)`),
  check('routed_endpoints_key_check', sql`octet_length(${table.host}) <= 259 and octet_length(${table.path}) <= 2048`),
  check('routed_endpoints_status_check', sql`${table.status} in ('paid', 'checked')`),
  check('routed_endpoints_method_check', sql`${table.checkMethod} is null or ${table.checkMethod} in ('GET', 'POST')`),
]);

/**
 * The hosts a payable check reached: when it first joined the list and when one of its endpoints was last
 * confirmed, its parent domain, and its endpoints listed only by a check, so a public read of them is one
 * row per host. Those the count doesn't store are the checked pool, listed because a check listed them: at
 * most 1,000 in all and 20 per parent domain, the one checked longest ago leaving for a new one. Written only
 * under the host's registration lock.
 */
export const checkedHosts = pgTable('checked_hosts', {
  // A validated host name, with its port when it has one
  host: text('host').primaryKey(),
  // Its last two labels, without the port: the hosts of one parent domain share their cap
  parent: text('parent').notNull(),
  // When its first endpoint was listed, paid or checked
  listedAt: timestamp('listed_at', { withTimezone: true, precision: 3 }).notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true, precision: 3 }).notNull(),
  // When a paid call first reached one of its endpoints, as far as this table knows. Null: none did.
  paidAt: timestamp('paid_at', { withTimezone: true, precision: 3 }),
  // Its endpoints listed only by a check, at most 20, and the lowest last quote among them in micro-USD
  checkedEndpoints: integer('checked_endpoints').notNull(),
  priceFrom: bigint('price_from', { mode: 'bigint' }),
}, table => [
  // The one checked longest ago first, for the pool's cap
  index('checked_hosts_checked_idx').on(table.checkedAt, table.host),
  // Those of one parent domain, the one checked longest ago first, for its cap
  index('checked_hosts_parent_idx').on(table.parent, table.checkedAt),
  check('checked_hosts_host_check', sql`octet_length(${table.host}) <= 259`),
  check('checked_hosts_endpoints_check', sql`${table.checkedEndpoints} >= 0`),
]);

// Hosts the proxy refuses to route to
export const hostBlocklist = pgTable('host_blocklist', {
  host: text('host').primaryKey(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
});

export type TargetPaymentStatus = 'signed' | 'settled' | 'failed' | 'unknown';

// The target leg of a routed call: what the platform paid the target for one buyer payment
export const targetPayments = pgTable('target_payments', {
  paymentId: text('payment_id').primaryKey().references(() => payments.id),
  protocol: text('protocol').$type<'x402' | 'mpp'>().notNull(),
  network: text('network').notNull(),
  // The registry's asset name
  asset: text('asset').notNull(),
  // The target's price in micro-USD, and in the asset's atomic units
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  atomicAmount: atomicAmount('atomic_amount').notNull(),
  payTo: text('pay_to').notNull(),
  // The Signer's record of the signature
  signatureId: text('signature_id').notNull(),
  status: text('status').$type<TargetPaymentStatus>().notNull(),
  // The target's settlement answer, such as its PAYMENT-RESPONSE, and the transaction it names
  receipt: text('receipt'),
  transactionHash: text('transaction_hash'),
  // The target kept our payment while the buyer wasn't charged, and the ledger booked it as a routing loss
  lossBooked: boolean('loss_booked').notNull().default(false),
  // The ledger charged the buyer for the call: captured or settled. Such a leg is never a routing loss.
  buyerCharged: boolean('buyer_charged').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  index('target_payments_status_idx').on(table.status, table.createdAt),
  // The legs that may still be routing losses, oldest first: few, while every paid call leaves a settled leg
  index('target_payments_unbooked_idx').on(table.createdAt, table.paymentId).where(sql`status = 'settled' and not loss_booked and not buyer_charged`),
  check('target_payments_amount_check', sql`${table.amount} > 0 and ${table.atomicAmount} > 0`),
  check('target_payments_status_check', sql`${table.status} in ('signed', 'settled', 'failed', 'unknown')`),
  check('target_payments_protocol_check', sql`${table.protocol} in ('x402', 'mpp')`),
]);

// Owned by the Signer: every signature it made
export const signatures = pgTable('signatures', {
  id: text('id').primaryKey(),
  requestId: text('request_id'),
  quoteId: text('quote_id').notNull(),
  protocol: text('protocol').$type<'x402' | 'mpp'>().notNull(),
  network: text('network').notNull(),
  asset: text('asset').notNull(),
  // The asset's atomic units, and micro-USD
  atomicAmount: atomicAmount('atomic_amount').notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  payTo: text('pay_to').notNull(),
  resource: text('resource').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
}, table => [
  index('signatures_network_created_idx').on(table.network, table.createdAt),
  check('signatures_protocol_check', sql`${table.protocol} in ('x402', 'mpp')`),
]);
