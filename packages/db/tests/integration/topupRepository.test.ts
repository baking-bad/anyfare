import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createFakeClock, createTestDatabase, type FakeClock, type TestDatabase } from '@anyfare/testing';

import {
  createAccountRepository, createTopupRepository, topups, type NewTopup, type TopupQuote, type TopupRepository,
} from '../../src/index.js';

let database: TestDatabase;
let clock: FakeClock;
let repository: TopupRepository;
let counter = 0;
const start = '2026-11-09T12:00:00.000Z';

beforeAll(async () => {
  database = await createTestDatabase();
  clock = createFakeClock(start);
  repository = createTopupRepository({ db: database.db, clock });
});

afterEach(() => {
  clock.set(start);
});

afterAll(async () => {
  await database?.drop();
});

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

const newAccount = async (): Promise<string> => {
  counter += 1;
  const id = `acc_topup_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id, createdAt: clock.now() });

  return id;
};

const quoteRequest = {
  dry: false,
  swapType: 'FLEX_INPUT',
  slippageTolerance: 100,
  originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'nep141:usdc.anyfare.testnet',
  amount: '2000000',
  refundTo: 'treasury.anyfare.testnet',
  refundType: 'INTENTS',
  recipient: 'treasury.anyfare.testnet',
  recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-11-10T12:00:00.000Z',
};

// Two USDC on Base, asked for at noon with a day to pay
const newTopup = (accountId: string, changes: Partial<NewTopup> = {}): NewTopup => {
  counter += 1;

  return {
    id: `top_${counter}`,
    accountId,
    requestId: `req-topup-${counter}`,
    network: 'base',
    blockchain: 'base',
    tokenSymbol: 'USDC',
    originAsset: quoteRequest.originAsset,
    tokenDecimals: 6,
    amount: 2_000_000n,
    destinationAsset: 'near-usdc',
    recipient: 'treasury.anyfare.testnet',
    refundTo: 'treasury.anyfare.testnet',
    payBy: new Date('2026-11-10T12:00:00.000Z'),
    quoteRequest,
    ...changes,
  };
};

const quote = (changes: Partial<TopupQuote> = {}): TopupQuote => {
  counter += 1;
  const depositAddress = `0x${counter.toString(16).padStart(40, '0')}`;

  return {
    quoteResponse: { correlationId: `corr-${counter}`, signature: 'ed25519:signature', quote: { depositAddress, amountIn: '2000000' } },
    correlationId: `corr-${counter}`,
    depositAddress,
    depositMemo: undefined,
    addressExpiresAt: new Date('2026-11-13T12:00:00.000Z'),
    sendAmount: 2_000_000n,
    sendAtLeast: 1_980_000n,
    estimatedCredits: 1_998_760n,
    nextPollAt: new Date('2026-11-09T12:00:10.000Z'),
    ...changes,
  };
};

describe('the topups repository', () => {
  it('creates a top-up as quoting, with nothing from a quote yet', async () => {
    const accountId = await newAccount();
    const input = newTopup(accountId);

    const created = await repository.create(input);

    expect(created).toEqual({
      ...input,
      status: 'quoting',
      quoteResponse: undefined,
      correlationId: undefined,
      depositAddress: undefined,
      depositMemo: undefined,
      addressExpiresAt: undefined,
      sendAmount: undefined,
      sendAtLeast: undefined,
      estimatedCredits: undefined,
      quoteError: undefined,
      oneClickStatus: undefined,
      lastStatus: undefined,
      depositedAmount: undefined,
      creditedAmount: undefined,
      ledgerTransactionId: undefined,
      deliveryTxHash: undefined,
      refundedAmount: undefined,
      refundReason: undefined,
      refundTxHash: undefined,
      originTxHashes: [],
      needsReview: false,
      reviewReason: undefined,
      nextPollAt: undefined,
      lastPolledAt: undefined,
      createdAt: new Date(start),
      updatedAt: new Date(start),
    });
    expect(await repository.find(input.id)).toEqual(created);
  });

  it('keeps an atomic amount beyond a bigint\'s range exactly', async () => {
    const accountId = await newAccount();
    const amount = 10n ** 30n + 7n;

    const created = await repository.create(newTopup(accountId, { tokenSymbol: 'ETH', tokenDecimals: 18, amount }));

    expect((await repository.find(created.id))?.amount).toBe(amount);
  });

  it('moves a quoting top-up to waiting with its quote, once', async () => {
    const accountId = await newAccount();
    const { id } = await repository.create(newTopup(accountId));
    const answered = quote({ depositMemo: '123456789' });
    clock.advance(1_500);

    const quoted = await repository.markQuoted(id, answered);
    clock.advance(1_000);
    const again = await repository.markQuoted(id, quote());

    expect(quoted).toMatchObject({
      id,
      status: 'waiting',
      quoteResponse: answered.quoteResponse,
      correlationId: answered.correlationId,
      depositAddress: answered.depositAddress,
      depositMemo: '123456789',
      addressExpiresAt: answered.addressExpiresAt,
      sendAmount: 2_000_000n,
      sendAtLeast: 1_980_000n,
      estimatedCredits: 1_998_760n,
      nextPollAt: answered.nextPollAt,
      quoteError: undefined,
      createdAt: new Date(start),
      updatedAt: new Date('2026-11-09T12:00:01.500Z'),
    });
    expect(again).toBeUndefined();
    expect(await repository.find(id)).toEqual(quoted);
  });

  it('moves a quoting top-up to quote_failed with 1Click\'s message, or with our reason and the answer we refused', async () => {
    const accountId = await newAccount();
    const [refused, mismatched] = [await repository.create(newTopup(accountId)), await repository.create(newTopup(accountId))];
    const answer = { correlationId: 'corr-mismatch', quote: { depositAddress: '0xabc' } };

    const failed = await repository.markQuoteFailed(refused.id, { error: 'Amount is too low for bridge, try at least 150000' });
    const refusedAnswer = await repository.markQuoteFailed(mismatched.id, { error: 'The quote names another recipient', quoteResponse: answer, correlationId: 'corr-mismatch' });

    expect(failed).toMatchObject({ status: 'quote_failed', quoteError: 'Amount is too low for bridge, try at least 150000', quoteResponse: undefined, depositAddress: undefined });
    expect(refusedAnswer).toMatchObject({ status: 'quote_failed', quoteError: 'The quote names another recipient', quoteResponse: answer, correlationId: 'corr-mismatch', depositAddress: undefined });
  });

  it('moves a quoting top-up to quote_unknown with our reason', async () => {
    const accountId = await newAccount();
    const { id } = await repository.create(newTopup(accountId));

    expect(await repository.markQuoteUnknown(id, 'timeout')).toMatchObject({ status: 'quote_unknown', quoteError: 'timeout', nextPollAt: undefined });
  });

  it('changes nothing from a status other than quoting, and for a top-up that doesn\'t exist', async () => {
    const accountId = await newAccount();
    const [waiting, failed, unknown] = [await repository.create(newTopup(accountId)), await repository.create(newTopup(accountId)), await repository.create(newTopup(accountId))];
    await repository.markQuoted(waiting.id, quote());
    await repository.markQuoteFailed(failed.id, { error: 'refused' });
    await repository.markQuoteUnknown(unknown.id, 'timeout');
    const before = await Promise.all([waiting, failed, unknown].map(topup => repository.find(topup.id)));
    clock.advance(60_000);

    for (const topup of [waiting, failed, unknown]) {
      expect(await repository.markQuoted(topup.id, quote())).toBeUndefined();
      expect(await repository.markQuoteFailed(topup.id, { error: 'late' })).toBeUndefined();
      expect(await repository.markQuoteUnknown(topup.id, 'late')).toBeUndefined();
    }
    expect(await repository.markQuoted('top_missing', quote())).toBeUndefined();
    expect(await repository.markQuoteUnknown('top_missing', 'timeout')).toBeUndefined();
    expect(await Promise.all([waiting, failed, unknown].map(topup => repository.find(topup.id)))).toEqual(before);
  });

  it('lists top-ups still quoting from before a time, oldest first, which can then be marked quote_unknown', async () => {
    const accountId = await newAccount();
    // Earlier tests left rows quoting at noon, so these start later
    clock.set('2026-11-09T13:00:00.000Z');
    const oldest = await repository.create(newTopup(accountId));
    clock.advance(60_000);
    const older = await repository.create(newTopup(accountId));
    clock.advance(60_000);
    const quoted = await repository.create(newTopup(accountId));
    await repository.markQuoted(quoted.id, quote());
    clock.advance(9 * 60_000);
    const recent = await repository.create(newTopup(accountId));
    const before = new Date(clock.now().getTime() - 5 * 60_000);

    const stuck = (await repository.listStuckQuoting({ before, limit: 1_000 })).filter(topup => topup.accountId === accountId);
    const firstPage = await repository.listStuckQuoting({ before, limit: 1 });

    expect(stuck.map(topup => topup.id)).toEqual([oldest.id, older.id]);
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]!.createdAt.getTime()).toBeLessThanOrEqual(oldest.createdAt.getTime());
    expect(await repository.markQuoteUnknown(oldest.id, 'not_recorded')).toMatchObject({ status: 'quote_unknown', quoteError: 'not_recorded' });
    expect((await repository.listStuckQuoting({ before, limit: 1_000 })).map(topup => topup.id)).not.toContain(oldest.id);
    expect((await repository.listStuckQuoting({ before: clock.now(), limit: 1_000 })).map(topup => topup.id)).not.toContain(recent.id);
  });

  it('lets one of two concurrent changes from quoting through', async () => {
    const accountId = await newAccount();
    const { id } = await repository.create(newTopup(accountId));

    const [quoted, unknown] = await Promise.all([repository.markQuoted(id, quote()), repository.markQuoteUnknown(id, 'timeout')]);

    expect([quoted, unknown].filter(result => result !== undefined)).toHaveLength(1);
  });

  it('finds an account\'s own top-up, and nothing for another account or an unknown ID', async () => {
    const [owner, other] = [await newAccount(), await newAccount()];
    const created = await repository.create(newTopup(owner));

    expect(await repository.findForAccount(created.id, owner)).toEqual(created);
    expect(await repository.findForAccount(created.id, other)).toBeUndefined();
    expect(await repository.findForAccount('top_missing', owner)).toBeUndefined();
    expect(await repository.find('top_missing')).toBeUndefined();
  });

  it('refuses a deposit address that another top-up already has', async () => {
    const accountId = await newAccount();
    const [first, second] = [await repository.create(newTopup(accountId)), await repository.create(newTopup(accountId))];
    const answered = quote();
    await repository.markQuoted(first.id, answered);

    expect(await constraintOf(repository.markQuoted(second.id, { ...quote(), depositAddress: answered.depositAddress }))).toBe('topups_deposit_address_idx');
    expect(await repository.find(second.id)).toMatchObject({ status: 'quoting', depositAddress: undefined });
  });

  it('refuses, in the database, an unknown status, a waiting top-up without an address, and an amount of zero', async () => {
    const accountId = await newAccount();
    const { id } = await repository.create(newTopup(accountId));

    expect(await constraintOf(database.db.update(topups).set({ status: 'lost' as never, depositAddress: '0xlost' }).where(eq(topups.id, id)))).toBe('topups_status_check');
    expect(await constraintOf(database.db.update(topups).set({ status: 'waiting' }).where(eq(topups.id, id)))).toBe('topups_deposit_address_check');
    expect(await constraintOf(repository.create(newTopup(accountId, { amount: 0n })))).toBe('topups_amount_check');
    expect(await constraintOf(repository.create(newTopup('acc_missing')))).toBe('topups_account_id_accounts_id_fk');
  });
});
