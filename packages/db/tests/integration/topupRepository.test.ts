import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { randomIdGenerator } from '@anyfare/common';
import { createFakeClock, createTestDatabase, type FakeClock, type TestDatabase } from '@anyfare/testing';

import {
  createAccountRepository, createLedger, createTopupRepository, topups, type NewTopup, type Topup, type TopupPoll, type TopupQuote,
  type TopupRepository,
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

describe('the status job\'s changes', () => {
  // Days after the other tests' rows, so their due polls sort first
  const later = '2026-11-20T12:00:00.000Z';

  /** A waiting top-up, due at `nextPollAt`. */
  const waiting = async (accountId: string, nextPollAt = new Date(later)): Promise<Topup> => {
    const { id } = await repository.create(newTopup(accountId));

    return (await repository.markQuoted(id, quote({ nextPollAt })))!;
  };

  const poll = (changes: Partial<TopupPoll> = {}): TopupPoll => ({
    oneClickStatus: 'PROCESSING', lastStatus: { status: 'PROCESSING', correlationId: 'corr-poll' }, polledAt: clock.now(), ...changes,
  });

  // Books 2 USDC for the top-up on the transaction it is given
  const bookFor = (topup: Topup) => {
    const calls: string[] = [];
    const book = async (tx: Parameters<Parameters<TopupRepository['markCredited']>[0]['book']>[0]) => {
      calls.push(topup.id);
      return createLedger({ db: tx, clock, ids: randomIdGenerator }).topUp({ accountId: topup.accountId, asset: 'near-usdc', amount: 1_998_000n, reference: topup.depositAddress! });
    };

    return { calls, book };
  };

  const creditOf = () => ({
    poll: poll({ oneClickStatus: 'SUCCESS', depositedAmount: 2_000_000n, originTxHashes: ['0xorigin'] }), creditedAmount: 1_998_000n, deliveryTxHash: 'near-delivery',
    refundedAmount: undefined,
  });

  it('lists the top-ups due at a time, soonest first, and none whose polling stopped or isn\'t due yet', async () => {
    clock.set(later);
    const accountId = await newAccount();
    const second = await waiting(accountId, new Date('2026-11-20T11:59:00.000Z'));
    const first = await waiting(accountId, new Date('2026-11-20T11:58:00.000Z'));
    const due = await waiting(accountId, new Date(later));
    const notYet = await waiting(accountId, new Date('2026-11-20T12:00:01.000Z'));
    const stopped = await waiting(accountId, new Date('2026-11-20T11:00:00.000Z'));
    await repository.markExpired(stopped.id, 'waiting', poll({ oneClickStatus: 'PENDING_DEPOSIT' }));

    const listed = (await repository.listDue({ now: clock.now(), limit: 1_000 })).filter(topup => topup.accountId === accountId);
    const firstPage = await repository.listDue({ now: clock.now(), limit: 2 });

    expect(listed.map(topup => topup.id)).toEqual([first.id, second.id, due.id]);
    expect(listed.map(topup => topup.id)).not.toContain(notYet.id);
    expect(firstPage).toHaveLength(2);
    expect(firstPage[0]!.nextPollAt!.getTime()).toBeLessThanOrEqual(firstPage[1]!.nextPollAt!.getTime());
  });

  it('claims a listed top-up once: its next poll moves forward, and a second claim from the same listing gets nothing', async () => {
    clock.set(later);
    const accountId = await newAccount();
    const listed = await waiting(accountId);
    clock.advance(1_000);
    const next = new Date('2026-11-20T12:00:11.000Z');

    const claimed = await repository.claimPoll({ id: listed.id, seenUpdatedAt: listed.updatedAt, nextPollAt: next });
    const again = await repository.claimPoll({ id: listed.id, seenUpdatedAt: listed.updatedAt, nextPollAt: next });

    expect(claimed).toEqual({ ...listed, nextPollAt: next, updatedAt: clock.now() });
    expect(again).toBeUndefined();
    expect(await repository.claimPoll({ id: 'top_missing', seenUpdatedAt: listed.updatedAt, nextPollAt: next })).toBeUndefined();

    // A top-up no longer polled can't be claimed
    const stopped = (await repository.markExpired(listed.id, 'waiting', poll()))!;
    expect(await repository.claimPoll({ id: stopped.id, seenUpdatedAt: stopped.updatedAt, nextPollAt: next })).toBeUndefined();
  });

  it('records a poll from the status it names: the answer, its amounts and hashes, and the next poll, keeping what an answer leaves out', async () => {
    clock.set(later);
    const accountId = await newAccount();
    const topup = await waiting(accountId);
    const next = new Date('2026-11-20T12:01:00.000Z');

    const processing = await repository.recordPoll(topup.id, 'waiting', {
      to: 'processing', poll: poll({ depositedAmount: 2_000_000n, originTxHashes: ['0xorigin'] }), nextPollAt: next,
    });
    clock.advance(60_000);
    const nextPoll = await repository.recordPoll(topup.id, 'processing', { to: 'processing', poll: poll({ oneClickStatus: 'PROCESSING' }), nextPollAt: new Date('2026-11-20T12:02:00.000Z') });

    expect(processing).toMatchObject({
      status: 'processing', oneClickStatus: 'PROCESSING', lastStatus: { status: 'PROCESSING', correlationId: 'corr-poll' }, lastPolledAt: new Date(later),
      depositedAmount: 2_000_000n, originTxHashes: ['0xorigin'], nextPollAt: next, needsReview: false,
    });
    expect(nextPoll).toMatchObject({ lastPolledAt: clock.now(), depositedAmount: 2_000_000n, originTxHashes: ['0xorigin'] });
    expect(await repository.recordPoll(topup.id, 'waiting', { to: 'waiting', poll: poll(), nextPollAt: next })).toBeUndefined();
  });

  it('marks a top-up credited with its ledger transaction in one transaction, once, and books nothing from another status', async () => {
    clock.set(later);
    const accountId = await newAccount();
    const topup = await waiting(accountId);
    const { calls, book } = bookFor(topup);
    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });

    const credited = await repository.markCredited({ id: topup.id, from: 'waiting', credit: { ...creditOf(), refundedAmount: 5_000n }, book });
    const again = await repository.markCredited({ id: topup.id, from: 'waiting', credit: creditOf(), book });

    expect(credited).toMatchObject({
      status: 'credited', oneClickStatus: 'SUCCESS', creditedAmount: 1_998_000n, ledgerTransactionId: expect.any(String), deliveryTxHash: 'near-delivery',
      refundedAmount: 5_000n, depositedAmount: 2_000_000n, originTxHashes: ['0xorigin'], nextPollAt: undefined,
    });
    expect(again).toBeUndefined();
    expect(calls).toEqual([topup.id]);
    expect(await ledger.balance(accountId)).toEqual({ available: 1_998_000n, held: 0n });
  });

  it('credits nothing for a top-up flagged for review, and rolls the booking back when the row can\'t be written', async () => {
    clock.set(later);
    const accountId = await newAccount();
    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
    const flagged = await waiting(accountId);
    await repository.flagForReview(flagged.id, 'waiting', { reason: 'oneclick_not_found' });
    const flaggedBook = bookFor(flagged);

    expect(await repository.markCredited({ id: flagged.id, from: 'waiting', credit: creditOf(), book: flaggedBook.book })).toBeUndefined();
    expect(flaggedBook.calls).toEqual([]);

    const topup = await waiting(accountId);
    const { book } = bookFor(topup);
    const failing = await repository.markCredited({
      id: topup.id, from: 'waiting', credit: creditOf(), book: async tx => {
        await book(tx);
        throw new Error('The write after the booking failed');
      },
    }).then(() => undefined, (error: unknown) => error as Error);

    expect(failing?.message).toBe('The write after the booking failed');
    expect(await repository.find(topup.id)).toMatchObject({ status: 'waiting', creditedAmount: undefined, ledgerTransactionId: undefined });
    expect(await ledger.balance(accountId)).toEqual({ available: 0n, held: 0n });
  });

  it('lets one of two concurrent credits through, booking once', async () => {
    clock.set(later);
    const accountId = await newAccount();
    const topup = await waiting(accountId);
    const { calls, book } = bookFor(topup);

    const results = await Promise.all([1, 2].map(() => repository.markCredited({ id: topup.id, from: 'waiting', credit: creditOf(), book })));

    expect(results.filter(result => result !== undefined)).toHaveLength(1);
    expect(calls).toEqual([topup.id]);
    expect(await createLedger({ db: database.db, clock, ids: randomIdGenerator }).balance(accountId)).toEqual({ available: 1_998_000n, held: 0n });
  });

  it('marks a top-up refunded, failed, or expired for good, each stopping its polling, only from the status it names', async () => {
    clock.set(later);
    const accountId = await newAccount();
    const [refunded, failed, expired] = [await waiting(accountId), await waiting(accountId), await waiting(accountId)];

    expect(await repository.markRefunded(refunded.id, 'waiting', {
      poll: poll({ oneClickStatus: 'REFUNDED', originTxHashes: ['0xorigin'] }), refundedAmount: 2_000_000n, refundReason: 'Deadline passed', refundTxHash: 'near-refund',
    })).toMatchObject({
      status: 'refunded', oneClickStatus: 'REFUNDED', refundedAmount: 2_000_000n, refundReason: 'Deadline passed', refundTxHash: 'near-refund', originTxHashes: ['0xorigin'],
      nextPollAt: undefined, needsReview: false,
    });
    expect(await repository.markFailed(failed.id, 'waiting', { poll: poll({ oneClickStatus: 'FAILED' }), reason: 'oneclick_failed' })).toMatchObject({
      status: 'failed', oneClickStatus: 'FAILED', needsReview: true, reviewReason: 'oneclick_failed', nextPollAt: undefined,
    });
    expect(await repository.markExpired(expired.id, 'waiting', poll({ oneClickStatus: 'PENDING_DEPOSIT' }))).toMatchObject({
      status: 'expired', oneClickStatus: 'PENDING_DEPOSIT', needsReview: false, nextPollAt: undefined,
    });

    for (const topup of [refunded, failed, expired]) {
      expect(await repository.markRefunded(topup.id, 'waiting', { poll: poll(), refundedAmount: undefined, refundReason: undefined, refundTxHash: undefined })).toBeUndefined();
      expect(await repository.markFailed(topup.id, 'waiting', { poll: poll(), reason: 'late' })).toBeUndefined();
      expect(await repository.markExpired(topup.id, 'waiting', poll())).toBeUndefined();
    }
  });

  it('flags a top-up for review in its status, with the poll when there is one, and stops its polling', async () => {
    clock.set(later);
    const accountId = await newAccount();
    const [bare, polled] = [await waiting(accountId), await waiting(accountId)];

    expect(await repository.flagForReview(bare.id, 'waiting', { reason: 'polling_ended' })).toMatchObject({
      status: 'waiting', needsReview: true, reviewReason: 'polling_ended', nextPollAt: undefined, oneClickStatus: undefined, lastPolledAt: undefined,
    });
    expect(await repository.flagForReview(polled.id, 'waiting', { reason: 'recipient_mismatch', poll: poll({ oneClickStatus: 'SUCCESS' }) })).toMatchObject({
      status: 'waiting', needsReview: true, reviewReason: 'recipient_mismatch', nextPollAt: undefined, oneClickStatus: 'SUCCESS', lastPolledAt: clock.now(),
    });
    expect(await repository.flagForReview(bare.id, 'processing', { reason: 'late' })).toBeUndefined();
    expect(await repository.find(bare.id)).toMatchObject({ reviewReason: 'polling_ended' });
  });
});
