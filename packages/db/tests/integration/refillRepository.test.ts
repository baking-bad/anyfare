import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { randomIdGenerator, type MicroUsd } from '@anyfare/common';
import { createFakeClock, createTestDatabase, type FakeClock, type TestDatabase } from '@anyfare/testing';

import {
  createLedger, createRefillRepository, createTreasuryRepository, ledgerAccountIds, ledgerEntries, ledgerTransactions, refills, type Refill, type RefillRepository,
  type RefillTransfer,
} from '../../src/index.js';

let database: TestDatabase;
let clock: FakeClock;
let repository: RefillRepository;
let counter = 0;
const start = '2026-11-12T12:00:00.000Z';
const minuteMs = 60_000;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = createFakeClock(start);
  repository = createRefillRepository({ db: database.db, clock, ids: randomIdGenerator });
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

// A target asset of each test's own, so its refills in flight are its own. The ledger makes its treasury account on first use.
const newAsset = (): string => {
  counter += 1;

  return `solana-usdc-${counter}`;
};

// A $5 refill of the asset, as the workers record it before they ask the Signer
const newRefill = async (asset = newAsset(), amount = 5_000_000n): Promise<Refill> => {
  const created = await repository.create({ id: `ref_${randomUUID()}`, asset, sourceAsset: 'near-usdc', amount: amount as MicroUsd });
  if (created === 'busy')
    throw new Error(`${asset} has a refill in flight`);

  return created;
};

// What the Signer sent for $5: 5.000501 USDC on NEAR to a new deposit address, with its NEAR transaction
const transferOf = (changes: Partial<RefillTransfer> = {}): RefillTransfer => ({
  depositAddress: randomUUID().replaceAll('-', '').repeat(2),
  amountIn: 5_000_501n,
  amountOut: 5_000_000n,
  quoteDeadline: new Date(clock.now().getTime() + 30 * minuteMs),
  correlationId: randomUUID(),
  nearTransactionHash: `near-tx-${randomUUID()}`,
  nextPollAt: new Date(clock.now().getTime() + 10_000),
  ...changes,
});

const quote = { correlationId: 'quote-correlation', quote: { amountIn: '5000501', amountOut: '5000000' } };

// A refill the Signer sent
const sentRefill = async (asset?: string, changes: Partial<RefillTransfer> = {}): Promise<Refill> => {
  const refill = await newRefill(asset);

  return (await repository.recordAnswer(refill.id, { status: 'sent', transfer: transferOf(changes), quote }))!;
};

const success = { status: 'SUCCESS', swapDetails: { amountOut: '5000000' } };

describe('a new refill', () => {
  it('is requested, with nothing of the Signer\'s answer yet', async () => {
    const asset = newAsset();

    const refill = await newRefill(asset);

    expect(refill).toMatchObject({
      asset, sourceAsset: 'near-usdc', amount: 5_000_000n, status: 'requested', reason: undefined, depositAddress: undefined, amountIn: undefined, amountOut: undefined,
      deliveryTransactionHashes: [], quote: undefined, nextPollAt: undefined, polls: 0, ledgerTransactionId: undefined, createdAt: new Date(start), updatedAt: new Date(start),
      sentAt: undefined, finishedAt: undefined,
    });
    expect(await repository.find(refill.id)).toEqual(refill);
    expect(await repository.findInFlight(asset)).toEqual(refill);
    expect(await constraintOf(repository.create({ id: `ref_${randomUUID()}`, asset: newAsset(), sourceAsset: 'near-usdc', amount: 0n as MicroUsd })))
      .toBe('refills_amount_check');
  });

  it('is one in flight per asset: of two made at once, one is made and the other is busy, and another asset is free', async () => {
    const asset = newAsset();
    const ask = () => repository.create({ id: `ref_${randomUUID()}`, asset, sourceAsset: 'near-usdc', amount: 5_000_000n as MicroUsd });

    const both = await Promise.all([ask(), ask()]);

    expect(both.filter(result => result === 'busy')).toHaveLength(1);
    const made = both.find((result): result is Refill => result !== 'busy')!;
    expect(await repository.findInFlight(asset)).toEqual(made);
    expect(await newRefill()).toMatchObject({ status: 'requested' });
  });

  it('blocks its asset while requested, sent, unknown or in review, and frees it once it is final', async () => {
    const asset = newAsset();
    const busy = () => repository.create({ id: `ref_${randomUUID()}`, asset, sourceAsset: 'near-usdc', amount: 1_000_000n as MicroUsd });

    const requested = await newRefill(asset);
    expect(await busy()).toBe('busy');
    const sent = await repository.recordAnswer(requested.id, { status: 'sent', transfer: transferOf(), quote });
    expect(await busy()).toBe('busy');
    const review = await repository.finish(sent!.id, 'sent', { status: 'review', reason: 'oneclick_failed' });
    expect(review).toMatchObject({ status: 'review', reason: 'oneclick_failed', nextPollAt: undefined, finishedAt: undefined });
    expect(await busy()).toBe('busy');
    // An operator decides: the refill is final
    await database.db.update(refills).set({ status: 'failed' }).where(eq(refills.id, requested.id));

    const next = await busy();
    expect(next).toMatchObject({ status: 'requested', amount: 1_000_000n });
    await repository.recordAnswer((next as Refill).id, { status: 'unknown', transfer: transferOf() });
    expect(await busy()).toBe('busy');
  });
});

