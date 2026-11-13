import { describe, expect, it } from 'vitest';

import type { MicroUsd } from '@anyfare/common';
import { oneClickStatuses } from '@anyfare/topups';

import { bookingAmounts, decideRefill, pollStepOf, refillAnswerOf } from '../src/rebalancing.js';
import { signerRefillOf, type SignerRefill } from '../src/signerClient.js';

const usd = (value: number): MicroUsd => BigInt(Math.round(value * 1_000_000)) as MicroUsd;
// A target as example.yaml's Solana one: refilled under $3, up to $6, with refills of $1 to $10
const target = { floor: usd(3), target: usd(6) };
const limits = { leastPerRefill: usd(1), mostPerRefill: usd(10) };
const decide = (balance: number, changes: Partial<typeof limits> = {}) => decideRefill({ balance: usd(balance), target, ...limits, ...changes });

describe('the decision', () => {
  it('refills nothing at or above the floor', () => {
    expect(decide(3)).toEqual({ kind: 'above_floor' });
    expect(decide(100)).toEqual({ kind: 'above_floor' });
  });

  it('refills up to the target under the floor, a micro-dollar under it included', () => {
    expect(decide(2.999999)).toEqual({ kind: 'refill', amount: usd(3.000001) });
    expect(decide(1)).toEqual({ kind: 'refill', amount: usd(5) });
    expect(decide(0)).toEqual({ kind: 'refill', amount: usd(6) });
  });

  it('refills at most mostPerRefill', () => {
    expect(decide(0, { mostPerRefill: usd(4) })).toEqual({ kind: 'refill', amount: usd(4) });
    expect(decideRefill({ balance: usd(0), target: { floor: usd(20), target: usd(50) }, ...limits })).toEqual({ kind: 'refill', amount: usd(10) });
  });

  it('refills nothing when the amount is under leastPerRefill, and exactly leastPerRefill', () => {
    // $3.5 is missing: under a least of $4
    expect(decide(2.5, { leastPerRefill: usd(4) })).toEqual({ kind: 'below_least', amount: usd(3.5) });
    expect(decide(2, { leastPerRefill: usd(4) })).toEqual({ kind: 'refill', amount: usd(4) });
    // The most per refill under the least: nothing
    expect(decide(0, { leastPerRefill: usd(5), mostPerRefill: usd(4) })).toEqual({ kind: 'below_least', amount: usd(4) });
  });
});

describe('the booking amounts', () => {
  // USDC on NEAR and on Solana: 6 decimals each
  const six = { decimals: 6 };

  it('books amountIn as what left NEAR and amountOut as what arrived', () => {
    expect(bookingAmounts({ amountIn: 5_000_501n, refundedAmount: undefined, amountOut: 5_000_000n, source: six, target: six }))
      .toEqual({ amountInUsd: 5_000_501n, amountOutUsd: 5_000_000n });
  });

  it('takes a part 1Click refunded to the NEAR hot wallet off what left it', () => {
    expect(bookingAmounts({ amountIn: 5_000_501n, refundedAmount: 400n, amountOut: 5_000_000n, source: six, target: six }))
      .toEqual({ amountInUsd: 5_000_101n, amountOutUsd: 5_000_000n });
    expect(bookingAmounts({ amountIn: 5_000_501n, refundedAmount: 0n, amountOut: 5_000_000n, source: six, target: six }))
      .toEqual({ amountInUsd: 5_000_501n, amountOutUsd: 5_000_000n });
  });

  it('reads each amount with its own asset\'s decimals: what left rounded up, what arrived rounded down', () => {
    // 18 decimals on the source, 8 on the target
    expect(bookingAmounts({
      amountIn: 5_000_000_000_000_000_001n, refundedAmount: 1_000_000_000_000n, amountOut: 499_999_999n, source: { decimals: 18 }, target: { decimals: 8 },
    })).toEqual({ amountInUsd: 5_000_000n, amountOutUsd: 4_999_999n });
  });

  it('has no amounts for a refund above amountIn', () => {
    expect(bookingAmounts({ amountIn: 5_000_501n, refundedAmount: 5_000_502n, amountOut: 5_000_000n, source: six, target: six })).toBeUndefined();
  });
});

