import { describe, expect, it } from 'vitest';

import type { MicroUsd } from '@anyfare/common';
import type { OneClickDepositQuoteResponse } from '@anyfare/topups';

import { verdictOf } from '../src/nearTransfer.js';
import { checkRefillQuote, isNearDepositAddress, isRefillFeeWithin, refillAtomicAmount, type RefillQuoteCheck } from '../src/refillQuote.js';

// Made-up values: our Base wallet, the NEAR hot wallet, 1Click's asset IDs, the source token's contract, and an implicit deposit account
const recipient = '0xAbCdEf0000000000000000000000000000000001';
const refundTo = 'hot.anyfare.testnet';
const originAsset = 'nep141:usdc.fakes.testnet';
const destinationAsset = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const sourceContract = 'b'.repeat(64);
const depositAddress = 'a'.repeat(64);
const request = {
  originAsset, destinationAsset, swapType: 'EXACT_OUTPUT', amount: '10000000', recipient, recipientType: 'DESTINATION_CHAIN', refundTo, refundType: 'ORIGIN_CHAIN',
  depositType: 'ORIGIN_CHAIN',
} as const;

// $10 to deliver in 6 decimals, a 2% bound: 1Click may keep $0.20. Half an hour before the quote's deadline.
const check = (changes: Partial<RefillQuoteCheck> = {}): RefillQuoteCheck => ({
  amount: 10_000_000n as MicroUsd, atomicAmount: 10_000_000n, sourceDecimals: 6, targetDecimals: 6, maxFeeBps: 200, request,
  ours: [sourceContract, refundTo, recipient, 'treasury.anyfare.testnet'], now: new Date('2026-11-11T12:30:00.000Z'), ...changes,
});

const answer = ({ quote = {}, quoteRequest = { ...request } as Record<string, unknown> | undefined } = {}): OneClickDepositQuoteResponse => {
  const parsed = {
    amountIn: '10100000', minAmountIn: '10049500', amountOut: '10000000', minAmountOut: '10000000', amountInUsd: '10.1', amountOutUsd: '9.9948', timeEstimate: 20,
    depositAddress, depositMemo: undefined, deadline: '2026-11-11T13:00:00.000Z', timeWhenInactive: '2026-11-11T13:00:00.000Z', ...quote,
  } as OneClickDepositQuoteResponse['quote'];

  return {
    correlationId: 'b3c0e7a2-6f1d-4c55-9a51-0c2d8e1f4a77', signature: undefined, timestamp: '2026-11-11T12:30:00.000Z', quote: parsed,
    raw: { quote: parsed, ...quoteRequest === undefined ? {} : { quoteRequest } },
  };
};

describe('the amount a refill asks 1Click to deliver', () => {
  it('is the micro-USD in the target asset\'s atomic units, by the registry\'s decimals', () => {
    expect(refillAtomicAmount(41_500_000n, 6)).toBe(41_500_000n);
    expect(refillAtomicAmount(41_500_000n, 18)).toBe(41_500_000_000_000_000_000n);
    expect(refillAtomicAmount(41_500_000n, 0)).toBe(42n);
  });

  it('rounds up when the asset has fewer decimals, so the wallet never receives less', () => {
    expect(refillAtomicAmount(1_000_001n, 2)).toBe(101n);
    expect(refillAtomicAmount(1_000_000n, 2)).toBe(100n);
  });
});

