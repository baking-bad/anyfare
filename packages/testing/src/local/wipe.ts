import { sql } from 'drizzle-orm';

import { withTransaction, type Database } from '@anyfare/db';

import { allSeededHosts, seedAccountPrefix, seedKeyPrefix, seedLedgerPrefix, seedRequestPrefix } from './seedData.js';

const requestLike = `${seedRequestPrefix}%`;
const ledgerLike = `${seedLedgerPrefix}%`;
const accountLike = `${seedAccountPrefix}%`;
const keyLike = `${seedKeyPrefix}%`;

// The ledger transactions the seed booked: marked by their request, and by the ID the seed's generator made
const seededTransactions = sql`(select id from ledger_transactions where request_id like ${requestLike} or id like ${ledgerLike})`;

// Who paid, as the count of the public numbers tells buyers apart: its md5 is what the kept buyers hold
const buyerOf = sql`(case when payments.rail = 'credits' then 'account:' || md5(payments.buyer_account_id)
  when call_details.payer is null then 'unknown:' || coalesce(payments.network, payments.rail)
  when call_details.payer ~ '^0x[0-9a-fA-F]{40}$' then 'payer:' || lower(call_details.payer)
  else 'payer:' || call_details.payer end)`;

/**
 * Deletes every row the seed wrote, the kept buyers of its calls and its checked and paid hosts, and puts the platform's shared ledger balances back as they were,
 * in one transaction. Rows made any other way, such as by the local stack, stay.
 */
export const wipeSeededRows = async (db: Database): Promise<void> => {
  await withTransaction(db, async tx => {
    // Today's kept buyers of the seeded calls: derived rows, found by the seeded payments that made them, before
    // those go. A count that follows puts back any buyer a call of another kind still makes.
    await tx.execute(sql`delete from stats_buyers where buyer_hash in (
      select md5(${buyerOf}) from payments left join call_details on call_details.payment_id = payments.id where payments.request_id like ${requestLike})`);
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
    for (const host of allSeededHosts) {
      await tx.execute(sql`delete from routed_endpoints where host = ${host}`);
      await tx.execute(sql`delete from checked_hosts where host = ${host}`);
      await tx.execute(sql`delete from paid_hosts where host = ${host}`);
    }
  });
};
