import { describe, expect, it } from 'vitest';

import { InvalidAmountError } from '@anyfare/common';
import { loadPlatformConfig } from '@anyfare/core';
import { defaultOneClickTokens, testnetNearUsdcAddress } from '@anyfare/testing';

import { buildQuoteRequest, isStablecoin, parseTokenAmount } from '../src/index.js';

const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml', CONFIG: '{"topups":{"enabled":true}}', CONFIG_DECODE: 'false' } });
const token = (blockchain: string, symbol: string) => defaultOneClickTokens.find(item => item.blockchain === blockchain && item.symbol === symbol)!;
const now = new Date('2026-11-09T12:00:00.000Z');

describe('buildQuoteRequest', () => {
  it('asks for a flexible input from a stablecoin, delivered to the recipient on NEAR, with a day to pay', () => {
    expect(buildQuoteRequest({ topups: config.topups, token: token('base', 'USDC'), amount: 5_000_000n, now, dry: false })).toEqual({
      dry: false,
      swapType: 'FLEX_INPUT',
      slippageTolerance: 100,
      originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: `nep141:${testnetNearUsdcAddress}`,
      amount: '5000000',
      refundTo: 'treasury.anyfare.testnet',
      refundType: 'INTENTS',
      recipient: 'treasury.anyfare.testnet',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-10T12:00:00.000Z',
    });
  });

  it('gives SOL, whose price moves, two hours to pay', () => {
    const request = buildQuoteRequest({ topups: config.topups, token: token('sol', 'SOL'), amount: 250_000_000n, now, dry: true });

    expect(request).toMatchObject({ dry: true, originAsset: 'nep141:sol.omft.near', amount: '250000000', deadline: '2026-11-09T14:00:00.000Z' });
  });

  it('takes the slippage, the deadlines and the stablecoins from the config, comparing symbols without case', () => {
    const topups = { ...config.topups, slippageBps: 30, deadlineMinutes: { stablecoin: 60, other: 15 }, stablecoins: ['usdc'] };

    expect(buildQuoteRequest({ topups, token: token('arb', 'USDC'), amount: 1n, now, dry: false })).toMatchObject({ slippageTolerance: 30, deadline: '2026-11-09T13:00:00.000Z' });
    expect(buildQuoteRequest({ topups, token: { assetId: 'nep141:usdt.tether-token.near', symbol: 'USDt' }, amount: 1n, now, dry: false }).deadline).toBe('2026-11-09T12:15:00.000Z');
    expect(isStablecoin(config.topups, 'usdt0')).toBe(true);
    expect(isStablecoin(config.topups, 'wNEAR')).toBe(false);
  });

  it('refuses an amount of zero, and top-ups that aren\'t configured', () => {
    expect(() => buildQuoteRequest({ topups: config.topups, token: token('base', 'USDC'), amount: 0n, now, dry: true })).toThrow(InvalidAmountError);
    expect(() => buildQuoteRequest({ topups: { ...config.topups, recipient: undefined }, token: token('base', 'USDC'), amount: 1n, now, dry: true }))
      .toThrow('topups.recipient is not set: top-ups are not configured');
  });
});

describe('parseTokenAmount', () => {
  it.each([
    ['1', 6, 1_000_000n],
    ['0.5', 6, 500_000n],
    ['0.00012', 8, 12_000n],
    ['2.000001', 6, 2_000_001n],
    ['1.5', 24, 1_500_000_000_000_000_000_000_000n],
    ['7', 0, 7n],
    ['123456789012345678901234567890', 0, 123_456_789_012_345_678_901_234_567_890n],
  ])('reads %s with %i decimals', (value, decimals, expected) => {
    expect(parseTokenAmount(value, decimals)).toBe(expected);
  });

  it.each([
    ['an empty string', '', 6, 'The amount is empty'],
    ['a minus sign', '-1', 6, 'The amount takes no sign'],
    ['a plus sign', '+1', 6, 'The amount takes no sign'],
    ['an exponent', '1e6', 6, 'The amount takes no exponent: write it out, such as 0.0001'],
    ['a capital exponent', '1.5E3', 6, 'The amount takes no exponent: write it out, such as 0.0001'],
    ['zero', '0', 6, 'The amount must be more than 0'],
    ['zero with decimals', '0.000', 6, 'The amount must be more than 0'],
    ['more decimals than the token has', '0.1234567', 6, 'The token takes at most 6 decimals'],
    ['decimals on a token without any', '1.5', 0, 'The token takes no decimals'],
    ['more than 30 digits', '1234567890123456789012345678901', 0, 'The amount has more than 30 digits'],
    ['more than 30 digits with decimals', '12345678901234567890123456.78901', 18, 'The amount has more than 30 digits'],
    ['a leading zero', '01', 6, 'The amount must be a plain decimal, such as 1 or 0.5'],
    ['a leading dot', '.5', 6, 'The amount must be a plain decimal, such as 1 or 0.5'],
    ['a trailing dot', '1.', 6, 'The amount must be a plain decimal, such as 1 or 0.5'],
    ['a comma', '1,5', 6, 'The amount must be a plain decimal, such as 1 or 0.5'],
    ['spaces', ' 1', 6, 'The amount must be a plain decimal, such as 1 or 0.5'],
    ['words', 'ten', 6, 'The amount must be a plain decimal, such as 1 or 0.5'],
  ])('refuses %s', (_name, value, decimals, message) => {
    expect(() => parseTokenAmount(value, decimals)).toThrow(new InvalidAmountError(message));
    expect(() => parseTokenAmount(value, decimals)).toThrow(InvalidAmountError);
  });

  it('refuses decimals that no token has', () => {
    expect(() => parseTokenAmount('1', 37)).toThrow('Token decimals must be an integer from 0 to 36');
    expect(() => parseTokenAmount('1', 1.5)).toThrow(InvalidAmountError);
  });
});
