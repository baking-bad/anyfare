import { sql } from 'drizzle-orm';

import { withTransaction, type Database } from '@anyfare/db';

import { seededHosts, seedAccountPrefix, seedKeyPrefix, seedLedgerPrefix, seedRequestPrefix } from './seedData.js';

const requestLike = `${seedRequestPrefix}%`;
const ledgerLike = `${seedLedgerPrefix}%`;
const accountLike = `${seedAccountPrefix}%`;
const keyLike = `${seedKeyPrefix}%`;

// The ledger transactions the seed booked: marked by their request, and by the ID the seed's generator made
const seededTransactions = sql`(select id from ledger_transactions where request_id like ${requestLike} or id like ${ledgerLike})`;

/**
 * Deletes every row the seed wrote and puts the platform's shared ledger balances back as they were,
 * in one transaction. Rows made any other way, such as by the local stack, stay.
 */
export const wipeSeededRows = async (db: Database): Promise<void> => {
  await withTransaction(db, async tx => {
    const seededPayments = sql`(select id from payments where request_id like ${requestLike})`;
    await tx.execute(sql`delete from call_details where payment_id in ${seededPayments}`);
    await tx.execute(sql`delete from target_payments where payment_id in ${seededPayments}`);
    await tx.execute(sql`delete from signatures where request_id like ${requestLike}`);
    // Top-ups point at their ledger transactions
    await tx.execute(sql`delete from topups where request_id like ${requestLike} or id like ${`top_${seedLedgerPrefix}%`}`);
    // What the seeded entries added to each balance comes off it again
    await tx.execute(sql`
      update balances set balance = balances.balance - moved.total
      from (select ledger_account_id, sum(amount) as total from ledger_entries where transaction_id in ${seededTransactions} group by ledger_account_id) as moved
      where balances.ledger_account_id = moved.ledger_account_id`);
    await tx.execute(sql`delete from ledger_entries where transaction_id in ${seededTransactions}`);
    await tx.execute(sql`delete from ledger_transactions where request_id like ${requestLike} or id like ${ledgerLike}`);
    await tx.execute(sql`delete from payments where request_id like ${requestLike}`);
    await tx.execute(sql`delete from key_daily_spend where key_id like ${keyLike}`);
    await tx.execute(sql`delete from key_total_spend where key_id like ${keyLike}`);
    await tx.execute(sql`delete from balances where ledger_account_id in (select id from ledger_accounts where account_id like ${accountLike})`);
    await tx.execute(sql`delete from ledger_accounts where account_id like ${accountLike}`);
    await tx.execute(sql`delete from api_keys where account_id like ${accountLike}`);
    await tx.execute(sql`delete from accounts where id like ${accountLike}`);
    for (const host of seededHosts)
      await tx.execute(sql`delete from routed_endpoints where host = ${host}`);
  });
};
