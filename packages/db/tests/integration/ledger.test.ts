import { fixtureDay, fixtureTime } from '@anyfare/testing';

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseUsd, Secret } from '@anyfare/common';
import {
  CreditReferenceConflictError, hashApiKey, HoldReferenceConflictError, InvalidPaymentStatusChangeError, PaymentFinalizedError,
  TreasuryTransferReferenceConflictError, utcDay, type HoldInput, type NewPayment, type PaymentStatus, type SettleInput,
} from '@anyfare/core';
import { createFakeClock, createFakeIdGenerator, createTestDatabase, type FakeClock, type TestDatabase } from '@anyfare/testing';

import {
  balances, createAccountRepository, createLedger, createPaymentKeyRepository, createPaymentRepository, createRoutingRepository, ledgerAccountIds,
  ledgerAccounts, targetPayments, type Ledger, type TargetPaymentStatus,
} from '../../src/index.js';

let database: TestDatabase;
let clock: FakeClock;
let ledger: Ledger;
let counter = 0;
const ids = createFakeIdGenerator();
// The tests run at noon UTC on the 9th; the expired holds go back to the morning of the 8th
const noon = fixtureTime(0, 9, 12, 0, 0, 0);
const today = fixtureDay(0, 9);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = createFakeClock(noon);
  ledger = createLedger({ db: database.db, clock, ids });
});

afterEach(() => {
  clock.set(noon);
});

afterAll(async () => {
  await database?.drop();
});

const usd = (value: string) => parseUsd(value);

