import { fixtureDay, fixtureTime } from '@anyfare/testing';

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseUsd, Secret } from '@anyfare/common';
import {
  CreditReferenceConflictError, hashApiKey, HoldReferenceConflictError, InvalidPaymentStatusChangeError, PaymentFinalizedError, utcDay,
  type HoldInput, type NewPayment, type PaymentStatus,
} from '@anyfare/core';
import { createFakeClock, createFakeIdGenerator, createTestDatabase, type FakeClock, type TestDatabase } from '@anyfare/testing';

import {
  balances, createAccountRepository, createLedger, createPaymentKeyRepository, createPaymentRepository, ledgerAccountIds, ledgerAccounts, type Ledger,
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