describe('the Signer\'s answer', () => {
  it('keeps a sent refill\'s transfer and quote, polled from its first poll, once', async () => {
    const refill = await newRefill();
    const transfer = transferOf();
    clock.advance(2_000);

    const sent = await repository.recordAnswer(refill.id, { status: 'sent', transfer, quote });

    expect(sent).toMatchObject({
      status: 'sent', depositAddress: transfer.depositAddress, amountIn: 5_000_501n, amountOut: 5_000_000n, quoteDeadline: transfer.quoteDeadline,
      correlationId: transfer.correlationId, nearTransactionHash: transfer.nearTransactionHash, quote, nextPollAt: transfer.nextPollAt, sentAt: clock.now(),
      updatedAt: clock.now(), finishedAt: undefined,
    });
    expect(await repository.recordAnswer(refill.id, { status: 'not_sent', reason: 'payer_busy' })).toBeUndefined();
    expect(await repository.find(refill.id)).toEqual(sent);
  });

  it('keeps an unknown one\'s transfer without a quote, and ends a failed or refused one with its reason', async () => {
    const unknown = await repository.recordAnswer((await newRefill()).id, { status: 'unknown', transfer: transferOf() });
    const failed = await repository.recordAnswer((await newRefill()).id, { status: 'failed', reason: 'refill_failed', nearTransactionHash: 'near-tx-failed' });
    const refused = await repository.recordAnswer((await newRefill()).id, { status: 'not_sent', reason: 'signing_refused:source_low' });

    expect(unknown).toMatchObject({ status: 'unknown', quote: undefined, depositAddress: expect.any(String), sentAt: clock.now(), finishedAt: undefined });
    expect(failed).toMatchObject({ status: 'failed', reason: 'refill_failed', nearTransactionHash: 'near-tx-failed', nextPollAt: undefined, finishedAt: clock.now() });
    expect(refused).toMatchObject({ status: 'not_sent', reason: 'signing_refused:source_low', depositAddress: undefined, finishedAt: clock.now() });
  });

  it('refuses a deposit address another refill has', async () => {
    const first = await sentRefill();

    expect(await constraintOf(repository.recordAnswer((await newRefill()).id, { status: 'sent', transfer: transferOf({ depositAddress: first.depositAddress! }), quote })))
      .toBe('refills_deposit_address_idx');
  });
});

