import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

import type { PaymentStatus } from '@anyfare/core';

// The payment statuses that make a call public. Not exported from the schema index: they hold no tables.
// The partial indexes on payments and the queries that read them use the same lists, as literals, so
// the planner can match a query to its index.

// The buyer was charged
export const paidCallStatuses = ['captured', 'settled', 'settling'] as const satisfies readonly PaymentStatus[];
// The buyer wasn't charged
export const freeCallStatuses = ['released', 'cancelled', 'failed'] as const satisfies readonly PaymentStatus[];
// A finished call: paid or free. A payment still `held` or `verified` is in flight, and never public.
export const finishedCallStatuses = [...paidCallStatuses, ...freeCallStatuses] as const;
// Statuses that never change again, so a payment's last update in one is when it became final
export const finalCallStatuses = ['captured', 'settled', 'released', 'cancelled', 'failed'] as const satisfies readonly PaymentStatus[];

/** `<column> in ('a', 'b')`, with the statuses as literals. Only for the constant lists above. */
export const statusIn = (column: SQLWrapper, statuses: readonly PaymentStatus[]): SQL =>
  sql`${column} in (${sql.raw(statuses.map(status => `'${status}'`).join(', '))})`;
