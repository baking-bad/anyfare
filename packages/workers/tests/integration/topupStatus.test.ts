import { Registry } from '@prometheus-io/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, type MicroUsd } from '@anyfare/common';
import { loadPlatformConfig, type JsonObject, type PlatformConfig } from '@anyfare/core';
import {
  createAccountRepository, createLedger, createTopupRepository, ledgerAccountIds, ledgerTransactions, topups, type Ledger, type Topup, type TopupRepository,
} from '@anyfare/db';
import {
  createFakeClock, createTestDatabase, defaultOneClickTokens, startFakeOneClick, type FakeClock, type FakeOneClick, type TestDatabase,
} from '@anyfare/testing';
import { buildQuoteRequest, createOneClickClient, type OneClickClient, type OneClickQuoteRequest } from '@anyfare/topups';

import {
  createTopupStatus, createTopupStatusMetrics, nextPollAt, pollingEndsAt, TopupStatusFailedError, type TopupStatusOptions,
} from '../../src/topupStatus.js';

const noon = '2026-11-09T12:00:00.000Z';
const minuteMs = 60_000;
const baseUsdc = defaultOneClickTokens.find(token => token.blockchain === 'base' && token.symbol === 'USDC')!;
// What the fake delivers for 1 USDC on Base: its USD value less 1 basis point, in USDC on NEAR
const amountOut = 999_380n;
const nearTreasury = ledgerAccountIds.treasury('near-usdc');

const logs: Record<string, unknown>[] = [];
const logger = createLogger({ level: 'debug' }, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });

let database: TestDatabase;
let clock: FakeClock;
let oneClick: FakeOneClick;
let client: OneClickClient;
let config: PlatformConfig;
let repository: TopupRepository;
let ledger: Ledger;
let counter = 0;

beforeAll(async () => {
  clock = createFakeClock(noon);
  [database, oneClick] = await Promise.all([createTestDatabase(), startFakeOneClick({ now: clock.now })]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({ topups: { enabled: true, url: oneClick.url } })).toString('base64'),
    },
  });
  client = createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 });
  repository = createTopupRepository({ db: database.db, clock });
  ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
});

beforeEach(() => {
  clock.set(noon);
  logs.length = 0;
});

afterEach(async () => {
  oneClick.reset();
  // Each test polls its own top-ups only
  await database.db.delete(topups);
});

afterAll(async () => {
  await oneClick?.close();
  await database?.drop();
});