describe('the poll list', () => {
  it('lists sent and unknown refills whose next poll is due, soonest first, and one of two runners claims each poll', async () => {
    // Each test's rows are its own
    await database.db.delete(refills);
    const later = await sentRefill(undefined, { nextPollAt: new Date(Date.parse(start) + 20_000) });
    const sooner = await repository.recordAnswer((await newRefill()).id, { status: 'unknown', transfer: transferOf({ nextPollAt: new Date(Date.parse(start) + 5_000) }) });
    const notYet = await sentRefill(undefined, { nextPollAt: new Date(Date.parse(start) + 60_000) });
    const review = await sentRefill(undefined, { nextPollAt: new Date(Date.parse(start) + 1_000) });
    await repository.finish(review.id, 'sent', { status: 'review', reason: 'oneclick_failed' });
    await newRefill();
    clock.advance(30_000);

    const due = await repository.listDue({ now: clock.now(), limit: 10 });

    expect(due.map(refill => refill.id)).toEqual([sooner!.id, later.id]);
    expect(await repository.listDue({ now: clock.now(), limit: 1 })).toHaveLength(1);
    expect(due.map(refill => refill.id)).not.toContain(notYet.id);

    const next = new Date(clock.now().getTime() + 10_000);
    const claims = await Promise.all([
      repository.claimPoll({ id: later.id, seenUpdatedAt: later.updatedAt, nextPollAt: next }),
      repository.claimPoll({ id: later.id, seenUpdatedAt: later.updatedAt, nextPollAt: next }),
    ]);
    expect(claims.filter(claim => claim !== undefined)).toEqual([expect.objectContaining({ id: later.id, nextPollAt: next, polls: 1 })]);
    expect((await repository.listDue({ now: clock.now(), limit: 10 })).map(refill => refill.id)).toEqual([sooner!.id]);

    const lastStatus = { status: 'PROCESSING' };
    const polled = await repository.recordPoll(later.id, 'sent', { lastStatus, nextPollAt: new Date(clock.now().getTime() + 60_000) });
    expect(polled).toMatchObject({ status: 'sent', lastStatus, polls: 1 });
    expect(await repository.claimPoll({ id: review.id, seenUpdatedAt: review.updatedAt, nextPollAt: next })).toBeUndefined();
  });

  it('lists every refill in flight, oldest first', async () => {
    await database.db.delete(refills);
    const requested = await newRefill();
    clock.advance(1_000);
    const sent = await sentRefill();
    clock.advance(1_000);
    const refused = await repository.recordAnswer((await newRefill()).id, { status: 'not_sent', reason: 'payer_busy' });

    expect((await repository.listInFlight()).map(refill => refill.id)).toEqual([requested.id, sent.id]);
    expect(refused).toMatchObject({ status: 'not_sent' });
  });

  it('ends a refunded refill with what 1Click returned, and stops polling it', async () => {
    const refill = await sentRefill();
    const lastStatus = { status: 'REFUNDED' };

    const refunded = await repository.finish(refill.id, 'sent', {
      status: 'refunded', lastStatus, refundedAmount: 5_000_501n, refundFee: 1_000n, refundReason: 'The swap could not complete before the deadline',
    });

    expect(refunded).toMatchObject({
      status: 'refunded', lastStatus, refundedAmount: 5_000_501n, refundFee: 1_000n, refundReason: 'The swap could not complete before the deadline', nextPollAt: undefined,
      finishedAt: clock.now(), ledgerTransactionId: undefined,
    });
    expect(await repository.findInFlight(refill.asset)).toBeUndefined();
  });
});