const newAccount = async (): Promise<string> => {
  counter += 1;
  const id = `acc_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id, createdAt: clock.now() });

  return id;
};

const newKey = async (accountId: string, limits: { dailyBudget?: bigint; allowance?: bigint } = {}): Promise<string> => {
  counter += 1;
  const id = `key_${counter}`;
  await createPaymentKeyRepository({ db: database.db }).insert({
    id,
    accountId,
    keyHash: hashApiKey(Secret.from(`af_test_${id}`)),
    label: undefined,
    createdAt: clock.now(),
    allowance: limits.allowance,
    dailyBudget: limits.dailyBudget ?? usd('5'),
    maxPrice: undefined,
    expiresAt: undefined,
  });

  return id;
};

interface Buyer {
  readonly accountId: string;
  readonly keyId: string;
}

interface Limits {
  readonly dailyBudget?: string;
  readonly allowance?: string;
}

const newBuyer = async (credit: string, limits: Limits = {}): Promise<Buyer> => {
  const accountId = await newAccount();
  const keyId = await newKey(accountId, {
    ...(limits.dailyBudget === undefined ? {} : { dailyBudget: usd(limits.dailyBudget) }),
    ...(limits.allowance === undefined ? {} : { allowance: usd(limits.allowance) }),
  });
  if (credit !== '0')
    await ledger.credit({ accountId, amount: usd(credit), reference: `credit-${accountId}` });

  return { accountId, keyId };
};

// A credits payment for a routed call
const payment = (buyer: Buyer, amount: bigint, changes: Partial<NewPayment> = {}): HoldInput['payment'] => {
  counter += 1;

  return {
    id: `pay_${counter}`,
    requestId: `req-${counter}`,
    rail: 'credits',
    buyerAccountId: buyer.accountId,
    keyId: buyer.keyId,
    targetHost: 'api.example.com',
    targetPath: '/v1/quote',
    network: undefined,
    asset: undefined,
    atomicAmount: undefined,
    amount,
    ...changes,
  } as HoldInput['payment'];
};

// An x402 payment for a routed call, with no credits account
const onChainPayment = (amount: bigint, changes: Partial<NewPayment> = {}): NewPayment => {
  counter += 1;

  return {
    id: `pay_x402_${counter}`,
    requestId: `req-x402-${counter}`,
    rail: 'x402',
    buyerAccountId: undefined,
    keyId: undefined,
    targetHost: 'api.target.dev',
    targetPath: '/v1/pools',
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    atomicAmount: amount,
    amount,
    ...changes,
  };
};

const holdInput = (buyer: Buyer, amount: bigint, limits: Limits = {}): HoldInput => ({
  payment: payment(buyer, amount),
  dailyBudget: usd(limits.dailyBudget ?? '5'),
  allowance: limits.allowance === undefined ? undefined : usd(limits.allowance),
});

const hold = (buyer: Buyer, amount: bigint, limits: Limits = {}) => ledger.hold(holdInput(buyer, amount, limits));

// The entries a payment moved, by operation, smallest amount first
const movements = async (reference: string) => (await database.db.execute<{ operation: string; ledger_account_id: string; amount: string }>(sql`
  select t.operation, e.ledger_account_id, e.amount::text as amount
  from ledger_transactions t join ledger_entries e on e.transaction_id = t.id
  where t.reference = ${reference}
  order by t.created_at, t.operation, e.amount
`)).rows;

// The ledger transactions with this reference, by operation
const transactionsFor = async (reference: string) => (await database.db.execute<{ operation: string }>(sql`
  select operation from ledger_transactions where reference = ${reference} order by operation
`)).rows.map(row => row.operation);

const unbalancedTransactions = async () => (await database.db.execute(sql`
  select transaction_id, sum(amount)::text as total from ledger_entries group by transaction_id having sum(amount) <> 0
`)).rows;

const negativeBalances = async () => (await database.db.execute(sql`
  select ledger_account_id from balances where balance < 0 and not may_go_negative
`)).rows;

const thrown = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  }
  catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
};

const constraintOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
  ((await thrown(promise)) as { cause?: { constraint?: string } }).cause?.constraint;

describe('operator credits', () => {
  it('moves money from deposits clearing to the buyer\'s available balance, once per reference', async () => {
    const accountId = await newAccount();
    const clearing = ledgerAccountIds.depositsClearing;
    const clearingBefore = (await ledger.balancesOf([clearing])).get(clearing) ?? 0n;

    const first = await ledger.credit({ accountId, amount: usd('10'), reference: `ref-${accountId}`, requestId: 'req-credit' });
    const again = await ledger.credit({ accountId, amount: usd('10'), reference: `ref-${accountId}` });

    expect(first).toEqual({ transactionId: expect.any(String), createdAt: clock.now(), replayed: false });
    expect(again).toEqual({ ...first, replayed: true });
    expect(await ledger.balance(accountId)).toEqual({ available: usd('10'), held: 0n });
    expect(await ledger.balancesOf([clearing, ledgerAccountIds.available(accountId), ledgerAccountIds.held(accountId)])).toEqual(new Map([
      [clearing, clearingBefore - usd('10')],
      [ledgerAccountIds.available(accountId), usd('10')],
      [ledgerAccountIds.held(accountId), 0n],
    ]));
    expect(await unbalancedTransactions()).toEqual([]);
    expect(await negativeBalances()).toEqual([]);
  });

  it('refuses a reference reused for another amount or account', async () => {
    const [accountId, other] = [await newAccount(), await newAccount()];
    await ledger.credit({ accountId, amount: usd('1'), reference: `shared-${accountId}` });

    expect(await thrown(ledger.credit({ accountId, amount: usd('2'), reference: `shared-${accountId}` }))).toBeInstanceOf(CreditReferenceConflictError);
    expect(await thrown(ledger.credit({ accountId: other, amount: usd('1'), reference: `shared-${accountId}` }))).toBeInstanceOf(CreditReferenceConflictError);
    expect(await ledger.balance(accountId)).toEqual({ available: usd('1'), held: 0n });
    expect(await ledger.balance(other)).toEqual({ available: 0n, held: 0n });
  });

  it('moves money once when 10 credits with one reference run concurrently, and answers the other 9 as replays', async () => {
    const accountId = await newAccount();
    const reference = `concurrent-${accountId}`;

    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.credit({ accountId, amount: usd('3'), reference })));

    expect(results.filter(result => result.replayed)).toHaveLength(9);
    expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
    expect(await ledger.balance(accountId)).toEqual({ available: usd('3'), held: 0n });
    expect(await transactionsFor(reference)).toEqual(['credit']);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('refuses a credit of zero or less', async () => {
    const accountId = await newAccount();

    expect(await thrown(ledger.credit({ accountId, amount: 0n, reference: `zero-${accountId}` }))).toBeInstanceOf(RangeError);
    expect(await thrown(ledger.credit({ accountId, amount: -1n, reference: `negative-${accountId}` }))).toBeInstanceOf(RangeError);
    expect(await transactionsFor(`zero-${accountId}`)).toEqual([]);
  });

  it('rolls a credit back when its platform account can\'t be posted', async () => {
    // A database of its own: deposits clearing may not go negative here, which would stop every other credit
    const other = await createTestDatabase();
    try {
      const clearing = ledgerAccountIds.depositsClearing;
      await other.db.insert(ledgerAccounts).values({ id: clearing, accountId: null, type: clearing.split(':')[1]!, createdAt: clock.now() });
      await other.db.insert(balances).values({ ledgerAccountId: clearing, balance: 0n, mayGoNegative: false, updatedAt: clock.now() });
      await createAccountRepository({ db: other.db }).create({ id: 'acc_blocked', createdAt: clock.now() });
      const blocked = createLedger({ db: other.db, clock, ids });

      const error = await thrown(blocked.credit({ accountId: 'acc_blocked', amount: usd('1'), reference: 'blocked' }));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/could not be posted/);
      expect(await blocked.balance('acc_blocked')).toEqual({ available: 0n, held: 0n });
      expect(await blocked.balancesOf([clearing, ledgerAccountIds.available('acc_blocked')])).toEqual(new Map([[clearing, 0n]]));
      const { rows } = await other.db.execute<{ entries: number; transactions: number }>(sql`
        select (select count(*)::int from ledger_entries) as entries, (select count(*)::int from ledger_transactions) as transactions
      `);
      expect(rows).toEqual([{ entries: 0, transactions: 0 }]);
    }
    finally {
      await other.drop();
    }
  });

  it('reports no balance for an account never credited', async () => {
    const accountId = await newAccount();

    expect(await ledger.balance(accountId)).toEqual({ available: 0n, held: 0n });
    expect(await ledger.balancesOf([ledgerAccountIds.available(accountId)])).toEqual(new Map());
    expect(await ledger.balancesOf([])).toEqual(new Map());
  });

  it('keeps a balance that may not go negative at zero or above, in the database too', async () => {
    const buyer = await newBuyer('1');

    const error = await thrown(database.db.update(balances).set({ balance: -1n })
      .where(sql`${balances.ledgerAccountId} = ${ledgerAccountIds.available(buyer.accountId)}`)) as { cause?: { constraint?: string } };

    expect(error.cause?.constraint).toBe('balances_not_negative_check');
  });
});

describe('payment status changes', () => {
  const recorded = async (status: 'held' | 'verified') => {
    const payments = createPaymentRepository({ db: database.db, clock });
    const created = status === 'held'
      ? await payments.create({ ...payment(await newBuyer('0'), 10n), status })
      : await payments.create({ ...onChainPayment(10n), status });

    return { payments, payment: created };
  };

  it.each([
    ['captured', 'held'],
    ['released', 'captured'],
    ['settled', 'cancelled'],
    ['cancelled', 'settled'],
    ['failed', 'settling'],
    ['held', 'settled'],
    ['verified', 'captured'],
  ] as const)('refuses %s → %s', async (from, to) => {
    const { payments, payment: created } = await recorded(from === 'held' || from === 'captured' || from === 'released' ? 'held' : 'verified');
    const path: Record<string, readonly PaymentStatus[]> = {
      captured: ['captured'], released: ['released'], settled: ['settled'], cancelled: ['cancelled'], failed: ['failed'], held: [], verified: [],
    };
    for (const step of path[from]!)
      await payments.changeStatus({ paymentId: created.id, to: step });

    const error = await thrown(payments.changeStatus({ paymentId: created.id, to }));

    expect(error).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect((await payments.find(created.id))?.status).toBe(from);
  });

  it('refuses a change to a payment that doesn\'t exist', async () => {
    const payments = createPaymentRepository({ db: database.db, clock });

    expect(await thrown(payments.changeStatus({ paymentId: 'pay_missing', to: 'released' }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
  });

  it('moves a verified payment through settling to settled, with its hash and the review flag', async () => {
    const { payments, payment: created } = await recorded('verified');

    await payments.changeStatus({ paymentId: created.id, to: 'settling', transactionHash: '0xabc' });
    const settled = await payments.changeStatus({ paymentId: created.id, to: 'settled', fee: 1n, needsReview: true });

    expect(settled).toMatchObject({ status: 'settled', transactionHash: '0xabc', fee: 1n, needsReview: true });
  });

  it('lets one of two concurrent changes from verified to settling through, given from', async () => {
    const { payments, payment: created } = await recorded('verified');

    const results = await Promise.allSettled([
      payments.changeStatus({ paymentId: created.id, to: 'settling', from: 'verified', transactionHash: '0xfirst' }),
      payments.changeStatus({ paymentId: created.id, to: 'settling', from: 'verified', transactionHash: '0xsecond' }),
    ]);

    const won = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const lost = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
    expect(won).toHaveLength(1);
    expect(lost).toEqual([expect.any(InvalidPaymentStatusChangeError)]);
    expect((lost[0] as Error).message).toBe(`The payment ${created.id} can't go from settling to settling`);
    expect(await payments.find(created.id)).toMatchObject({ status: 'settling', transactionHash: won[0]!.transactionHash });
    // Without from, a settling payment may still record what it learns
    expect(await payments.changeStatus({ paymentId: created.id, to: 'settling', receipt: 'receipt' })).toMatchObject({ status: 'settling', receipt: 'receipt' });
    // Final, so no other test lists it as settling
    await payments.changeStatus({ paymentId: created.id, to: 'failed', from: 'settling', settlementRequest: null });
  });

  it('refuses a change from a status the payment isn\'t in', async () => {
    const { payments, payment: created } = await recorded('verified');

    expect(await thrown(payments.changeStatus({ paymentId: created.id, to: 'failed', from: 'settling' }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect((await payments.find(created.id))?.status).toBe('verified');
    expect(await thrown(payments.changeStatus({ paymentId: 'pay_missing', to: 'settling', from: 'verified' }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
  });

  it('records the billing decision while the payment is open, and refuses it after', async () => {
    const { payments, payment: created } = await recorded('held');

    const decided = await payments.recordDecision({ paymentId: created.id, decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 12 });
    await payments.changeStatus({ paymentId: created.id, to: 'captured' });

    expect(decided).toMatchObject({ decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 12, status: 'held' });
    expect(await thrown(payments.recordDecision({ paymentId: created.id, decision: 'not_billable', upstreamStatus: 500, upstreamLatencyMs: 1 })))
      .toBeInstanceOf(PaymentFinalizedError);
    expect(await thrown(payments.recordDecision({ paymentId: 'pay_missing', decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 1 })))
      .toBeInstanceOf(PaymentFinalizedError);
  });
});

describe('reads', () => {
  it('pages a buyer\'s payments newest first', async () => {
    const buyer = await newBuyer('0');
    const payments = createPaymentRepository({ db: database.db, clock });
    const paymentIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      clock.advance(1_000);
      paymentIds.push((await payments.create({ ...payment(buyer, 1n), status: 'held' })).id);
    }

    const first = await payments.listForBuyer({ buyerAccountId: buyer.accountId, limit: 2 });
    const second = await payments.listForBuyer({ buyerAccountId: buyer.accountId, limit: 2, after: first.next });
    const last = await payments.listForBuyer({ buyerAccountId: buyer.accountId, limit: 2, after: second.next });

    expect([first.payments.length, second.payments.length, last.payments.length]).toEqual([2, 2, 1]);
    expect([...first.payments, ...second.payments, ...last.payments].map(item => item.id)).toEqual([...paymentIds].reverse());
    expect(last.next).toBeUndefined();
  });
});

describe('amounts', () => {
  it('keeps every amount as integer micro-USD in a bigint column, exact past Number.MAX_SAFE_INTEGER', async () => {
    const columns = (await database.db.execute<{ column: string; data_type: string }>(sql`
      select table_name || '.' || column_name as column, data_type from information_schema.columns
      where (table_name, column_name) in (
        ('ledger_entries', 'amount'), ('balances', 'balance'), ('payments', 'amount'), ('payments', 'fee'), ('key_daily_spend', 'spent'),
        ('key_total_spend', 'spent'), ('api_keys', 'allowance'), ('api_keys', 'daily_budget'), ('api_keys', 'max_price')
      )
    `)).rows;
    const accountId = await newAccount();
    const amount = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

    await ledger.credit({ accountId, amount, reference: `large-${accountId}` });

    expect(columns).toHaveLength(9);
    expect(columns.filter(column => column.data_type !== 'bigint')).toEqual([]);
    expect(await ledger.balance(accountId)).toEqual({ available: amount, held: 0n });
  });
});

describe('payments rows', () => {
  it('stores every field of a routed call: a credits payment with its key, and an x402 payment with its network, asset and atomic amount', async () => {
    const buyer = await newBuyer('0');
    const payments = createPaymentRepository({ db: database.db, clock });
    const createdAt = clock.now();
    const credits = await payments.create({ ...payment(buyer, usd('0.002')), status: 'held' });
    // Past a bigint column: numeric(78, 0) holds any 256-bit amount
    const onChain = await payments.create({ ...onChainPayment(usd('0.01'), { atomicAmount: 10n ** 30n }), status: 'verified' });
    await payments.recordDecision({ paymentId: onChain.id, decision: 'billable', upstreamStatus: 200, upstreamLatencyMs: 42 });
    clock.advance(1_000);
    await payments.changeStatus({ paymentId: onChain.id, to: 'settling', transactionHash: '0xfeed' });
    await payments.changeStatus({ paymentId: onChain.id, to: 'settled', fee: 250n, receipt: 'receipt-1', needsReview: false });

    expect(await payments.find(credits.id)).toEqual({
      id: credits.id,
      requestId: credits.requestId,
      rail: 'credits',
      buyerAccountId: buyer.accountId,
      keyId: buyer.keyId,
      targetHost: 'api.example.com',
      targetPath: '/v1/quote',
      network: undefined,
      asset: undefined,
      atomicAmount: undefined,
      amount: usd('0.002'),
      fee: undefined,
      decision: undefined,
      upstreamStatus: undefined,
      upstreamLatencyMs: undefined,
      status: 'held',
      transactionHash: undefined,
      receipt: undefined,
      needsReview: false,
      createdAt,
      updatedAt: createdAt,
    });
    expect(await payments.find(onChain.id)).toEqual({
      id: onChain.id,
      requestId: onChain.requestId,
      rail: 'x402',
      buyerAccountId: undefined,
      keyId: undefined,
      targetHost: 'api.target.dev',
      targetPath: '/v1/pools',
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      atomicAmount: 10n ** 30n,
      amount: usd('0.01'),
      fee: 250n,
      decision: 'billable',
      upstreamStatus: 200,
      upstreamLatencyMs: 42,
      status: 'settled',
      transactionHash: '0xfeed',
      receipt: 'receipt-1',
      needsReview: false,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 1_000),
    });
  });

  it('refuses, in the database, an x402 payment that is held and a credits payment without a key', async () => {
    const payments = createPaymentRepository({ db: database.db, clock });
    const buyer = await newBuyer('0');

    expect(await constraintOf(payments.create({ ...onChainPayment(1n), status: 'held' }))).toBe('payments_rail_status_check');
    expect(await constraintOf(payments.create({ ...payment(buyer, 1n), status: 'verified' }))).toBe('payments_rail_status_check');
    expect(await constraintOf(payments.create({ ...payment(buyer, 1n, { keyId: undefined }), status: 'held' }))).toBe('payments_credits_buyer_check');
    expect(await constraintOf(payments.create({ ...payment(buyer, 1n, { buyerAccountId: undefined }), status: 'held' }))).toBe('payments_credits_buyer_check');
  });

  it('refuses a payment without its target', async () => {
    const payments = createPaymentRepository({ db: database.db, clock });
    const error = await thrown(payments.create({ ...onChainPayment(1n, { targetHost: null as never }), status: 'verified' })) as { cause?: { code?: string; column?: string } };

    expect(error.cause).toMatchObject({ code: '23502', column: 'target_host' });
  });
});

describe('expired holds', () => {
  it('lists payments still held from before a time, oldest first, a page at a time', async () => {
    const buyer = await newBuyer('0');
    const payments = createPaymentRepository({ db: database.db, clock });
    const held: string[] = [];
    clock.set(fixtureTime(0, 8, 10, 0, 0, 0));
    for (let index = 0; index < 3; index++)
      held.push((await payments.create({ ...payment(buyer, 1n), status: 'held' })).id);
    const released = await payments.create({ ...payment(buyer, 1n), status: 'held' });
    await payments.changeStatus({ paymentId: released.id, to: 'released' });
    clock.set(fixtureTime(0, 8, 10, 10, 0, 0));
    await payments.create({ ...payment(buyer, 1n), status: 'held' });
    const createdBefore = new Date(fixtureTime(0, 8, 10, 5, 0, 0));

    const first = await payments.listExpiredHolds({ createdBefore, limit: 2 });
    const second = await payments.listExpiredHolds({ createdBefore, limit: 2, after: first.at(-1)! });

    // Created in the same millisecond, so by ID
    expect([...first, ...second].map(item => item.id)).toEqual([...held].sort((left, right) => left < right ? -1 : 1));
    expect([...first, ...second].every(item => item.status === 'held' && item.createdAt < createdBefore)).toBe(true);
    expect(await payments.listExpiredHolds({ createdBefore, limit: 2, after: second.at(-1)! })).toEqual([]);
  });
});

describe('settling payments', () => {
  it('lists settling payments oldest first, with the settle request to repeat, and drops one once it is settled', async () => {
    const payments = createPaymentRepository({ db: database.db, clock });
    const settling: string[] = [];
    for (let index = 0; index < 3; index++) {
      clock.advance(1_000);
      const created = await payments.create({ ...onChainPayment(10_000n), status: 'verified' });
      await payments.changeStatus({ paymentId: created.id, to: 'settling', transactionHash: index === 0 ? '0x1' : undefined, settlementRequest: { index } });
      settling.push(created.id);
    }

    const first = await payments.listSettling({ limit: 2 });
    const rest = await payments.listSettling({ limit: 100, after: first.at(-1)!.payment });
    const mine = [...first, ...rest].filter(item => settling.includes(item.payment.id));

    expect(first).toHaveLength(2);
    expect(mine.map(item => item.payment.id)).toEqual(settling);
    expect(mine.map(item => item.settlementRequest)).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    expect(mine[0]?.payment.transactionHash).toBe('0x1');

    // A final status clears the settle request
    await payments.changeStatus({ paymentId: settling[0]!, to: 'settled', settlementRequest: null });
    expect((await payments.listSettling({ limit: 100 })).map(item => item.payment.id)).toEqual(settling.slice(1));
    const { rows } = await database.db.execute<{ request: unknown }>(sql`select settlement_request as request from payments where id = ${settling[0]!}`);
    expect(rows[0]?.request).toBeNull();
  });

  it('lists only settling payments last updated before updatedBefore, so a finalize still running is left alone', async () => {
    const payments = createPaymentRepository({ db: database.db, clock });
    const settle = async (): Promise<string> => {
      const created = await payments.create({ ...onChainPayment(10_000n), status: 'verified' });
      await payments.changeStatus({ paymentId: created.id, to: 'settling', settlementRequest: { id: created.id } });

      return created.id;
    };
    clock.set(fixtureTime(0, 9, 13, 0, 0, 0));
    const idle = await settle();
    const touched = await settle();
    clock.set(fixtureTime(0, 9, 13, 1, 0, 0));
    const recent = await settle();
    // Settling again, to record what its settlement learned: the update time moves with it
    clock.set(fixtureTime(0, 9, 13, 2, 0, 0));
    await payments.changeStatus({ paymentId: touched, to: 'settling', transactionHash: '0x2' });
    const updatedBefore = new Date(fixtureTime(0, 9, 13, 1, 0, 0));

    const listed = await payments.listSettling({ limit: 100, updatedBefore });
    const ids = listed.map(item => item.payment.id);

    expect(ids).toContain(idle);
    // Updated at updatedBefore itself, or after it
    expect(ids).not.toContain(recent);
    expect(ids).not.toContain(touched);
    expect(listed.every(item => item.payment.updatedAt < updatedBefore)).toBe(true);
    expect(listed.find(item => item.payment.id === idle)?.settlementRequest).toEqual({ id: idle });
    // Without it, every settling payment
    expect((await payments.listSettling({ limit: 100 })).map(item => item.payment.id)).toEqual(expect.arrayContaining([idle, touched, recent]));
  });

  it('claims a settling payment once for the time it was listed at, and moves that time to now', async () => {
    const payments = createPaymentRepository({ db: database.db, clock });
    clock.set(fixtureTime(0, 9, 14, 0, 0, 0));
    const created = await payments.create({ ...onChainPayment(10_000n), status: 'verified' });
    const listed = await payments.changeStatus({ paymentId: created.id, to: 'settling', settlementRequest: { id: created.id } });
    const verified = await payments.create({ ...onChainPayment(10_000n), status: 'verified' });
    clock.set(fixtureTime(0, 9, 14, 5, 0, 0));

    const claims = await Promise.all([
      payments.claimSettling({ paymentId: listed.id, seenUpdatedAt: listed.updatedAt }),
      payments.claimSettling({ paymentId: listed.id, seenUpdatedAt: listed.updatedAt }),
    ]);

    expect(claims.sort()).toEqual([false, true]);
    expect(await payments.find(listed.id)).toMatchObject({ status: 'settling', updatedAt: new Date(fixtureTime(0, 9, 14, 5, 0, 0)) });
    // Listed before the claim, so no longer the row's time
    expect(await payments.claimSettling({ paymentId: listed.id, seenUpdatedAt: listed.updatedAt })).toBe(false);
    // Only a settling payment
    expect(await payments.claimSettling({ paymentId: verified.id, seenUpdatedAt: verified.updatedAt })).toBe(false);
    expect(await payments.claimSettling({ paymentId: 'pay_missing', seenUpdatedAt: listed.updatedAt })).toBe(false);
    // Claimed now, it ages again from now
    expect((await payments.listSettling({ limit: 100, updatedBefore: new Date(fixtureTime(0, 9, 14, 5, 0, 0)) })).map(item => item.payment.id)).not.toContain(listed.id);
  });
});

describe('holds', () => {
  it('moves the price from available to held, counts it on the key, and records the payment as held, in one transaction', async () => {
    const buyer = await newBuyer('1');

    const result = await hold(buyer, usd('0.25'));

    expect(result).toMatchObject({
      ok: true,
      payment: { status: 'held', rail: 'credits', amount: usd('0.25'), keyId: buyer.keyId, buyerAccountId: buyer.accountId, createdAt: clock.now() },
    });
    const paymentId = result.ok ? result.payment.id : '';
    expect(await createPaymentRepository({ db: database.db, clock }).find(paymentId)).toEqual(result.ok && result.payment);
    expect(await movements(paymentId)).toEqual([
      { operation: 'hold', ledger_account_id: ledgerAccountIds.available(buyer.accountId), amount: '-250000' },
      { operation: 'hold', ledger_account_id: ledgerAccountIds.held(buyer.accountId), amount: '250000' },
    ]);
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('0.75'), held: usd('0.25') });
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map([[buyer.keyId, { today: usd('0.25'), total: usd('0.25') }]]));
  });

  it.each([
    ['the balance', '0.10', {}, 'insufficient_balance'],
    ['the daily budget', '10', { dailyBudget: '0.10' }, 'key_budget_exceeded'],
    ['the allowance', '10', { allowance: '0.10' }, 'key_allowance_exceeded'],
  ] as const)('refuses a hold over %s, and leaves no movement, no spend and no payment row', async (_case, credit, limits: Limits, refusal) => {
    const buyer = await newBuyer(credit, limits);
    const input = holdInput(buyer, usd('0.25'), limits);

    const result = await ledger.hold(input);

    expect(result).toEqual({ ok: false, refusal });
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd(credit), held: 0n });
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map());
    expect(await transactionsFor(input.payment.id)).toEqual([]);
    expect(await movements(input.payment.id)).toEqual([]);
    expect(await createPaymentRepository({ db: database.db, clock }).find(input.payment.id)).toBeUndefined();
  });

  it('refuses an account that was never credited as short of funds', async () => {
    const buyer = await newBuyer('0');

    expect(await hold(buyer, 1n)).toEqual({ ok: false, refusal: 'insufficient_balance' });
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map());
  });

  it('returns the first hold when the same payment is held again', async () => {
    const buyer = await newBuyer('1');
    const input = holdInput(buyer, usd('0.25'));

    const first = await ledger.hold(input);
    clock.advance(1_000);
    const again = await ledger.hold(input);

    expect(again).toEqual(first);
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('0.75'), held: usd('0.25') });
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map([[buyer.keyId, { today: usd('0.25'), total: usd('0.25') }]]));
  });

  it('holds a payment once when 10 holds of it run concurrently, and returns the same payment to each', async () => {
    const buyer = await newBuyer('1');
    const input = holdInput(buyer, usd('0.25'));

    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.hold(input)));

    expect(results[0]).toMatchObject({ ok: true, payment: { id: input.payment.id, status: 'held' } });
    expect(results).toEqual(Array.from({ length: 10 }, () => results[0]));
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('0.75'), held: usd('0.25') });
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map([[buyer.keyId, { today: usd('0.25'), total: usd('0.25') }]]));
    expect(await transactionsFor(input.payment.id)).toEqual(['hold']);
  });

  it('refuses a replay of a hold with another buyer, key or amount, and moves nothing', async () => {
    const [buyer, other] = [await newBuyer('1'), await newBuyer('1')];
    const otherKey = await newKey(buyer.accountId);
    const input = holdInput(buyer, usd('0.25'));
    const first = await ledger.hold(input);
    const replays: readonly HoldInput[] = [
      { ...input, payment: { ...input.payment, amount: usd('0.5') } },
      { ...input, payment: { ...input.payment, keyId: otherKey } },
      { ...input, payment: { ...input.payment, buyerAccountId: other.accountId, keyId: other.keyId } },
    ];

    for (const replay of replays)
      expect(await thrown(ledger.hold(replay))).toBeInstanceOf(HoldReferenceConflictError);

    expect(await createPaymentRepository({ db: database.db, clock }).find(input.payment.id)).toEqual(first.ok && first.payment);
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('0.75'), held: usd('0.25') });
    expect(await ledger.balance(other.accountId)).toEqual({ available: usd('1'), held: 0n });
    expect(await ledger.keySpend([buyer.keyId, otherKey, other.keyId], today))
      .toEqual(new Map([[buyer.keyId, { today: usd('0.25'), total: usd('0.25') }]]));
    expect(await movements(input.payment.id)).toHaveLength(2);
  });

  it('starts each key\'s daily budget again at midnight UTC', async () => {
    const buyer = await newBuyer('10', { dailyBudget: '0.20' });
    clock.set(fixtureTime(0, 9, 23, 59, 59, 0));
    const late = await hold(buyer, usd('0.20'), { dailyBudget: '0.20' });
    const over = await hold(buyer, usd('0.10'), { dailyBudget: '0.20' });

    clock.set(fixtureTime(0, 10, 0, 0, 0, 0));
    const nextDay = await hold(buyer, usd('0.20'), { dailyBudget: '0.20' });
    // A release gives the spend back to the day it was counted on
    await ledger.release({ paymentId: late.ok ? late.payment.id : '' });

    expect([late.ok, over.ok, nextDay.ok]).toEqual([true, false, true]);
    expect(over).toEqual({ ok: false, refusal: 'key_budget_exceeded' });
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 9))).toEqual(new Map([[buyer.keyId, { today: 0n, total: usd('0.20') }]]));
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 10))).toEqual(new Map([[buyer.keyId, { today: usd('0.20'), total: usd('0.20') }]]));
  });

  it('counts a hold just before midnight UTC on the day of the payment\'s createdAt, so a release after midnight gives it back cleanly', async () => {
    const buyer = await newBuyer('10', { dailyBudget: '1' });
    // Every read moves the clock by 1 ms: a hold that read it twice would straddle midnight
    let now = new Date(fixtureTime(0, 9, 23, 59, 59, 999)).getTime();
    const ticking = createLedger({ db: database.db, clock: { now: () => new Date(now++) }, ids });
    const late = await ticking.hold({ payment: payment(buyer, usd('0.5')), dailyBudget: usd('1'), allowance: undefined });
    // The next day's spend is smaller than the late hold
    clock.set(fixtureTime(0, 10, 0, 0, 1, 0));
    await hold(buyer, usd('0.1'), { dailyBudget: '1' });

    const released = await ledger.release({ paymentId: late.ok ? late.payment.id : '' });

    expect(late.ok && late.payment.createdAt).toEqual(new Date(fixtureTime(0, 9, 23, 59, 59, 999)));
    expect(released.payment.status).toBe('released');
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 9))).toEqual(new Map([[buyer.keyId, { today: 0n, total: usd('0.1') }]]));
    expect(await ledger.keySpend([buyer.keyId], fixtureDay(0, 10))).toEqual(new Map([[buyer.keyId, { today: usd('0.1'), total: usd('0.1') }]]));
  });

  it.each([
    ['the balance', '0.05', {}, 'insufficient_balance'],
    ['the daily budget', '10', { dailyBudget: '0.05' }, 'key_budget_exceeded'],
    ['the allowance', '10', { allowance: '0.05' }, 'key_allowance_exceeded'],
  ] as const)('lets exactly 5 of 20 concurrent $0.01 holds through %s of $0.05, with no deadlock', async (_case, credit, limits: Limits, refusal) => {
    const buyer = await newBuyer(credit, limits);

    const results = await Promise.all(Array.from({ length: 20 }, () => hold(buyer, usd('0.01'), limits)));

    expect(results.filter(result => result.ok)).toHaveLength(5);
    expect(results.filter(result => !result.ok)).toEqual(Array.from({ length: 15 }, () => ({ ok: false, refusal })));
    const { available, held } = await ledger.balance(buyer.accountId);
    expect(held).toBe(usd('0.05'));
    expect(available).toBe(usd(credit) - usd('0.05'));
    expect(available >= 0n).toBe(true);
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map([[buyer.keyId, { today: usd('0.05'), total: usd('0.05') }]]));
    expect(await negativeBalances()).toEqual([]);
    expect(await unbalancedTransactions()).toEqual([]);
  });
});

