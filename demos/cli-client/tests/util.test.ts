import { describe, expect, it } from 'vitest';
import { Stop, fromAtomic, requireEnv, short, toAtomic, usd } from '../src/util.ts';

describe('toAtomic', () => {
  it('converts exactly', () => {
    expect(toAtomic('0.02', 6)).toBe(20000n);
    expect(toAtomic('1', 18)).toBe(10n ** 18n);
    expect(toAtomic('0.000001', 6)).toBe(1n);
    expect(toAtomic('007.5', 1)).toBe(75n);
    const big = '123456789012345678901234567890';
    expect(toAtomic(big, 6)).toBe(BigInt(big) * 10n ** 6n);
    expect(toAtomic(`${big}.123456`, 6)).toBe(BigInt(`${big}123456`));
  });

  it.each(['', '-1', '+1', '1e3', '.5', '1.', '1,5', ' 1', '1 ', '1 0', '0x10'])(
    'refuses %j',
    (value) => {
      expect(() => toAtomic(value, 6)).toThrow(Stop);
      expect(() => toAtomic(value, 6)).toThrow(`Not a plain decimal amount: "${value}"`);
    },
  );

  it('refuses too many decimal places', () => {
    expect(() => toAtomic('0.0000001', 6)).toThrow(Stop);
  });
});

describe('fromAtomic', () => {
  it('gives the shortest exact decimal', () => {
    expect(fromAtomic(10000n, 6)).toBe('0.01');
    expect(fromAtomic(1000000n, 6)).toBe('1');
    expect(fromAtomic(0n, 6)).toBe('0');
    expect(fromAtomic(1n, 6)).toBe('0.000001');
    expect(fromAtomic(1500000n, 6)).toBe('1.5');
    expect(fromAtomic(10n ** 18n, 18)).toBe('1');
    expect(fromAtomic(5n, 0)).toBe('5');
  });

  it('takes a string and keeps the sign', () => {
    expect(fromAtomic('20000', 6)).toBe('0.02');
    expect(fromAtomic(-10000n, 6)).toBe('-0.01');
    expect(fromAtomic('-1000000', 6)).toBe('-1');
  });

  it('refuses a string that is not a whole number', () => {
    expect(() => fromAtomic('1.5', 6)).toThrow(Stop);
  });

  it('round-trips', () => {
    for (const [amount, decimals] of [
      ['0.02', 6],
      ['1', 6],
      ['12345.678901', 6],
      ['0.000000000000000001', 18],
      ['999999999999999999999999.5', 6],
    ] as const) {
      expect(fromAtomic(toAtomic(amount, decimals), decimals)).toBe(amount);
    }
    expect(fromAtomic(toAtomic('1.50', 6), 6)).toBe('1.5');
  });
});

describe('usd', () => {
  it('prints dollars', () => {
    expect(usd(10000n)).toBe('$0.01');
    expect(usd(1000n)).toBe('$0.001');
    expect(usd(1000000n)).toBe('$1');
  });
});

describe('short', () => {
  it('shows only the first 10 characters', () => {
    expect(short('afm_live_abcdefghijklmnop')).toBe('afm_live_a…');
    expect(short('0123456789')).toBe('…');
    expect(short('abc')).toBe('…');
  });
});

describe('requireEnv', () => {
  it('returns the trimmed value', () => {
    expect(requireEnv({ NAME: '  value ' }, 'NAME', 'Hint.')).toBe('value');
  });

  it('stops when the value is unset or blank', () => {
    const message = 'NAME is not set. Add it to .env.local. Hint.';
    expect(() => requireEnv({}, 'NAME', 'Hint.')).toThrow(message);
    expect(() => requireEnv({ NAME: '   ' }, 'NAME', 'Hint.')).toThrow(message);
    expect(() => requireEnv({}, 'NAME', 'Hint.')).toThrow(Stop);
  });
});

describe('Stop', () => {
  it('adds the not-charged note', () => {
    expect(new Stop('It failed.', { notCharged: true }).line()).toBe('It failed. Not charged.');
    expect(new Stop('It failed.').line()).toBe('It failed.');
  });
});
