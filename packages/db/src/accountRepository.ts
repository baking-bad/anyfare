import { eq } from 'drizzle-orm';

import type { Account, AccountRepository } from '@anyfare/core';

import type { DatabaseExecutor } from './postgres.js';
import { accounts } from './schema/accounts.js';

export interface AccountRepositoryOptions {
  // The database, or a transaction to join
  readonly db: DatabaseExecutor;
}

const toAccount = (row: typeof accounts.$inferSelect): Account => ({
  id: row.id,
  createdAt: row.createdAt,
});

/** The `accounts` table. */
export const createAccountRepository = ({ db }: AccountRepositoryOptions): AccountRepository => ({
  create: async ({ id, createdAt }) => {
    const [row] = await db.insert(accounts).values({ id, createdAt }).returning();

    return toAccount(row!);
  },
  findById: async id => {
    const [row] = await db.select().from(accounts).where(eq(accounts.id, id));

    return row ? toAccount(row) : undefined;
  },
});