const newAccount = async (): Promise<string> => {
  counter += 1;
  const id = `acc_status_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id, createdAt: clock.now() });

  return id;
};

/** A top-up still asking for its quote, as the API records it before the real quote. */
const newQuoting = async (accountId?: string): Promise<{ readonly id: string; readonly request: OneClickQuoteRequest & { readonly dry: false } }> => {
  const owner = accountId ?? await newAccount();
  counter += 1;
  const id = `top_status_${counter}`;
  const request = buildQuoteRequest({ topups: config.topups, token: baseUsdc, amount: 1_000_000n, now: clock.now(), dry: false });
  await repository.create({
    id, accountId: owner, requestId: `req-status-${counter}`, network: 'base', blockchain: 'base', tokenSymbol: 'USDC', originAsset: baseUsdc.assetId, tokenDecimals: 6,
    amount: 1_000_000n, destinationAsset: 'near-usdc', recipient: request.recipient, refundTo: request.refundTo, payBy: new Date(request.deadline),
    quoteRequest: JSON.parse(JSON.stringify(request)) as JsonObject,
  });

  return { id, request };
};

/** 1 USDC on Base, waiting for its transfer, with its real quote in the fake: as the API makes it at the clock's time. */
const newTopup = async (): Promise<Topup> => {
  const { id, request } = await newQuoting();
  const answer = await client.quote(request);
  const quoted = await repository.markQuoted(id, {
    quoteResponse: answer.raw as JsonObject,
    correlationId: answer.correlationId,
    depositAddress: answer.quote.depositAddress,
    depositMemo: answer.quote.depositMemo,
    addressExpiresAt: new Date(answer.quote.deadline),
    sendAmount: BigInt(answer.quote.amountIn),
    sendAtLeast: BigInt(answer.quote.minAmountIn),
    estimatedCredits: BigInt(answer.quote.amountOut) as MicroUsd,
    nextPollAt: new Date(clock.now().getTime() + 10_000),
  });

  return quoted!;
};

const job = (changes: Partial<TopupStatusOptions> = {}) => createTopupStatus({
  topups: repository,
  ledger: db => createLedger({ db, clock, ids: randomIdGenerator }),
  oneClick: client,
  config,
  metrics: createTopupStatusMetrics(new Registry()),
  clock,
  logger,
  ...changes,
});

const run = (changes: Partial<TopupStatusOptions> = {}) => job(changes)();

const find = async (id: string): Promise<Topup> => (await repository.find(id))!;
const linesOf = (message: string) => logs.filter(line => line['msg'] === message);
const topUpTransactions = async (reference: string) =>
  (await database.db.select().from(ledgerTransactions)).filter(transaction => transaction.operation === 'top_up' && transaction.reference === reference);
const treasuryBalance = async (): Promise<bigint> => (await ledger.balancesOf([nearTreasury])).get(nearTreasury) ?? 0n;

interface StatusBody {
  readonly [field: string]: unknown;
  readonly quoteResponse: { readonly quote: Record<string, unknown>; readonly quoteRequest: Record<string, unknown> };
  readonly swapDetails: Record<string, unknown>;
}

// The fake's status body for an address, as 1Click answers it, to change in a script
const statusBody = async (depositAddress: string): Promise<StatusBody> =>
  await (await fetch(`${oneClick.url}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`)).json() as StatusBody;

// The fake answers this body for every status
const answerStatus = (body: unknown): void => oneClick.handle('/v0/status', () => ({ status: 200, body }));

describe('a top-up 1Click waits for', () => {
  it('stays waiting with its next poll scheduled, expires past its pay-by time and is still polled, and stops once its address is inactive', async () => {
    const topup = await newTopup();

    // Not due yet
    expect(await run()).toMatchObject({ polled: 0 });
    clock.advance(10_000);
    expect(await run()).toEqual({
      polled: 1, credited: 0, refunded: 0, failed: 0, expired: 0, review: 0, unclear: 0, unavailable: 0, rejected: 0, stuck: 0, errors: 0,
    });
    expect(await find(topup.id)).toMatchObject({
      status: 'waiting', oneClickStatus: 'PENDING_DEPOSIT', lastStatus: expect.objectContaining({ status: 'PENDING_DEPOSIT' }), lastPolledAt: clock.now(),
      nextPollAt: new Date(clock.now().getTime() + 10_000), needsReview: false,
    });

    clock.set(new Date(topup.payBy.getTime() + 1_000));
    expect(await run()).toMatchObject({ polled: 1, expired: 1 });
    expect(await find(topup.id)).toMatchObject({ status: 'expired', nextPollAt: new Date(clock.now().getTime() + 5 * minuteMs) });
    expect(linesOf('A top-up expired')).toEqual([expect.objectContaining({
      level: 30, topupId: topup.id, accountId: topup.accountId, depositAddress: topup.depositAddress, payBy: topup.payBy.toISOString(), final: false,
    })]);

    // Still polled: 1Click refunds a deposit that comes after the pay-by time
    clock.advance(5 * minuteMs);
    expect(await run()).toMatchObject({ polled: 1, expired: 0 });
    expect(await find(topup.id)).toMatchObject({ status: 'expired', nextPollAt: new Date(clock.now().getTime() + 5 * minuteMs) });

    clock.set(new Date(topup.addressExpiresAt!.getTime() + 1_000));
    expect(await run()).toMatchObject({ polled: 1, expired: 0 });
    expect(await find(topup.id)).toMatchObject({ status: 'expired', nextPollAt: undefined, needsReview: false });
    clock.advance(24 * 60 * minuteMs);
    expect(await run()).toMatchObject({ polled: 0 });
    expect(linesOf('A top-up expired')).toHaveLength(1);
  });

  it('keeps polling past the address\'s end when 1Click knows a deposit, and flags it for review when the window ends', async () => {
    const topup = await newTopup();
    oneClick.setStatus(topup.depositAddress!, 'KNOWN_DEPOSIT_TX');

    clock.set(new Date(topup.addressExpiresAt!.getTime() + 1_000));
    expect(await run()).toMatchObject({ polled: 1, expired: 1, review: 0 });
    expect(await find(topup.id)).toMatchObject({
      status: 'expired', oneClickStatus: 'KNOWN_DEPOSIT_TX', needsReview: false, nextPollAt: new Date(clock.now().getTime() + 5 * minuteMs),
    });

    // 1Click going back to PENDING_DEPOSIT doesn't forget the deposit it saw
    oneClick.setStatus(topup.depositAddress!, 'PENDING_DEPOSIT');
    clock.advance(5 * minuteMs);
    expect(await run()).toMatchObject({ polled: 1, review: 0 });
    expect(await find(topup.id)).toMatchObject({ status: 'expired', needsReview: false, nextPollAt: new Date(clock.now().getTime() + 5 * minuteMs) });

    clock.set(pollingEndsAt(topup));
    expect(await run()).toMatchObject({ polled: 1, review: 1 });
    expect(await find(topup.id)).toMatchObject({ status: 'expired', needsReview: true, reviewReason: 'polling_ended', nextPollAt: undefined });
    expect(linesOf('A top-up needs review')).toEqual([expect.objectContaining({
      level: 50, topupId: topup.id, reason: 'polling_ended', detail: 'Polling ended without a final status', alert: true,
    })]);
  });

  it('flags a deposit 1Click is still processing when the window ends, and credits it if it completes before', async () => {
    const [stuck, late] = [await newTopup(), await newTopup()];
    oneClick.setStatus(stuck.depositAddress!, 'PROCESSING');
    oneClick.setStatus(late.depositAddress!, 'PROCESSING');
    clock.set(new Date(pollingEndsAt(stuck).getTime() - 5 * minuteMs));
    expect(await run()).toMatchObject({ polled: 2, review: 0 });

    oneClick.setStatus(late.depositAddress!, 'SUCCESS');
    clock.advance(5 * minuteMs);
    expect(await run()).toMatchObject({ polled: 2, review: 1, credited: 1 });

    expect(await find(stuck.id)).toMatchObject({ status: 'processing', needsReview: true, reviewReason: 'polling_ended', nextPollAt: undefined });
    expect(await find(late.id)).toMatchObject({ status: 'credited', needsReview: false });
  });

  it('records an incomplete deposit, then the deposit 1Click is processing with its transaction on the origin chain', async () => {
    const topup = await newTopup();
    const address = topup.depositAddress!;

    oneClick.setStatus(address, 'INCOMPLETE_DEPOSIT');
    clock.advance(10_000);
    await run();
    expect(await find(topup.id)).toMatchObject({ status: 'incomplete', oneClickStatus: 'INCOMPLETE_DEPOSIT', depositedAmount: 495_000n, nextPollAt: new Date(clock.now().getTime() + 10_000) });

    oneClick.setStatus(address, 'PROCESSING');
    const hashes = (await client.status({ depositAddress: address })).swapDetails.originChainTxHashes.map(transaction => transaction.hash);
    clock.advance(10_000);
    await run();
    expect(hashes).toHaveLength(1);
    expect(await find(topup.id)).toMatchObject({ status: 'processing', oneClickStatus: 'PROCESSING', depositedAmount: 1_000_000n, originTxHashes: hashes });
    expect(await topUpTransactions(address)).toEqual([]);
  });
});

describe('a top-up 1Click swapped', () => {
  it('is credited once: the account\'s balance up by the amount out, the treasury of the asset down by the same, in one top_up keyed by the deposit address', async () => {
    const topup = await newTopup();
    const address = topup.depositAddress!;
    const treasuryBefore = await treasuryBalance();
    oneClick.setStatus(address, 'SUCCESS');
    const delivery = (await client.status({ depositAddress: address })).swapDetails.destinationChainTxHashes[0]!.hash;
    const registry = new Registry();
    clock.advance(10_000);

    expect(await run({ metrics: createTopupStatusMetrics(registry) })).toMatchObject({ polled: 1, credited: 1, review: 0, errors: 0 });

    const [transaction, ...others] = await topUpTransactions(address);
    expect(others).toEqual([]);
    expect(await find(topup.id)).toMatchObject({
      status: 'credited', oneClickStatus: 'SUCCESS', creditedAmount: amountOut, ledgerTransactionId: transaction!.id, deliveryTxHash: delivery, depositedAmount: 1_000_000n,
      refundedAmount: undefined, nextPollAt: undefined, needsReview: false,
    });
    expect(await ledger.balance(topup.accountId)).toEqual({ available: amountOut, held: 0n });
    expect(await treasuryBalance()).toBe(treasuryBefore - amountOut);
    expect(linesOf('A top-up was credited')).toEqual([expect.objectContaining({
      level: 30, topupId: topup.id, accountId: topup.accountId, amount: '0.99938', network: 'base', token: 'USDC', depositAddress: address, transaction: delivery,
    })]);
    const text = await registry.metrics();
    expect(text).toMatch(/^workers_topups_credited_total 1$/m);
    expect(text).toMatch(/^workers_topups_credited_usd_total 0\.99938$/m);
    expect(text).toMatch(/^workers_topup_polls_total\{result="credited"\} 1$/m);

    // Nothing is due any more
    clock.advance(60 * minuteMs);
    expect(await run()).toMatchObject({ polled: 0, credited: 0 });
    expect(await topUpTransactions(address)).toHaveLength(1);
    expect(await ledger.balance(topup.accountId)).toEqual({ available: amountOut, held: 0n });
  });

  it('is credited once by two runs at once', async () => {
    const topup = await newTopup();
    oneClick.setStatus(topup.depositAddress!, 'SUCCESS');
    clock.advance(10_000);

    const results = await Promise.all([run(), run()]);

    expect(results.map(result => result.credited).sort()).toEqual([0, 1]);
    expect(await topUpTransactions(topup.depositAddress!)).toHaveLength(1);
    expect(await ledger.balance(topup.accountId)).toEqual({ available: amountOut, held: 0n });
  });

  it('is credited once when two runners both hold the SUCCESS answer at once', async () => {
    const topup = await newTopup();
    oneClick.setStatus(topup.depositAddress!, 'SUCCESS');
    clock.advance(10_000);
    // Both runners get past the claim, as if each had claimed it
    const bothClaim: TopupStatusOptions['topups'] = {
      ...repository,
      claimPoll: async input => await repository.claimPoll(input) ?? repository.find(input.id),
    };
    // 1Click's answers are held back until both runners asked, so both credit from the same answer
    let asked = 0;
    let releaseAnswers = (): void => undefined;
    const bothAsked = new Promise<void>(resolve => {
      releaseAnswers = resolve;
    });
    const heldBack: TopupStatusOptions['oneClick'] = {
      status: async query => {
        asked += 1;
        if (asked === 2)
          releaseAnswers();
        await bothAsked;
        return client.status(query);
      },
    };

    const results = await Promise.all([run({ topups: bothClaim, oneClick: heldBack }), run({ topups: bothClaim, oneClick: heldBack })]);

    expect(asked).toBe(2);
    expect(results.map(result => result.polled)).toEqual([1, 1]);
    expect(results.map(result => result.credited).sort()).toEqual([0, 1]);
    expect(await topUpTransactions(topup.depositAddress!)).toHaveLength(1);
    expect(await ledger.balance(topup.accountId)).toEqual({ available: amountOut, held: 0n });
    expect(await find(topup.id)).toMatchObject({ status: 'credited', creditedAmount: amountOut });
    expect(linesOf('A top-up was credited')).toHaveLength(1);
  });

  it('is never credited once another runner flagged it for review', async () => {
    const topup = await newTopup();
    oneClick.setStatus(topup.depositAddress!, 'SUCCESS');
    clock.advance(10_000);
    const flaggedMeanwhile: TopupStatusOptions['topups'] = {
      ...repository,
      markCredited: async input => {
        await repository.flagForReview(topup.id, topup.status, { reason: 'flagged_meanwhile' });
        return repository.markCredited(input);
      },
    };

    expect(await run({ topups: flaggedMeanwhile })).toMatchObject({ credited: 0 });

    expect(await find(topup.id)).toMatchObject({ status: 'waiting', needsReview: true, reviewReason: 'flagged_meanwhile', creditedAmount: undefined });
    expect(await topUpTransactions(topup.depositAddress!)).toEqual([]);
    expect(await ledger.balance(topup.accountId)).toEqual({ available: 0n, held: 0n });
  });

  it('adds nothing more when the ledger booked the same top-up before: the row takes that transaction', async () => {
    const topup = await newTopup();
    const booked = await ledger.topUp({ accountId: topup.accountId, asset: 'near-usdc', amount: amountOut, reference: topup.depositAddress! });
    oneClick.setStatus(topup.depositAddress!, 'SUCCESS');
    clock.advance(10_000);

    expect(await run()).toMatchObject({ credited: 1 });

    expect(await find(topup.id)).toMatchObject({ status: 'credited', ledgerTransactionId: booked.transactionId });
    expect(await topUpTransactions(topup.depositAddress!)).toHaveLength(1);
    expect(await ledger.balance(topup.accountId)).toEqual({ available: amountOut, held: 0n });
  });

  it('is flagged for review, with nothing more credited, when the ledger booked another amount under its deposit address', async () => {
    const topup = await newTopup();
    await ledger.topUp({ accountId: topup.accountId, asset: 'near-usdc', amount: 1_000n, reference: topup.depositAddress! });
    oneClick.setStatus(topup.depositAddress!, 'SUCCESS');
    clock.advance(10_000);

    expect(await run()).toMatchObject({ credited: 0, review: 1, errors: 0 });

    expect(await find(topup.id)).toMatchObject({ status: 'waiting', needsReview: true, reviewReason: 'ledger_reference_conflict', nextPollAt: undefined });
    expect(await ledger.balance(topup.accountId)).toEqual({ available: 1_000n, held: 0n });
  });

  it('records the excess 1Click returned, and credits the amount out', async () => {
    const topup = await newTopup();
    oneClick.setStatus(topup.depositAddress!, 'SUCCESS', { refundedAmount: '5000', refundedAmountFormatted: '0.005', refundedAmountUsd: '0.004997400000' });
    clock.advance(10_000);

    expect(await run()).toMatchObject({ credited: 1 });

    const credited = await find(topup.id);
    expect(credited).toMatchObject({ status: 'credited', creditedAmount: amountOut, refundedAmount: 5_000n });
    expect(await ledger.balance(topup.accountId)).toEqual({ available: amountOut, held: 0n });
    expect(linesOf('A top-up was credited')).toEqual([expect.objectContaining({ amount: '0.99938', refunded: '0.005' })]);
    expect(linesOf('A top-up\'s excess was refunded: return it by hand')).toEqual([expect.objectContaining({
      level: 40, topupId: topup.id, accountId: topup.accountId, refunded: '0.005', token: 'USDC', network: 'base', refundReason: null, refundTransaction: null,
      originTransactions: credited.originTxHashes, depositAddress: topup.depositAddress, alert: true,
    })]);
    expect(credited.originTxHashes).toHaveLength(1);
  });

  it.each([
    ['another recipient', (body: StatusBody) => { body.quoteResponse.quoteRequest['recipient'] = 'someone-else.testnet'; }, 'recipient_mismatch'],
    ['another destination asset', (body: StatusBody) => { body.quoteResponse.quoteRequest['destinationAsset'] = 'nep141:usdt.fakes.testnet'; }, 'destination_asset_mismatch'],
    ['another deposit address', (body: StatusBody) => { body.quoteResponse.quote['depositAddress'] = `0x${'5'.repeat(40)}`; }, 'deposit_address_mismatch'],
    ['delivery inside intents.near', (body: StatusBody) => { body.quoteResponse.quoteRequest['recipientType'] = 'INTENTS'; }, 'recipient_type_mismatch'],
    ['another refund account', (body: StatusBody) => { body.quoteResponse.quoteRequest['refundTo'] = 'someone-else.testnet'; }, 'refund_to_mismatch'],
    ['no amount out', (body: StatusBody) => { body.swapDetails['amountOut'] = null; }, 'no_amount_out'],
  ])('is flagged for review, with nothing credited, for a SUCCESS with %s', async (_case, change, reason) => {
    const topup = await newTopup();
    oneClick.setStatus(topup.depositAddress!, 'SUCCESS');
    const body = await statusBody(topup.depositAddress!);
    change(body);
    answerStatus(body);
    clock.advance(10_000);

    expect(await run()).toMatchObject({ polled: 1, credited: 0, review: 1 });

    expect(await find(topup.id)).toMatchObject({
      status: 'waiting', oneClickStatus: 'SUCCESS', needsReview: true, reviewReason: reason, nextPollAt: undefined, creditedAmount: undefined, ledgerTransactionId: undefined,
    });
    expect(await topUpTransactions(topup.depositAddress!)).toEqual([]);
    expect(await ledger.balance(topup.accountId)).toEqual({ available: 0n, held: 0n });
    expect(linesOf('A top-up needs review')).toEqual([expect.objectContaining({ level: 50, topupId: topup.id, reason, alert: true })]);

    // Never polled again
    clock.advance(minuteMs);
    expect(await run()).toMatchObject({ polled: 0 });
  });
});

describe('a top-up 1Click refunded or failed', () => {
  it('is refunded with 1Click\'s reason and transactions, credits nothing, and tells an operator to return it', async () => {
    const topup = await newTopup();
    oneClick.setStatus(topup.depositAddress!, 'REFUNDED');
    const { swapDetails } = await client.status({ depositAddress: topup.depositAddress! });
    const refundTransaction = swapDetails.destinationChainTxHashes[0]!.hash;
    const origin = swapDetails.originChainTxHashes.map(transaction => transaction.hash);
    clock.advance(10_000);

    expect(await run()).toMatchObject({ polled: 1, refunded: 1, credited: 0 });

    expect(await find(topup.id)).toMatchObject({
      status: 'refunded', oneClickStatus: 'REFUNDED', refundedAmount: 1_000_000n, refundReason: 'The swap could not complete before the deadline', refundTxHash: refundTransaction,
      originTxHashes: origin, nextPollAt: undefined, creditedAmount: undefined,
    });
    expect(await topUpTransactions(topup.depositAddress!)).toEqual([]);
    expect(linesOf('A top-up was refunded: return it by hand')).toEqual([expect.objectContaining({
      level: 40, topupId: topup.id, accountId: topup.accountId, refunded: '1', token: 'USDC', network: 'base', refundReason: 'The swap could not complete before the deadline',
      refundTransaction, originTransactions: origin,
    })]);
  });

  it('is failed and flagged for review when 1Click failed it', async () => {
    const topup = await newTopup();
    oneClick.setStatus(topup.depositAddress!, 'FAILED');
    const { correlationId } = await client.status({ depositAddress: topup.depositAddress! });
    clock.advance(10_000);

    expect(await run()).toMatchObject({ polled: 1, failed: 1, credited: 0 });

    expect(await find(topup.id)).toMatchObject({ status: 'failed', oneClickStatus: 'FAILED', needsReview: true, reviewReason: 'oneclick_failed', nextPollAt: undefined });
    expect(await topUpTransactions(topup.depositAddress!)).toEqual([]);
    expect(linesOf('A top-up failed at 1Click')).toEqual([expect.objectContaining({ level: 50, topupId: topup.id, correlationId })]);
  });
});

describe('top-ups left quoting', () => {
  it('moves one quoting for more than 10 minutes to quote_unknown, and leaves a younger one', async () => {
    const old = await newQuoting();
    clock.advance(5 * minuteMs);
    const young = await newQuoting();
    clock.advance(5 * minuteMs + 1_000);

    expect(await run()).toMatchObject({ stuck: 1, polled: 0 });

    expect(await find(old.id)).toMatchObject({ status: 'quote_unknown', quoteError: 'stuck_quoting', depositAddress: undefined });
    expect(await find(young.id)).toMatchObject({ status: 'quoting' });
    expect(linesOf('A top-up was stuck asking for its quote')).toEqual([expect.objectContaining({ level: 50, topupId: old.id, amount: '1', alert: true })]);
  });
});

describe('when 1Click doesn\'t answer as it should', () => {
  it('changes nothing but the next poll while 1Click answers 503, and warns once for the run', async () => {
    const [first, second] = [await newTopup(), await newTopup()];
    oneClick.handle('/v0/status', () => ({ status: 503, body: { message: 'Service Unavailable' } }));
    clock.advance(10_000);

    expect(await run()).toMatchObject({ polled: 2, unavailable: 2, review: 0, errors: 0 });

    for (const topup of [first, second]) {
      expect(await find(topup.id)).toEqual({ ...topup, nextPollAt: new Date(clock.now().getTime() + 10_000), updatedAt: clock.now() });
    }
    expect(linesOf('1Click didn\'t answer for some top-ups: they are polled again at their next time')).toEqual([
      expect.objectContaining({ level: 40, unavailable: 2, reason: 'server_error', status: 503 }),
    ]);
  });

  it('keeps polling an address 1Click doesn\'t know, warning after 10 minutes, and credits it once 1Click reports SUCCESS', async () => {
    const topup = await newTopup();
    oneClick.handle('/v0/status', () => ({ status: 404, body: { message: 'Deposit address not found' } }));
    clock.advance(10_000);

    expect(await run()).toMatchObject({ polled: 1, unclear: 0, review: 0 });
    expect(await find(topup.id)).toMatchObject({ status: 'waiting', needsReview: false, nextPollAt: new Date(clock.now().getTime() + 10_000) });
    expect(linesOf('A top-up\'s status is unclear: it is polled again')).toEqual([]);

    clock.set(new Date(topup.createdAt.getTime() + 10 * minuteMs + 1_000));
    expect(await run()).toMatchObject({ polled: 1, unclear: 1, review: 0, errors: 0 });
    expect(await find(topup.id)).toMatchObject({ status: 'waiting', needsReview: false, nextPollAt: new Date(clock.now().getTime() + 10_000) });
    expect(linesOf('A top-up\'s status is unclear: it is polled again')).toEqual([
      expect.objectContaining({ level: 40, topupId: topup.id, reason: 'oneclick_not_found', alert: true }),
    ]);

    oneClick.reset();
    oneClick.setStatus(topup.depositAddress!, 'SUCCESS');
    clock.advance(10_000);
    expect(await run()).toMatchObject({ credited: 1 });
    expect(await find(topup.id)).toMatchObject({ status: 'credited', creditedAmount: amountOut, needsReview: false });
    expect(await ledger.balance(topup.accountId)).toEqual({ available: amountOut, held: 0n });
  });

  it.each([
    ['a refusal', async () => ({ status: 400, body: { message: 'depositAddress must be a valid address' } }), 'oneclick_refused'],
    ['a status the client doesn\'t know', async (address: string) => ({ status: 200, body: { ...await statusBody(address), status: 'EXPIRED' } }), 'unknown_status'],
  ])('keeps polling a top-up 1Click answers with %s, and warns', async (_case, answerFor, reason) => {
    const topup = await newTopup();
    const answer = await answerFor(topup.depositAddress!);
    oneClick.handle('/v0/status', () => answer);
    clock.advance(10_000);

    expect(await run()).toMatchObject({ polled: 1, unclear: 1, review: 0, errors: 0, rejected: 0 });

    expect(await find(topup.id)).toMatchObject({ status: 'waiting', oneClickStatus: undefined, needsReview: false, nextPollAt: new Date(clock.now().getTime() + 10_000) });
    expect(linesOf('A top-up\'s status is unclear: it is polled again')).toEqual([expect.objectContaining({ level: 40, topupId: topup.id, reason, alert: true })]);
  });

  it('flags for review a top-up whose answers are still unclear when its window ends', async () => {
    const topup = await newTopup();
    oneClick.handle('/v0/status', () => ({ status: 404, body: { message: 'Deposit address not found' } }));

    clock.set(new Date(topup.addressExpiresAt!.getTime() + 1_000));
    expect(await run()).toMatchObject({ unclear: 1, review: 0 });
    expect(await find(topup.id)).toMatchObject({ status: 'waiting', needsReview: false, nextPollAt: new Date(clock.now().getTime() + 5 * minuteMs) });

    clock.set(pollingEndsAt(topup));
    expect(await run()).toMatchObject({ unclear: 1, review: 1 });
    expect(await find(topup.id)).toMatchObject({ status: 'waiting', needsReview: true, reviewReason: 'polling_ended', nextPollAt: undefined });
  });

  it.each([
    ['refuses our key with a 401', () => ({ status: 401, body: { message: 'Unauthorized' } }), 'auth_failed'],
    ['answers a SUCCESS without its quoteResponse', (body: StatusBody) => ({ status: 200, body: { ...body, status: 'SUCCESS', quoteResponse: undefined } }), 'invalid_answer'],
    ['answers a SUCCESS whose quoteResponse has no quote', (body: StatusBody) => ({ status: 200, body: { ...body, status: 'SUCCESS', quoteResponse: { quoteRequest: {} } } }), 'invalid_answer'],
  ])('keeps polling, logs an error and fails the run when 1Click %s', async (_case, answerFor, reason) => {
    const topup = await newTopup();
    oneClick.setStatus(topup.depositAddress!, 'SUCCESS');
    const answer = answerFor(await statusBody(topup.depositAddress!));
    oneClick.handle('/v0/status', () => answer);
    clock.advance(10_000);

    const error = await run().then(() => undefined, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TopupStatusFailedError);
    expect((error as TopupStatusFailedError).result).toMatchObject({ polled: 1, rejected: 1, errors: 0, credited: 0, review: 0 });
    expect(await find(topup.id)).toMatchObject({ status: 'waiting', needsReview: false, nextPollAt: new Date(clock.now().getTime() + 10_000) });
    expect(await topUpTransactions(topup.depositAddress!)).toEqual([]);
    expect(linesOf('A top-up\'s status can\'t be read: 1Click refused our key or answered in a shape we don\'t know')).toEqual([
      expect.objectContaining({ level: 50, topupId: topup.id, reason, alert: true }),
    ]);

    // Once 1Click answers as it should, the top-up is credited
    oneClick.reset();
    clock.advance(10_000);
    expect(await run()).toMatchObject({ credited: 1 });
  });

  it('acts on the others when one can\'t be recorded, then fails the run', async () => {
    const [broken, fine] = [await newTopup(), await newTopup()];
    const failing: TopupStatusOptions['topups'] = {
      ...repository,
      recordPoll: async (id, from, change) => {
        if (id === broken.id)
          throw new Error('The database is gone');
        return repository.recordPoll(id, from, change);
      },
    };
    clock.advance(10_000);

    const error = await run({ topups: failing }).then(() => undefined, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TopupStatusFailedError);
    expect((error as TopupStatusFailedError).result).toMatchObject({ polled: 2, errors: 1 });
    expect(await find(fine.id)).toMatchObject({ oneClickStatus: 'PENDING_DEPOSIT' });
    expect(await find(broken.id)).toMatchObject({ oneClickStatus: undefined });
    expect(linesOf('Failed to act on a top-up\'s status')).toEqual([expect.objectContaining({ level: 50, topupId: broken.id })]);
  });
});

describe('the poll schedule', () => {
  it('polls every 10 s in a top-up\'s first hour, every minute until its pay-by time, every 5 minutes after', () => {
    const createdAt = new Date(noon);
    const payBy = new Date(Date.parse(noon) + 24 * 60 * minuteMs);
    const after = (ms: number) => new Date(Date.parse(noon) + ms);
    const delayAt = (ms: number) => nextPollAt({ createdAt, payBy }, after(ms)).getTime() - after(ms).getTime();

    expect(delayAt(10_000)).toBe(10_000);
    expect(delayAt(59 * minuteMs)).toBe(10_000);
    expect(delayAt(60 * minuteMs)).toBe(minuteMs);
    expect(delayAt(23 * 60 * minuteMs)).toBe(minuteMs);
    expect(delayAt(24 * 60 * minuteMs)).toBe(5 * minuteMs);
    expect(delayAt(90 * 60 * minuteMs)).toBe(5 * minuteMs);
  });

  it('schedules a top-up past its first hour a minute after each poll', async () => {
    const topup = await newTopup();
    clock.advance(61 * minuteMs);

    await run();

    expect(await find(topup.id)).toMatchObject({ status: 'waiting', nextPollAt: new Date(clock.now().getTime() + minuteMs) });
  });
});