describe('a booking', () => {
  const ledger = () => createLedger({ db: database.db, clock, ids: randomIdGenerator });
  const transactionsOf = async (reference: string) =>
    (await database.db.select().from(ledgerTransactions)).filter(transaction => transaction.operation === 'treasury_transfer' && transaction.reference === reference);

  it('marks the refill succeeded with the ledger\'s treasury transfer and its record, in one transaction', async () => {
    const refill = await sentRefill();
    const lastStatus = { status: 'SUCCESS', swapDetails: { amountOut: '5000000', refundedAmount: '1' } };
    clock.advance(5 * minuteMs);

    const booked = await repository.book({
      id: refill.id, from: 'sent', lastStatus, amountInUsd: 5_000_500n as MicroUsd, amountOutUsd: 5_000_000n as MicroUsd,
      deliveryTransactionHashes: ['solana-delivery-1'], refundedAmount: 1n, refundFee: undefined,
    });

    const reference = `refill:${refill.id}`;
    const [transaction] = await transactionsOf(reference);
    expect(booked).toMatchObject({
      status: 'succeeded', lastStatus, amountInUsd: 5_000_500n, amountOutUsd: 5_000_000n, deliveryTransactionHashes: ['solana-delivery-1'], refundedAmount: 1n,
      ledgerTransactionId: transaction!.id, nextPollAt: undefined, finishedAt: clock.now(),
    });
    // The NEAR treasury holds less, the target's more, and the difference is the conversion's cost
    const entries = await database.db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, transaction!.id));
    expect(entries.map(entry => [entry.ledgerAccountId, entry.amount])).toEqual(expect.arrayContaining([
      [ledgerAccountIds.treasury('near-usdc'), 5_000_500n],
      [ledgerAccountIds.treasury(refill.asset), -5_000_000n],
      [ledgerAccountIds.conversion, -500n],
    ]));
    expect(entries).toHaveLength(3);
    expect(await createTreasuryRepository({ db: database.db }).findTransfer(reference)).toEqual({
      reference, fromAsset: 'near-usdc', fromAmount: 5_000_500n, toAsset: refill.asset, toAmount: 5_000_000n,
      transactions: [refill.nearTransactionHash, 'solana-delivery-1'], recordedBy: 'rebalancing', ledgerTransactionId: transaction!.id, createdAt: clock.now(),
    });
  });

  it('books nothing twice: a replay finds the refill succeeded, and a second runner waits for the first and books nothing', async () => {
    const refill = await sentRefill();
    const booking = {
      id: refill.id, from: 'sent' as const, lastStatus: success, amountInUsd: 5_000_501n as MicroUsd, amountOutUsd: 5_000_000n as MicroUsd,
      deliveryTransactionHashes: ['solana-delivery-2'], refundedAmount: undefined, refundFee: undefined,
    };
    const target = ledgerAccountIds.treasury(refill.asset);

    const both = await Promise.all([repository.book(booking), repository.book(booking)]);
    const again = await repository.book(booking);

    expect(both.filter(result => result !== undefined)).toHaveLength(1);
    expect(again).toBeUndefined();
    expect(await transactionsOf(`refill:${refill.id}`)).toHaveLength(1);
    expect((await ledger().balancesOf([target])).get(target)).toBe(-5_000_000n);
    expect(await repository.find(refill.id)).toMatchObject({ status: 'succeeded', amountOutUsd: 5_000_000n });
  });

  it('rolls everything back when the ledger refuses, such as a transfer that would gain USD, and leaves the refill to poll', async () => {
    const refill = await sentRefill();

    const error = await thrown(repository.book({
      id: refill.id, from: 'sent', lastStatus: success, amountInUsd: 4_000_000n as MicroUsd, amountOutUsd: 5_000_000n as MicroUsd, deliveryTransactionHashes: [],
      refundedAmount: undefined, refundFee: undefined,
    }));

    expect(error).toBeInstanceOf(RangeError);
    expect(await transactionsOf(`refill:${refill.id}`)).toEqual([]);
    expect(await createTreasuryRepository({ db: database.db }).findTransfer(`refill:${refill.id}`)).toBeUndefined();
    expect(await repository.find(refill.id)).toEqual(refill);
  });

  it('books nothing from another status than the one named', async () => {
    const refill = await sentRefill();

    expect(await repository.book({
      id: refill.id, from: 'unknown', lastStatus: success, amountInUsd: 5_000_501n as MicroUsd, amountOutUsd: 5_000_000n as MicroUsd, deliveryTransactionHashes: [],
      refundedAmount: undefined, refundFee: undefined,
    })).toBeUndefined();
    expect(await transactionsOf(`refill:${refill.id}`)).toEqual([]);
  });
});