describe('releases', () => {
  it('gives a held payment back once, with the key\'s spend, when a release runs twice or concurrently', async () => {
    const buyer = await newBuyer('1');
    const held = await hold(buyer, usd('0.5'));
    const paymentId = held.ok ? held.payment.id : '';

    const [first, second] = await Promise.all([ledger.release({ paymentId }), ledger.release({ paymentId })]);
    const again = await ledger.release({ paymentId });

    expect([first.payment.status, second.payment.status, again.payment.status]).toEqual(['released', 'released', 'released']);
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('1'), held: 0n });
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map([[buyer.keyId, { today: 0n, total: 0n }]]));
    expect((await movements(paymentId)).map(row => row.operation)).toEqual(['hold', 'hold', 'release', 'release']);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('refuses to release a payment that isn\'t held', async () => {
    const payments = createPaymentRepository({ db: database.db, clock });
    const captured = await payments.create({ ...payment(await newBuyer('0'), 1n), status: 'held' });
    await payments.changeStatus({ paymentId: captured.id, to: 'captured' });
    const verified = await payments.create({ ...onChainPayment(1n), status: 'verified' });

    for (const paymentId of [captured.id, verified.id, 'pay_missing'])
      expect(await thrown(ledger.release({ paymentId }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect((await payments.find(captured.id))?.status).toBe('captured');
    expect((await payments.find(verified.id))?.status).toBe('verified');
  });

  it('refuses a credits payment created as held without a hold, and moves nothing', async () => {
    const buyer = await newBuyer('1');
    const payments = createPaymentRepository({ db: database.db, clock });
    const created = await payments.create({ ...payment(buyer, usd('0.25')), status: 'held' });

    const error = await thrown(ledger.release({ paymentId: created.id }));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/has no hold/);
    expect((await payments.find(created.id))?.status).toBe('held');
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('1'), held: 0n });
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map());
    expect(await transactionsFor(created.id)).toEqual([]);
  });

  it('throws for a payment released outside the ledger, and leaves the balances as they were', async () => {
    const buyer = await newBuyer('1');
    const held = await hold(buyer, usd('0.25'));
    const paymentId = held.ok ? held.payment.id : '';
    await createPaymentRepository({ db: database.db, clock }).changeStatus({ paymentId, to: 'released' });

    const error = await thrown(ledger.release({ paymentId }));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/released outside the ledger/);
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('0.75'), held: usd('0.25') });
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map([[buyer.keyId, { today: usd('0.25'), total: usd('0.25') }]]));
    expect(await transactionsFor(paymentId)).toEqual(['hold']);
  });
});