describe('the status mapping', () => {
  it('books SUCCESS, ends REFUNDED, flags FAILED for review, and waits for the rest', () => {
    expect(Object.fromEntries(oneClickStatuses.map(status => [status, pollStepOf(status)]))).toEqual({
      SUCCESS: 'book', REFUNDED: 'refunded', FAILED: 'review', PENDING_DEPOSIT: 'wait', KNOWN_DEPOSIT_TX: 'wait', INCOMPLETE_DEPOSIT: 'wait', PROCESSING: 'wait',
    });
  });

  const request = { refillId: 'ref_answer-1', asset: 'solana-usdc', amount: usd(5) };
  const next = new Date('2026-11-12T12:00:10.000Z');
  const transfer = {
    depositAddress: 'a'.repeat(64), amountIn: '5000501', amountOut: '5000000', quoteDeadline: '2026-11-15T12:30:00.000Z', correlationId: 'corr-1', transactionHash: 'near-tx-1',
  };
  const kept = {
    depositAddress: 'a'.repeat(64), amountIn: 5_000_501n, amountOut: 5_000_000n, quoteDeadline: new Date(transfer.quoteDeadline), correlationId: 'corr-1',
    nearTransactionHash: 'near-tx-1', nextPollAt: next,
  };
  const error = (code: string, message = 'A message', fields: Record<string, unknown> = {}) => ({ error: { code, message }, ...fields });
  const rowOf = (status: number, body: unknown) => refillAnswerOf(signerRefillOf(request, status, body), next);

  it('keeps a sent refill and an unknown one with their transfer, polled from the next poll', () => {
    expect(rowOf(200, { ...request, amount: '5000000', ...transfer, quote: { correlationId: 'corr-1' } }))
      .toEqual({ status: 'sent', transfer: kept, quote: { correlationId: 'corr-1' } });
    expect(rowOf(502, error('refill_unknown', 'May have landed', { outcome: 'unknown', ...transfer }))).toEqual({ status: 'unknown', transfer: kept });
  });

  it('ends a failed transaction, and every refusal before anything was sent, with its code and reason', () => {
    expect(rowOf(502, error('refill_failed', 'Failed', { transactionHash: 'near-tx-2' }))).toEqual({ status: 'failed', reason: 'refill_failed', nearTransactionHash: 'near-tx-2' });
    expect(rowOf(409, error('payer_busy'))).toEqual({ status: 'not_sent', reason: 'payer_busy' });
    expect(rowOf(422, error('signing_refused', 'Short', { reason: 'source_low' }))).toEqual({ status: 'not_sent', reason: 'signing_refused:source_low' });
    expect(rowOf(422, error('signing_refused'))).toEqual({ status: 'not_sent', reason: 'signing_refused' });
    expect(rowOf(502, error('signing_failed'))).toEqual({ status: 'not_sent', reason: 'signing_failed' });
    for (const code of ['refills_off', 'oneclick_unavailable', 'redis_not_ready'])
      expect(rowOf(503, error(code))).toEqual({ status: 'not_sent', reason: code });
  });

  it('keeps an ID asked again requested when the Signer refused it before reading its record: it may have sent at the first ask', () => {
    for (const code of ['refills_off', 'redis_not_ready']) {
      const answer = signerRefillOf(request, 503, error(code));
      expect(refillAnswerOf(answer, next, true)).toBe('keep');
      // A new ID: nothing can have been sent for it
      expect(refillAnswerOf(answer, next, false)).toEqual({ status: 'not_sent', reason: code });
    }
    // Refusals after the record was read: nothing was sent under the ID
    for (const [status, code] of [[503, 'oneclick_unavailable'], [409, 'payer_busy'], [422, 'signing_refused'], [502, 'signing_failed']] as const)
      expect(refillAnswerOf(signerRefillOf(request, status, error(code)), next, true)).toEqual({ status: 'not_sent', reason: code });
  });

  it('leaves a refill requested for an ask in progress, no answer, and any other answer, so the next run asks again', () => {
    const answers: SignerRefill[] = [
      { kind: 'in_progress', message: 'In progress' },
      { kind: 'no_answer', status: undefined, code: 'timeout', message: 'The Signer didn\'t answer' },
    ];
    for (const answer of answers)
      expect(refillAnswerOf(answer, next)).toBe('keep');
    for (const [status, body] of [
      [409, error('refill_in_progress')], [409, error('refill_id_conflict')], [400, error('invalid_request')], [401, error('unauthorized')], [500, error('internal_error')],
      [503, undefined], [502, undefined], [200, { ...request, amount: '5000000', ...transfer }], [200, { ...request, refillId: 'ref_other', ...transfer, quote: {} }],
      [502, error('refill_unknown', 'No transfer', { transactionHash: 'near-tx-3' })], [200, 'not json'],
    ] as const)
      expect(rowOf(status, body)).toBe('keep');
  });
});
