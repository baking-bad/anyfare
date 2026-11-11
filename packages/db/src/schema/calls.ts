import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { payments } from './ledger.js';

/**
 * What a paid call's payment row doesn't keep, for the public reads of calls: written once by the proxy
 * when the call starts, best effort. A call may have none, such as one from before this table, and
 * every read works without it. Never an account ID or a key ID.
 */
export const callDetails = pgTable('call_details', {
  paymentId: text('payment_id').primaryKey().references(() => payments.id),
  // The routed request's HTTP method
  method: text('method').notNull(),
  // The payer's address, for a payment on a chain only. Null for Credits.
  payer: text('payer'),
  // When the routed request arrived, from the proxy's clock
  arrivedAt: timestamp('arrived_at', { withTimezone: true, precision: 3 }).notNull(),
});