describe('concurrent holds, releases and credits', () => {
  it('keeps every balance equal to its entries, none below zero, and each key\'s spend equal to its open holds, over two UTC days', async () => {
    const limits: Limits = { dailyBudget: '0.08', allowance: '0.15' };
    const buyers = [await newBuyer('0.10', limits), await newBuyer('0.10', limits), await newBuyer('0.10', limits)];
    const days = [fixtureDay(0, 9), fixtureDay(0, 10)];
    // A ledger a second before midnight UTC, and one a second after
    const ledgers = [fixtureTime(0, 9, 23, 59, 59, 0), fixtureTime(0, 10, 0, 0, 1, 0)]
      .map(moment => createLedger({ db: database.db, clock: { now: () => new Date(moment) }, ids }));
    const ledgerOf = (round: number) => ledgers[round % 2]!;

    const rounds = buyers.flatMap(buyer => Array.from({ length: 20 }, async (_, round) => {
      const held = await ledgerOf(round).hold(holdInput(buyer, usd('0.01'), limits));
      // Every third hold is released, on the other day
      if (held.ok && round % 3 === 0)
        await ledgerOf(round + 1).release({ paymentId: held.payment.id });
    }));
    const credits = buyers.flatMap(buyer => Array.from({ length: 5 }, (_, index) =>
      ledgerOf(index).credit({ accountId: buyer.accountId, amount: usd('0.02'), reference: `mixed-${buyer.accountId}-${index}` })));
    await Promise.all([...rounds, ...credits]);

    const drifted = (await database.db.execute(sql`
      select b.ledger_account_id, b.balance::text as balance, coalesce(sum(e.amount), 0)::text as entries
      from balances b left join ledger_entries e on e.ledger_account_id = b.ledger_account_id
      group by b.ledger_account_id, b.balance
      having b.balance <> coalesce(sum(e.amount), 0)
    `)).rows;
    expect(drifted).toEqual([]);
    expect(await negativeBalances()).toEqual([]);
    expect(await unbalancedTransactions()).toEqual([]);
    const payments = createPaymentRepository({ db: database.db, clock });
    for (const buyer of buyers) {
      const open = (await payments.listForBuyer({ buyerAccountId: buyer.accountId, limit: 100 })).payments.filter(item => item.status === 'held');
      const openOn = (day: string) => open.filter(item => utcDay(item.createdAt) === day).reduce((sum, item) => sum + item.amount, 0n);
      const total = days.reduce((sum, day) => sum + openOn(day), 0n);
      for (const day of days)
        expect((await ledger.keySpend([buyer.keyId], day)).get(buyer.keyId) ?? { today: 0n, total: 0n }).toEqual({ today: openOn(day), total });
      expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('0.20') - total, held: total });
    }
  });
});