describe('the deposit address of a refill', () => {
  it.each([
    ['an implicit account of 64 hex characters', 'f'.repeat(64), true],
    ['a named account', 'deposit.intents.near', true],
    ['an Ethereum-like implicit account', `0x${'1'.repeat(40)}`, false],
    ['capitals', 'A'.repeat(64), false],
    ['an EVM address', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', false],
    ['a Solana address', 'AzG7Gmu8t6r54JbdAxZBNHNvCzbf5QDZcdKe7Aho78Xj', false],
    ['one character', 'a', false],
  ])('takes %s: %s', (_name, address, valid) => {
    expect(isNearDepositAddress(address)).toBe(valid);
  });
});

describe('the check of a refill\'s quote', () => {
  it('passes a quote for the amount, to our wallet, within the fee bound', () => {
    expect(checkRefillQuote(answer(), check())).toBeUndefined();
  });

  it('passes a quote whose deadline is exactly 2 minutes away', () => {
    expect(checkRefillQuote(answer({ quote: { deadline: '2026-11-11T12:32:00.000Z' } }), check())).toBeUndefined();
  });

  it.each([
    ['a deposit address that isn\'t a NEAR account', { depositAddress: `0x${'1'.repeat(40)}` }, 'The quote\'s deposit address isn\'t a NEAR account'],
    ['the source token\'s contract as the deposit address', { depositAddress: sourceContract }, 'The quote\'s deposit address is one of our own accounts, or the source token\'s contract'],
    ['the NEAR hot wallet as the deposit address', { depositAddress: refundTo }, 'The quote\'s deposit address is one of our own accounts, or the source token\'s contract'],
    ['the top-ups treasury as the deposit address', { depositAddress: 'treasury.anyfare.testnet' }, 'The quote\'s deposit address is one of our own accounts, or the source token\'s contract'],
    ['a deposit memo', { depositMemo: '123456789' }, 'The quote asks for a deposit memo'],
    ['no deadline', { deadline: undefined }, 'The quote has no deadline, or its deadline is less than 2 minutes away'],
    ['a deadline that has passed', { deadline: '2026-11-11T12:29:59.999Z' }, 'The quote has no deadline, or its deadline is less than 2 minutes away'],
    ['a deadline of now', { deadline: '2026-11-11T12:30:00.000Z' }, 'The quote has no deadline, or its deadline is less than 2 minutes away'],
    ['a deadline a millisecond short of 2 minutes away', { deadline: '2026-11-11T12:31:59.999Z' }, 'The quote has no deadline, or its deadline is less than 2 minutes away'],
    ['an amountOut under the amount asked', { amountOut: '9999999', amountIn: '10000000' }, 'The quote\'s amountOut, 9999999, is less than the 10000000 asked for'],
    ['a minAmountOut under the amount asked', { minAmountOut: '9999999' }, 'The quote\'s minAmountOut, 9999999, is less than the 10000000 asked for'],
    ['an amountIn of 0', { amountIn: '0' }, 'The quote\'s amountIn is 0'],
  ])('refuses %s', (_name, quote, reason) => {
    expect(checkRefillQuote(answer({ quote }), check())).toBe(reason);
  });

  it('refuses a quote that takes and delivers far more than asked, though it costs nothing', () => {
    const thousand = { amountIn: '1000000000', amountOut: '1000000000', minAmountOut: '1000000000', depositAddress: 'd'.repeat(64) };

    expect(checkRefillQuote(answer({ quote: thousand }), check())).toBe('The quote\'s amountOut, 1000000000, is more than 200 basis points above the 10000000 asked for');
  });

  it('takes an amountOut up to the fee bound above the amount asked, and refuses one atomic unit more', () => {
    expect(checkRefillQuote(answer({ quote: { amountOut: '10200000', minAmountOut: '10200000', amountIn: '10200000' } }), check())).toBeUndefined();
    expect(checkRefillQuote(answer({ quote: { amountOut: '10200001', minAmountOut: '10200001', amountIn: '10200001' } }), check()))
      .toBe('The quote\'s amountOut, 10200001, is more than 200 basis points above the 10000000 asked for');
  });

  it('takes an amountIn worth the amount plus the fee bound, and refuses one micro-USD more', () => {
    expect(checkRefillQuote(answer({ quote: { amountIn: '10200000' } }), check())).toBeUndefined();
    expect(checkRefillQuote(answer({ quote: { amountIn: '10200001' } }), check()))
      .toBe('The quote\'s amountIn, 10200001, is worth more than the amount plus 200 basis points');
    // amountOut above the amount doesn't raise what may leave the hot wallet
    expect(checkRefillQuote(answer({ quote: { amountOut: '10100000', minAmountOut: '10100000', amountIn: '10200001' } }), check()))
      .toBe('The quote\'s amountIn, 10200001, is worth more than the amount plus 200 basis points');
  });

  it('reads amountIn in USD by the source\'s decimals: 18, at the bound and one atomic unit over it', () => {
    const eighteen = check({ sourceDecimals: 18 });

    expect(checkRefillQuote(answer({ quote: { amountIn: '10200000000000000000' } }), eighteen)).toBeUndefined();
    expect(checkRefillQuote(answer({ quote: { amountIn: '10200000000000000001' } }), eighteen)).toMatch(/is worth more than the amount plus 200 basis points/);
    // Read as 6 decimals, the same amountIn would be worth trillions
    expect(checkRefillQuote(answer({ quote: { amountIn: '10200000000000000000' } }), check())).toMatch(/is worth more than the amount plus 200 basis points/);
  });

  it('reads a target of 2 decimals by its decimals: amountOut 1000 is $10', () => {
    const two = check({ targetDecimals: 2, atomicAmount: 1_000n });

    expect(checkRefillQuote(answer({ quote: { amountOut: '1000', minAmountOut: '1000', amountIn: '10200000' } }), two)).toBeUndefined();
    expect(checkRefillQuote(answer({ quote: { amountOut: '1020', minAmountOut: '1000', amountIn: '10200000' } }), two)).toBeUndefined();
    expect(checkRefillQuote(answer({ quote: { amountOut: '1021', minAmountOut: '1000', amountIn: '10200000' } }), two)).toMatch(/is more than 200 basis points above the 1000/);
    expect(checkRefillQuote(answer({ quote: { amountOut: '999', minAmountOut: '999', amountIn: '10000000' } }), two)).toBe('The quote\'s amountOut, 999, is less than the 1000 asked for');
  });

  it('measures 1Click\'s cost exactly, each side by its own decimals', () => {
    const fee = (amountIn: bigint, amountOut: bigint, sourceDecimals = 6, targetDecimals = 6) =>
      isRefillFeeWithin({ amountIn, amountOut, amount: 10_000_000n as MicroUsd, sourceDecimals, targetDecimals, maxFeeBps: 200 });

    expect(fee(10_200_000n, 10_000_000n)).toBe(true);
    expect(fee(10_200_001n, 10_000_000n)).toBe(false);
    expect(fee(10_200_000_000_000_000_000n, 10_000_000n, 18)).toBe(true);
    expect(fee(10_200_000_000_000_000_001n, 10_000_000n, 18)).toBe(false);
    expect(fee(10_200_000n, 1_000n, 6, 2)).toBe(true);
    expect(fee(10_200_001n, 1_000n, 6, 2)).toBe(false);
  });

  it('takes no cost at a bound of 0, and a quote that delivers more than it takes', () => {
    expect(checkRefillQuote(answer({ quote: { amountIn: '10000000' } }), check({ maxFeeBps: 0 }))).toBeUndefined();
    expect(checkRefillQuote(answer({ quote: { amountIn: '10000001' } }), check({ maxFeeBps: 0 }))).toMatch(/is worth more than the amount plus 0 basis points/);
    expect(isRefillFeeWithin({ amountIn: 9_000_000n, amountOut: 10_000_000n, amount: 10_000_000n, sourceDecimals: 6, targetDecimals: 6, maxFeeBps: 0 })).toBe(true);
  });

  it.each([
    ['originAsset', 'nep141:other.fakes.testnet'],
    ['destinationAsset', 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'],
    ['swapType', 'EXACT_INPUT'],
    ['amount', '1000000000'],
    ['recipient', '0x4444444444444444444444444444444444444444'],
    ['recipientType', 'INTENTS'],
    ['refundTo', 'other.anyfare.testnet'],
    ['refundType', 'INTENTS'],
    ['depositType', 'INTENTS'],
  ])('refuses a quote whose echoed %s isn\'t ours', (field, value) => {
    expect(checkRefillQuote(answer({ quoteRequest: { ...request, [field]: value } }), check())).toBe(`The quote's quoteRequest.${field} isn't the one asked for`);
  });

  it('takes an echoed EVM recipient in another letter case, and an answer that echoes none of the fields', () => {
    expect(checkRefillQuote(answer({ quoteRequest: { ...request, recipient: recipient.toLowerCase() } }), check())).toBeUndefined();
    expect(checkRefillQuote(answer({ quoteRequest: {} }), check())).toBeUndefined();
    expect(checkRefillQuote(answer({ quoteRequest: undefined }), check())).toBeUndefined();
  });
});

describe('the verdict on a refill transaction\'s outcome', () => {
  const token = 'usdc.fakes.testnet';
  const outcome = ({ status = { SuccessValue: '' } as unknown, receipts = [{ executor_id: token, status: { SuccessValue: '' } }] as unknown[], final = 'FINAL' } = {}) => ({
    final_execution_status: final, status, receipts_outcome: receipts.map(item => ({ outcome: item })),
  });
  const failure = { Failure: { ActionError: { index: 1, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked' } } } } };

  it('is sent when the transaction and every receipt succeeded', () => {
    expect(verdictOf(outcome(), token)).toEqual({ kind: 'sent' });
    expect(verdictOf(outcome({ receipts: [{ executor_id: token, status: { SuccessValue: '' } }, { executor_id: 'hot.anyfare.testnet', status: { SuccessValue: '' } }] }), token))
      .toEqual({ kind: 'sent' });
  });

  it('is failed when the token\'s receipt failed, or the transaction failed before it had one', () => {
    expect(verdictOf(outcome({ status: failure, receipts: [{ executor_id: token, status: failure }] }), token))
      .toEqual({ kind: 'failed', reason: 'The token contract\'s receipt failed' });
    expect(verdictOf(outcome({ status: failure, receipts: [] }), token)).toEqual({ kind: 'failed', reason: 'The transaction failed' });
  });

  it('is unknown when another receipt failed after the token\'s succeeded', () => {
    expect(verdictOf(outcome({ receipts: [{ executor_id: token, status: { SuccessValue: '' } }, { executor_id: 'hot.anyfare.testnet', status: failure }] }), token))
      .toEqual({ kind: 'unknown', reason: 'The final outcome has a failed receipt beside the token\'s' });
  });

  it('is no verdict until the node calls the outcome final', () => {
    expect(verdictOf(outcome({ final: 'EXECUTED_OPTIMISTIC' }), token)).toBeUndefined();
    expect(verdictOf({ status: { SuccessValue: '' } }, token)).toBeUndefined();
    expect(verdictOf(undefined, token)).toBeUndefined();
  });
});
