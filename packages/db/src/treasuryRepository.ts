import { desc, eq } from 'drizzle-orm';

import type { DatabaseExecutor } from './postgres.js';
import { reconciliationRuns, treasuryFundings, treasuryTransfers } from './schema/treasury.js';

export interface TreasuryRepositoryOptions {
  // The database, or a transaction to join, so a transfer or funding commits with the ledger transaction that books it
  readonly db: DatabaseExecutor;
}

export type TreasuryTransferRecord = typeof treasuryTransfers.$inferSelect;
export type TreasuryFundingRecord = typeof treasuryFundings.$inferSelect;
export type ReconciliationRunRecord = typeof reconciliationRuns.$inferSelect;

/** The `treasury_transfers`, `treasury_fundings` and `reconciliation_runs` tables. */
export interface TreasuryRepository {
  findTransfer(reference: string): Promise<TreasuryTransferRecord | undefined>;
  /** Throws on a reference already recorded: references are idempotency keys, which the ledger checks first. */
  recordTransfer(transfer: TreasuryTransferRecord): Promise<void>;
  findFunding(reference: string): Promise<TreasuryFundingRecord | undefined>;
  /** Throws on a reference already recorded: references are idempotency keys, which the ledger checks first. */
  recordFunding(funding: TreasuryFundingRecord): Promise<void>;
  recordReconciliationRun(run: ReconciliationRunRecord): Promise<void>;
  /** The newest reconciliation by `ranAt`, or undefined before the first. */
  latestReconciliationRun(): Promise<ReconciliationRunRecord | undefined>;
}

export const createTreasuryRepository = ({ db }: TreasuryRepositoryOptions): TreasuryRepository => ({
  findTransfer: async reference => {
    const [row] = await db.select().from(treasuryTransfers).where(eq(treasuryTransfers.reference, reference));

    return row;
  },

  recordTransfer: async transfer => {
    await db.insert(treasuryTransfers).values(transfer);
  },

  findFunding: async reference => {
    const [row] = await db.select().from(treasuryFundings).where(eq(treasuryFundings.reference, reference));

    return row;
  },

  recordFunding: async funding => {
    await db.insert(treasuryFundings).values(funding);
  },

  recordReconciliationRun: async run => {
    await db.insert(reconciliationRuns).values(run);
  },

  latestReconciliationRun: async () => {
    // Two runs at the same time: the one with the greater ID, so the answer doesn't change between reads
    const [row] = await db.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.ranAt), desc(reconciliationRuns.id)).limit(1);

    return row;
  },
});