// Routed calls: a quote of $0.0011 for a target price of $0.001, so the routing fee is $0.0001
const quote = usd('0.0011');
const targetPrice = usd('0.001');
const targetPayTo = '0x4444444444444444444444444444444444444444';
const treasuryOf = ledgerAccountIds.treasury;

const routing = () => createRoutingRepository({ db: database.db, clock });

// The target leg the proxy records before it charges the buyer
const recordTargetLeg = (paymentId: string, amount: bigint = targetPrice, asset = 'base-usdc') => routing().recordTargetPayment({
  paymentId, protocol: 'x402', network: 'eip155:84532', asset, amount, atomicAmount: amount, payTo: targetPayTo, signatureId: `sig_${paymentId}`,
});
const legTo = (status: TargetPaymentStatus) => (paymentId: string) => routing().updateTargetPayment(paymentId, { status });
// What a booked routing loss leaves on a leg, set without the ledger
const legBookedAsLoss = async (paymentId: string): Promise<void> => {
  await database.db.update(targetPayments).set({ lossBooked: true }).where(sql`${targetPayments.paymentId} = ${paymentId}`);
};

// How much each platform account moved since `before`
const platformIds = [
  treasuryOf('base-usdc'), treasuryOf('solana-usdc'), treasuryOf('tempo-pathusd'), ledgerAccountIds.routingFees, ledgerAccountIds.routingLosses,
  ledgerAccountIds.conversion,
];
const platformBalances = async () => {
  const found = await ledger.balancesOf(platformIds);

  return new Map(platformIds.map(id => [id, found.get(id) ?? 0n]));
};
const movedSince = async (before: ReadonlyMap<string, bigint>): Promise<Record<string, bigint>> => {
  const after = await platformBalances();

  return Object.fromEntries(platformIds.map(id => [id, (after.get(id) ?? 0n) - (before.get(id) ?? 0n)] as const).filter(([, moved]) => moved !== 0n));
};

// The entries of one operation on a reference, smallest amount first
const entriesOf = async (reference: string, operation: string) =>
  (await movements(reference)).filter(row => row.operation === operation).map(row => ({ account: row.ledger_account_id, amount: BigInt(row.amount) }));

const heldRouted = async (amount: bigint = quote) => {
  const buyer = await newBuyer('1');
  const held = await hold(buyer, amount);
  if (!held.ok)
    throw new Error(held.refusal);

  return { buyer, paymentId: held.payment.id };
};

describe('captures of routed calls', () => {
  it('charges a held payment: held → the target asset\'s treasury at the target\'s price and routing fees at the rest, and keeps the key\'s spend', async () => {
    const { buyer, paymentId } = await heldRouted();
    await recordTargetLeg(paymentId);
    await legTo('settled')(paymentId);
    const before = await platformBalances();
    clock.advance(1_000);

    const result = await ledger.capture({ paymentId });

    expect(result).toEqual({ payment: expect.objectContaining({ id: paymentId, status: 'captured', amount: quote, fee: usd('0.0001') }), fee: usd('0.0001') });
    expect(await createPaymentRepository({ db: database.db, clock }).find(paymentId)).toEqual(result.payment);
    expect(await entriesOf(paymentId, 'capture')).toEqual([
      { account: ledgerAccountIds.held(buyer.accountId), amount: -1_100n },
      { account: ledgerAccountIds.routingFees, amount: 100n },
      { account: treasuryOf('base-usdc'), amount: 1_000n },
    ]);
    expect(await movedSince(before)).toEqual({ [treasuryOf('base-usdc')]: 1_000n, [ledgerAccountIds.routingFees]: 100n });
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('1') - quote, held: 0n });
    // The money was spent: the key's spend stays counted
    expect(await ledger.keySpend([buyer.keyId], today)).toEqual(new Map([[buyer.keyId, { today: quote, total: quote }]]));
    expect(await transactionsFor(paymentId)).toEqual(['capture', 'hold']);
    // The leg is charged, so it is never a routing loss
    expect(await routing().findTargetPayment(paymentId)).toMatchObject({ status: 'settled', buyerCharged: true, lossBooked: false, updatedAt: clock.now() });
    expect((await routing().listUnbookedLosses(1_000)).map(loss => loss.paymentId)).not.toContain(paymentId);
    expect(await unbalancedTransactions()).toEqual([]);
    expect(await negativeBalances()).toEqual([]);
  });

  it.each(['signed', 'unknown'] as const)('charges a leg still %s as paid', async status => {
    const { paymentId } = await heldRouted();
    await recordTargetLeg(paymentId);
    await legTo(status)(paymentId);
    const before = await platformBalances();

    expect(await ledger.capture({ paymentId })).toMatchObject({ fee: 100n, payment: { status: 'captured' } });
    expect(await movedSince(before)).toEqual({ [treasuryOf('base-usdc')]: 1_000n, [ledgerAccountIds.routingFees]: 100n });
    expect(await routing().findTargetPayment(paymentId)).toMatchObject({ status, buyerCharged: true });
  });

  it('books the target\'s price in the treasury of the asset the target was paid in', async () => {
    const { paymentId } = await heldRouted();
    await recordTargetLeg(paymentId, targetPrice, 'solana-usdc');
    const before = await platformBalances();

    await ledger.capture({ paymentId });

    expect(await movedSince(before)).toEqual({ [treasuryOf('solana-usdc')]: 1_000n, [ledgerAccountIds.routingFees]: 100n });
  });

  it('moves money once when a capture runs twice, and twice concurrently', async () => {
    const { buyer, paymentId } = await heldRouted();
    await recordTargetLeg(paymentId);
    const before = await platformBalances();

    const [first, second] = await Promise.all([ledger.capture({ paymentId }), ledger.capture({ paymentId })]);
    clock.advance(1_000);
    const again = await ledger.capture({ paymentId });

    expect([first, second, again].map(result => [result.payment.status, result.fee])).toEqual(Array.from({ length: 3 }, () => ['captured', 100n]));
    expect(again).toEqual(first);
    expect(await transactionsFor(paymentId)).toEqual(['capture', 'hold']);
    expect(await entriesOf(paymentId, 'capture')).toHaveLength(3);
    expect(await movedSince(before)).toEqual({ [treasuryOf('base-usdc')]: 1_000n, [ledgerAccountIds.routingFees]: 100n });
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('1') - quote, held: 0n });
  });

  it('charges the whole quote as the target\'s price when there is no fee', async () => {
    const { paymentId } = await heldRouted();
    await recordTargetLeg(paymentId, quote);
    const before = await platformBalances();

    expect(await ledger.capture({ paymentId })).toMatchObject({ fee: 0n, payment: { status: 'captured', fee: 0n } });
    expect(await movedSince(before)).toEqual({ [treasuryOf('base-usdc')]: 1_100n });
  });

  it.each([
    ['without a target leg', async () => {}, /has no target leg/],
    ['for a target price above the quote', (paymentId: string) => recordTargetLeg(paymentId, usd('0.0012')), /\$0\.0012, is more than the quote .* \$0\.0011/],
    ['for a target leg the target refused', async (paymentId: string) => {
      await recordTargetLeg(paymentId);
      await legTo('failed')(paymentId);
    }, /target refused/],
    ['for a target leg booked as a routing loss', async (paymentId: string) => {
      await recordTargetLeg(paymentId);
      await legBookedAsLoss(paymentId);
    }, /booked as a routing loss/],
  ] as const)('throws %s, and moves nothing', async (_case, setUp, message) => {
    const { buyer, paymentId } = await heldRouted();
    await setUp(paymentId);
    const before = await platformBalances();

    const error = await thrown(ledger.capture({ paymentId }));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    expect(await createPaymentRepository({ db: database.db, clock }).find(paymentId)).toMatchObject({ status: 'held', fee: undefined });
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('1') - quote, held: quote });
    expect(await movedSince(before)).toEqual({});
    expect(await transactionsFor(paymentId)).toEqual(['hold']);
    expect((await routing().findTargetPayment(paymentId))?.buyerCharged ?? false).toBe(false);
  });

  it('throws for a credits payment created as held without a hold, and moves nothing', async () => {
    const payments = createPaymentRepository({ db: database.db, clock });
    const created = await payments.create({ ...payment(await newBuyer('1'), quote), status: 'held' });
    await recordTargetLeg(created.id);

    const error = await thrown(ledger.capture({ paymentId: created.id }));

    expect((error as Error).message).toMatch(/has no hold/);
    expect((await payments.find(created.id))?.status).toBe('held');
    expect(await transactionsFor(created.id)).toEqual([]);
  });

  it('refuses to capture a released payment, and to release a captured one', async () => {
    const captured = await heldRouted();
    const released = await heldRouted();
    await Promise.all([recordTargetLeg(captured.paymentId), recordTargetLeg(released.paymentId)]);
    await ledger.capture({ paymentId: captured.paymentId });
    await ledger.release({ paymentId: released.paymentId });
    const payments = createPaymentRepository({ db: database.db, clock });
    const verified = await payments.create({ ...onChainPayment(quote), status: 'verified' });
    await recordTargetLeg(verified.id);

    expect(await thrown(ledger.release({ paymentId: captured.paymentId }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect(await thrown(ledger.capture({ paymentId: released.paymentId }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect(await thrown(ledger.capture({ paymentId: verified.id }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect(await thrown(ledger.capture({ paymentId: 'pay_missing' }))).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect((await payments.find(captured.paymentId))?.status).toBe('captured');
    expect((await payments.find(released.paymentId))?.status).toBe('released');
    expect((await payments.find(verified.id))?.status).toBe('verified');
    expect(await ledger.balance(released.buyer.accountId)).toEqual({ available: usd('1'), held: 0n });
    expect(await transactionsFor(released.paymentId)).toEqual(['hold', 'release']);
  });

  it('throws for a payment captured outside the ledger, and leaves the balances as they were', async () => {
    const { buyer, paymentId } = await heldRouted();
    await recordTargetLeg(paymentId);
    await createPaymentRepository({ db: database.db, clock }).changeStatus({ paymentId, to: 'captured' });
    const before = await platformBalances();

    const error = await thrown(ledger.capture({ paymentId }));

    expect((error as Error).message).toMatch(/captured outside the ledger/);
    expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('1') - quote, held: quote });
    expect(await movedSince(before)).toEqual({});
    expect(await transactionsFor(paymentId)).toEqual(['hold']);
  });
});

describe('settlements of routed calls', () => {
  // An x402 payment of the quote in Base USDC, verified, with its target leg unless `target` is null
  const verifiedRouted = async (changes: Partial<NewPayment> = {}, target: { readonly price?: bigint; readonly asset?: string } | null = {}) => {
    const payments = createPaymentRepository({ db: database.db, clock });
    const created = await payments.create({ ...onChainPayment(quote, { asset: 'base-usdc', ...changes }), status: 'verified' });
    if (target)
      await recordTargetLeg(created.id, target.price ?? targetPrice, target.asset ?? 'base-usdc');

    return { payments, payment: created };
  };
  const settleInput = (paymentId: string, changes: Partial<SettleInput> = {}): SettleInput => ({
    paymentId, asset: 'base-usdc', transactionHash: '0xabc', receipt: 'eyJzdWNjZXNzIjp0cnVlfQ', needsReview: false, ...changes,
  });

  it('books a verified payment: the buyer\'s asset\'s treasury → the target asset\'s treasury and routing fees, with the hash, receipt and review flag', async () => {
    const { payments, payment: created } = await verifiedRouted({}, { asset: 'solana-usdc' });
    const before = await platformBalances();

    const result = await ledger.settle(settleInput(created.id, { needsReview: true }));

    expect(result).toEqual({
      payment: expect.objectContaining({
        id: created.id, status: 'settled', fee: usd('0.0001'), transactionHash: '0xabc', receipt: 'eyJzdWNjZXNzIjp0cnVlfQ', needsReview: true,
      }),
      fee: usd('0.0001'),
    });
    expect(await payments.find(created.id)).toEqual(result.payment);
    // The buyer's $0.0011 arrived in Base USDC; the target's $0.001 left in Solana USDC
    expect(await entriesOf(created.id, 'settle')).toEqual([
      { account: treasuryOf('base-usdc'), amount: -1_100n },
      { account: ledgerAccountIds.routingFees, amount: 100n },
      { account: treasuryOf('solana-usdc'), amount: 1_000n },
    ]);
    expect(await movedSince(before)).toEqual({ [treasuryOf('base-usdc')]: -1_100n, [treasuryOf('solana-usdc')]: 1_000n, [ledgerAccountIds.routingFees]: 100n });
    expect(await routing().findTargetPayment(created.id)).toMatchObject({ buyerCharged: true, lossBooked: false, updatedAt: clock.now() });
    expect(await unbalancedTransactions()).toEqual([]);
    expect(await negativeBalances()).toEqual([]);
  });

  it('books the whole quote as the fee, with no outflow, when the target refused our payment, and replays it', async () => {
    const { payments, payment: created } = await verifiedRouted({}, { asset: 'solana-usdc' });
    await legTo('failed')(created.id);
    const before = await platformBalances();

    const first = await ledger.settle(settleInput(created.id));
    clock.advance(1_000);
    const again = await ledger.settle(settleInput(created.id));

    expect(first).toEqual({ payment: expect.objectContaining({ status: 'settled', fee: quote, transactionHash: '0xabc' }), fee: quote });
    expect(again).toEqual(first);
    expect(await payments.find(created.id)).toEqual(first.payment);
    // The buyer's $0.0011 arrived in Base USDC, and no treasury paid the target
    expect(await entriesOf(created.id, 'settle')).toEqual([
      { account: treasuryOf('base-usdc'), amount: -1_100n },
      { account: ledgerAccountIds.routingFees, amount: 1_100n },
    ]);
    expect(await movedSince(before)).toEqual({ [treasuryOf('base-usdc')]: -1_100n, [ledgerAccountIds.routingFees]: 1_100n });
    expect(await routing().findTargetPayment(created.id)).toMatchObject({ status: 'failed', buyerCharged: true, lossBooked: false });
    expect(await transactionsFor(created.id)).toEqual(['settle']);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('settles a payment that was settling, clears its settle request, and keeps its hash when none is given', async () => {
    const { payments, payment: created } = await verifiedRouted();
    await payments.changeStatus({ paymentId: created.id, to: 'settling', transactionHash: '0xdef', settlementRequest: { paymentPayload: { x402Version: 2 } } });
    const before = await platformBalances();

    const settled = await ledger.settle(settleInput(created.id, { transactionHash: undefined, receipt: undefined }));

    expect(settled.payment).toMatchObject({ status: 'settled', transactionHash: '0xdef', receipt: undefined, needsReview: false, fee: 100n });
    expect((await payments.listSettling({ limit: 100 })).map(item => item.payment.id)).not.toContain(created.id);
    const { rows } = await database.db.execute<{ request: unknown }>(sql`select settlement_request as request from payments where id = ${created.id}`);
    expect(rows[0]?.request).toBeNull();
    // In and out of the same treasury: what stays is the fee
    expect(await movedSince(before)).toEqual({ [treasuryOf('base-usdc')]: -100n, [ledgerAccountIds.routingFees]: 100n });
  });

  it('moves nothing on a second settle, sequential or concurrent, and returns the first', async () => {
    const { payment: created } = await verifiedRouted();
    const before = await platformBalances();

    const [first, second] = await Promise.all([ledger.settle(settleInput(created.id)), ledger.settle(settleInput(created.id))]);
    clock.advance(1_000);
    const again = await ledger.settle(settleInput(created.id, { transactionHash: '0xother', needsReview: true }));

    expect(second).toEqual(first);
    expect(again).toEqual(first);
    expect(await transactionsFor(created.id)).toEqual(['settle']);
    expect(await movedSince(before)).toEqual({ [treasuryOf('base-usdc')]: -100n, [ledgerAccountIds.routingFees]: 100n });
  });

  it('settles an MPP payment in the asset given when the payment names none', async () => {
    const { payment: created } = await verifiedRouted({ rail: 'mpp', network: 'eip155:42431', asset: undefined }, { asset: 'tempo-pathusd' });
    const before = await platformBalances();

    expect(await ledger.settle(settleInput(created.id, { asset: 'tempo-pathusd' }))).toMatchObject({ fee: 100n, payment: { rail: 'mpp', status: 'settled' } });
    expect(await entriesOf(created.id, 'settle')).toEqual([
      { account: treasuryOf('tempo-pathusd'), amount: -1_100n },
      { account: ledgerAccountIds.routingFees, amount: 100n },
      { account: treasuryOf('tempo-pathusd'), amount: 1_000n },
    ]);
    expect(await movedSince(before)).toEqual({ [treasuryOf('tempo-pathusd')]: -100n, [ledgerAccountIds.routingFees]: 100n });
  });

  it('refuses a credits payment, a cancelled one, and one that doesn\'t exist, and moves nothing', async () => {
    const { paymentId: held } = await heldRouted();
    await recordTargetLeg(held);
    const { payments, payment: cancelled } = await verifiedRouted();
    await payments.changeStatus({ paymentId: cancelled.id, to: 'cancelled' });
    const before = await platformBalances();

    for (const paymentId of [held, cancelled.id, 'pay_missing'])
      expect(await thrown(ledger.settle(settleInput(paymentId)))).toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect((await payments.find(held))?.status).toBe('held');
    expect((await payments.find(cancelled.id))?.status).toBe('cancelled');
    expect(await transactionsFor(cancelled.id)).toEqual([]);
    expect(await movedSince(before)).toEqual({});
  });

  it.each([
    ['an asset that isn\'t the payment\'s', {}, undefined, { asset: 'solana-usdc' }, /paid in base-usdc, so it can't settle in solana-usdc/],
    ['no target leg', null, undefined, {}, /has no target leg/],
    ['a target price above the quote', { price: usd('0.0012') }, undefined, {}, /is more than the quote/],
    ['a target leg booked as a routing loss', {}, legBookedAsLoss, {}, /booked as a routing loss/],
  ] as const)('throws for %s, and moves nothing', async (_case, target, change, changes: Partial<SettleInput>, message) => {
    const { payments, payment: created } = await verifiedRouted({}, target);
    await change?.(created.id);
    const before = await platformBalances();

    const error = await thrown(ledger.settle(settleInput(created.id, changes)));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    expect(await payments.find(created.id)).toMatchObject({ status: 'verified', fee: undefined, transactionHash: undefined });
    expect(await transactionsFor(created.id)).toEqual([]);
    expect(await movedSince(before)).toEqual({});
  });

  it('throws for a payment settled outside the ledger', async () => {
    const { payments, payment: created } = await verifiedRouted();
    await payments.changeStatus({ paymentId: created.id, to: 'settled' });

    expect(((await thrown(ledger.settle(settleInput(created.id)))) as Error).message).toMatch(/settled outside the ledger/);
    expect(await transactionsFor(created.id)).toEqual([]);
  });
});

describe('routing losses', () => {
  it('books what a target kept once: routing losses → the target asset\'s treasury, and marks the target leg booked', async () => {
    const routing = createRoutingRepository({ db: database.db, clock });
    const payments = createPaymentRepository({ db: database.db, clock });
    // The target was paid, then the buyer's settlement failed
    const created = await payments.create({ ...onChainPayment(quote, { asset: 'base-usdc' }), status: 'verified' });
    await recordTargetLeg(created.id);
    await routing.updateTargetPayment(created.id, { status: 'settled', transactionHash: '0xpaid' });
    await payments.changeStatus({ paymentId: created.id, to: 'failed' });
    expect((await routing.listUnbookedLosses(1_000)).map(loss => loss.paymentId)).toContain(created.id);
    const before = await platformBalances();

    const first = await ledger.routingLoss({ paymentId: created.id });
    clock.advance(1_000);
    const replays = await Promise.all([ledger.routingLoss({ paymentId: created.id }), ledger.routingLoss({ paymentId: created.id })]);

    expect(first).toEqual({ transactionId: expect.any(String), createdAt: new Date(noon), replayed: false });
    expect(replays).toEqual([{ ...first, replayed: true }, { ...first, replayed: true }]);
    expect(await entriesOf(created.id, 'routing_loss')).toEqual([
      { account: ledgerAccountIds.routingLosses, amount: -1_000n },
      { account: treasuryOf('base-usdc'), amount: 1_000n },
    ]);
    expect(await movedSince(before)).toEqual({ [ledgerAccountIds.routingLosses]: -1_000n, [treasuryOf('base-usdc')]: 1_000n });
    expect(await routing.findTargetPayment(created.id)).toMatchObject({ lossBooked: true, updatedAt: new Date(noon) });
    expect((await routing.listUnbookedLosses(1_000)).map(loss => loss.paymentId)).not.toContain(created.id);
    expect(await transactionsFor(created.id)).toEqual(['routing_loss']);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('throws for a payment without a target leg, and moves nothing', async () => {
    const created = await createPaymentRepository({ db: database.db, clock }).create({ ...onChainPayment(quote), status: 'verified' });

    expect(((await thrown(ledger.routingLoss({ paymentId: created.id }))) as Error).message).toMatch(/has no target leg/);
    expect(await thrown(ledger.routingLoss({ paymentId: 'pay_missing' }))).toBeInstanceOf(Error);
    expect(await transactionsFor(created.id)).toEqual([]);
  });

  // A routed call with a settled target leg, its buyer payment moved by `setUp`
  const settledLeg = async (rail: 'credits' | 'x402', setUp: (paymentId: string) => Promise<unknown>, legStatus: TargetPaymentStatus = 'settled') => {
    const paymentId = rail === 'credits'
      ? (await heldRouted()).paymentId
      : (await createPaymentRepository({ db: database.db, clock }).create({ ...onChainPayment(quote, { asset: 'base-usdc' }), status: 'verified' })).id;
    await recordTargetLeg(paymentId);
    await legTo(legStatus)(paymentId);
    await setUp(paymentId);

    return paymentId;
  };
  const payments = () => createPaymentRepository({ db: database.db, clock });

  it.each([
    ['a held payment', () => settledLeg('credits', async () => {}), /is held: only a payment that failed, was released, or was cancelled/],
    ['a payment the ledger captured', () => settledLeg('credits', paymentId => ledger.capture({ paymentId })), /was charged for the call/],
    ['a payment the ledger settled', () => settledLeg('x402', paymentId => ledger.settle({
      paymentId, asset: 'base-usdc', transactionHash: undefined, receipt: undefined, needsReview: false,
    })), /was charged for the call/],
    ['a payment captured outside the ledger', () => settledLeg('credits', paymentId => payments().changeStatus({ paymentId, to: 'captured' })), /is captured/],
    ['a payment settled outside the ledger', () => settledLeg('x402', paymentId => payments().changeStatus({ paymentId, to: 'settled' })), /is settled/],
    ['a verified payment', () => settledLeg('x402', async () => {}), /is verified/],
    ['a leg still signed', () => settledLeg('x402', paymentId => payments().changeStatus({ paymentId, to: 'failed' }), 'signed'), /leg of .* is signed/],
    ['a leg the target refused', () => settledLeg('x402', paymentId => payments().changeStatus({ paymentId, to: 'failed' }), 'failed'), /leg of .* is failed/],
    ['a leg of unknown outcome', () => settledLeg('credits', paymentId => ledger.release({ paymentId }), 'unknown'), /leg of .* is unknown/],
  ] as const)('refuses %s, and moves nothing', async (_case, call, message) => {
    const paymentId = await call();
    const transactions = await transactionsFor(paymentId);
    const before = await platformBalances();

    const error = await thrown(ledger.routingLoss({ paymentId }));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    expect(await transactionsFor(paymentId)).toEqual(transactions);
    expect(await movedSince(before)).toEqual({});
    expect(await routing().findTargetPayment(paymentId)).toMatchObject({ lossBooked: false });
  });

  it('books a loss or a charge for a payment, never both, one after the other', async () => {
    // Still held: no loss, then the capture
    const held = await settledLeg('credits', async () => {});
    expect(await thrown(ledger.routingLoss({ paymentId: held }))).toBeInstanceOf(Error);
    await ledger.capture({ paymentId: held });
    expect(await thrown(ledger.routingLoss({ paymentId: held }))).toBeInstanceOf(Error);
    // Released: the loss, then no capture
    const released = await settledLeg('credits', paymentId => ledger.release({ paymentId }));
    await ledger.routingLoss({ paymentId: released });
    expect(await thrown(ledger.capture({ paymentId: released }))).toBeInstanceOf(InvalidPaymentStatusChangeError);

    expect(await transactionsFor(held)).toEqual(['capture', 'hold']);
    expect(await transactionsFor(released)).toEqual(['hold', 'release', 'routing_loss']);
    expect(await routing().findTargetPayment(held)).toMatchObject({ buyerCharged: true, lossBooked: false });
    expect(await routing().findTargetPayment(released)).toMatchObject({ buyerCharged: false, lossBooked: true });
  });

  it('books a loss or a charge for a payment, never both, when a loss races a capture, a release and a settlement', async () => {
    const credits = await Promise.all(Array.from({ length: 8 }, () => settledLeg('credits', async () => {})));
    const onChain = await Promise.all(Array.from({ length: 4 }, () => settledLeg('x402', async () => {})));
    const before = await platformBalances();

    await Promise.all([
      ...credits.map(paymentId => Promise.allSettled([ledger.routingLoss({ paymentId }), ledger.release({ paymentId }), ledger.capture({ paymentId }), ledger.routingLoss({ paymentId })])),
      ...onChain.map(paymentId => Promise.allSettled([
        ledger.routingLoss({ paymentId }), ledger.settle({ paymentId, asset: 'base-usdc', transactionHash: undefined, receipt: undefined, needsReview: false }),
      ])),
    ]);

    let charged = 0n;
    let lost = 0n;
    for (const paymentId of [...credits, ...onChain]) {
      const operations = await transactionsFor(paymentId);
      const leg = await routing().findTargetPayment(paymentId);
      const isCharged = operations.includes('capture') || operations.includes('settle');
      expect([isCharged, operations.includes('routing_loss')]).not.toEqual([true, true]);
      expect(leg).toMatchObject({ buyerCharged: isCharged, lossBooked: operations.includes('routing_loss') });
      charged += isCharged ? 1n : 0n;
      lost += operations.includes('routing_loss') ? 1n : 0n;
    }
    // A verified payment never leaves a loss, so its settlement always books
    for (const paymentId of onChain)
      expect(await transactionsFor(paymentId)).toEqual(['settle']);
    const moved = await movedSince(before);
    expect(moved[ledgerAccountIds.routingFees] ?? 0n).toBe(charged * 100n);
    expect(moved[ledgerAccountIds.routingLosses] ?? 0n).toBe(-lost * targetPrice);
    expect(await unbalancedTransactions()).toEqual([]);
    expect(await negativeBalances()).toEqual([]);
  });
});

describe('treasury transfers', () => {
  it('books a rebalancing with its conversion cost, once per reference', async () => {
    const reference = `rebalance-${(counter += 1)}`;
    const before = await platformBalances();
    // $10 of Base USDC became $9.99 of Solana USDC
    const input = { reference, from: { asset: 'base-usdc', amount: usd('10') }, to: { asset: 'solana-usdc', amount: usd('9.99') }, requestId: 'req-rebalance' };

    const first = await ledger.treasuryTransfer(input);
    clock.advance(1_000);
    const again = await ledger.treasuryTransfer(input);

    expect(first).toEqual({ transactionId: expect.any(String), createdAt: new Date(noon), replayed: false });
    expect(again).toEqual({ ...first, replayed: true });
    expect(await entriesOf(reference, 'treasury_transfer')).toEqual([
      { account: treasuryOf('solana-usdc'), amount: -usd('9.99') },
      { account: ledgerAccountIds.conversion, amount: -usd('0.01') },
      { account: treasuryOf('base-usdc'), amount: usd('10') },
    ]);
    expect(await movedSince(before)).toEqual({
      [treasuryOf('base-usdc')]: usd('10'), [treasuryOf('solana-usdc')]: -usd('9.99'), [ledgerAccountIds.conversion]: -usd('0.01'),
    });
    expect(await transactionsFor(reference)).toEqual(['treasury_transfer']);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it.each([
    ['ten times the amounts', { from: { asset: 'base-usdc', amount: usd('100') }, to: { asset: 'solana-usdc', amount: usd('99.9') } }],
    ['another amount sent', { from: { asset: 'base-usdc', amount: usd('10.01') }, to: { asset: 'solana-usdc', amount: usd('9.99') } }],
    ['another amount received', { from: { asset: 'base-usdc', amount: usd('10') }, to: { asset: 'solana-usdc', amount: usd('9.98') } }],
    ['another asset sent', { from: { asset: 'tempo-pathusd', amount: usd('10') }, to: { asset: 'solana-usdc', amount: usd('9.99') } }],
    ['another asset received', { from: { asset: 'base-usdc', amount: usd('10') }, to: { asset: 'tempo-pathusd', amount: usd('9.99') } }],
    ['the assets swapped', { from: { asset: 'solana-usdc', amount: usd('10') }, to: { asset: 'base-usdc', amount: usd('9.99') } }],
  ] as const)('refuses a reference reused for %s, and books nothing', async (_case, reuse) => {
    const reference = `rebalance-${(counter += 1)}`;
    const first = await ledger.treasuryTransfer({ reference, from: { asset: 'base-usdc', amount: usd('10') }, to: { asset: 'solana-usdc', amount: usd('9.99') } });
    const entries = await entriesOf(reference, 'treasury_transfer');
    const before = await platformBalances();

    expect(await thrown(ledger.treasuryTransfer({ reference, ...reuse }))).toBeInstanceOf(TreasuryTransferReferenceConflictError);
    expect(await movedSince(before)).toEqual({});
    expect(await entriesOf(reference, 'treasury_transfer')).toEqual(entries);
    expect(await transactionsFor(reference)).toEqual(['treasury_transfer']);
    // The first transfer, asked again, is still a replay
    expect(await ledger.treasuryTransfer({ reference, from: { asset: 'base-usdc', amount: usd('10') }, to: { asset: 'solana-usdc', amount: usd('9.99') } }))
      .toEqual({ ...first, replayed: true });
  });

  it('books a transfer that lost nothing without a conversion entry', async () => {
    const reference = `rebalance-${(counter += 1)}`;
    const before = await platformBalances();

    await ledger.treasuryTransfer({ reference, from: { asset: 'solana-usdc', amount: usd('5') }, to: { asset: 'base-usdc', amount: usd('5') } });

    expect(await entriesOf(reference, 'treasury_transfer')).toHaveLength(2);
    expect(await movedSince(before)).toEqual({ [treasuryOf('solana-usdc')]: usd('5'), [treasuryOf('base-usdc')]: -usd('5') });
  });

  it.each([
    ['nothing sent', 0n, 0n],
    ['nothing received', usd('1'), 0n],
    ['a negative amount', -usd('1'), -usd('1')],
    ['a gain', usd('1'), usd('1.000001')],
  ] as const)('refuses a transfer with %s, and moves nothing', async (_case, from, to) => {
    const reference = `rebalance-${(counter += 1)}`;
    const before = await platformBalances();

    const error = await thrown(ledger.treasuryTransfer({ reference, from: { asset: 'base-usdc', amount: from }, to: { asset: 'solana-usdc', amount: to } }));

    expect(error).toBeInstanceOf(RangeError);
    expect(await transactionsFor(reference)).toEqual([]);
    expect(await movedSince(before)).toEqual({});
  });
});

describe('the platform accounts', () => {
  it('keeps every routed call\'s money balanced under concurrent captures, settlements, losses and transfers, with no deadlock', async () => {
    const buyers = [await newBuyer('1'), await newBuyer('1'), await newBuyer('1')];
    const held = await Promise.all(buyers.flatMap(buyer => Array.from({ length: 5 }, async () => {
      const result = await hold(buyer, quote);
      if (!result.ok)
        throw new Error(result.refusal);
      await recordTargetLeg(result.payment.id, targetPrice, result.payment.id.length % 2 === 0 ? 'base-usdc' : 'solana-usdc');

      return result.payment.id;
    })));
    const payments = createPaymentRepository({ db: database.db, clock });
    const verified = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const created = await payments.create({ ...onChainPayment(quote, { asset: index % 2 === 0 ? 'base-usdc' : 'solana-usdc' }), status: 'verified' });
      await recordTargetLeg(created.id, targetPrice, index % 3 === 0 ? 'solana-usdc' : 'base-usdc');

      return { id: created.id, asset: index % 2 === 0 ? 'base-usdc' : 'solana-usdc' };
    }));
    // Targets that kept our payment while the buyer's settlement failed
    const lost = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const created = await payments.create({ ...onChainPayment(quote, { asset: 'base-usdc' }), status: 'verified' });
      await recordTargetLeg(created.id, targetPrice, index % 2 === 0 ? 'base-usdc' : 'solana-usdc');
      await legTo('settled')(created.id);
      await payments.changeStatus({ paymentId: created.id, to: 'failed' });

      return created.id;
    }));
    const before = await platformBalances();

    // A loss asked for a payment being captured is refused, whichever runs first
    const racing = Promise.allSettled(held.slice(0, 5).map(paymentId => ledger.routingLoss({ paymentId })));
    await Promise.all([
      ...held.map(paymentId => ledger.capture({ paymentId })),
      ...lost.flatMap(paymentId => [ledger.routingLoss({ paymentId }), ledger.routingLoss({ paymentId })]),
      ...verified.map(({ id, asset }) => ledger.settle({ paymentId: id, asset, transactionHash: undefined, receipt: undefined, needsReview: false })),
      ...Array.from({ length: 3 }, (_, index) => ledger.treasuryTransfer({
        reference: `concurrent-rebalance-${counter}-${index}`, from: { asset: 'base-usdc', amount: usd('1') }, to: { asset: 'solana-usdc', amount: usd('0.999') },
      })),
    ]);

    expect((await racing).map(result => result.status)).toEqual(Array.from({ length: 5 }, () => 'rejected'));

    const moved = await movedSince(before);
    // 21 calls at a fee of $0.0001 each, and 4 losses of $0.001 each
    expect(moved[ledgerAccountIds.routingFees]).toBe(21n * 100n);
    expect(moved[ledgerAccountIds.routingLosses]).toBe(-4n * targetPrice);
    for (const paymentId of lost)
      expect(await transactionsFor(paymentId)).toEqual(['routing_loss']);
    expect(moved[ledgerAccountIds.conversion]).toBe(-3n * usd('0.001'));
    // Settlements and transfers move money between platform accounts; captures bring in what the holds moved
    expect(Object.values(moved).reduce((sum, amount) => sum + amount, 0n)).toBe(15n * quote);
    for (const buyer of buyers)
      expect(await ledger.balance(buyer.accountId)).toEqual({ available: usd('1') - 5n * quote, held: 0n });
    const drifted = (await database.db.execute(sql`
      select b.ledger_account_id from balances b left join ledger_entries e on e.ledger_account_id = b.ledger_account_id
      group by b.ledger_account_id, b.balance having b.balance <> coalesce(sum(e.amount), 0)
    `)).rows;
    expect(drifted).toEqual([]);
    expect(await negativeBalances()).toEqual([]);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it('lets the treasuries, conversion and routing losses go negative, never the routing fees, and ends with every transaction summing to zero', async () => {
    const { rows } = await database.db.execute<{ id: string; type: string; may_go_negative: boolean }>(sql`
      select a.id, a.type, b.may_go_negative from ledger_accounts a join balances b on b.ledger_account_id = a.id
      where a.account_id is null order by a.id
    `);

    expect(rows).toEqual(expect.arrayContaining([
      { id: ledgerAccountIds.conversion, type: 'conversion', may_go_negative: true },
      { id: ledgerAccountIds.routingFees, type: 'routing_fees', may_go_negative: false },
      { id: ledgerAccountIds.routingLosses, type: 'routing_losses', may_go_negative: true },
      { id: treasuryOf('base-usdc'), type: 'treasury:base-usdc', may_go_negative: true },
      { id: treasuryOf('solana-usdc'), type: 'treasury:solana-usdc', may_go_negative: true },
    ]));
    expect(rows.filter(row => !row.may_go_negative).map(row => row.id)).toEqual([ledgerAccountIds.routingFees]);
    expect(await constraintOf(database.db.update(balances).set({ balance: -1n }).where(sql`${balances.ledgerAccountId} = ${ledgerAccountIds.routingFees}`)))
      .toBe('balances_not_negative_check');
    expect(await negativeBalances()).toEqual([]);
    expect(await unbalancedTransactions()).toEqual([]);
  });
});
