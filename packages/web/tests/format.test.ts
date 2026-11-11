import { describe, expect, it } from 'vitest';

import { ago, count, ms, pct, usd, usdOf } from '../src/format';

describe('usd', () => {
  // One rule: zero is "$0"; from $1 two decimals; under $1 the amount's own digits up to six decimals, at
  // least two, no trailing zero past the second; a non-zero amount under a millionth is "<$0.000001".
  it.each([
    [0, '$0'],
    [18.42, '$18.42'],
    [12.3456, '$12.35'],
    [1, '$1.00'],
    [5, '$5.00'],
    [2140.5, '$2,140.50'],
    [1_947_000, '$1,947,000.00'],
    [0.9999996, '$1.00'],
    [0.5, '$0.50'],
    [0.25, '$0.25'],
    [0.1, '$0.10'],
    [0.01, '$0.01'],
    [0.033, '$0.033'],
    [0.002, '$0.002'],
    [0.001, '$0.001'],
    [0.0105, '$0.0105'],
    [0.011, '$0.011'],
    [0.000123, '$0.000123'],
    [0.0000015, '$0.000002'],
    [0.000001, '$0.000001'],
    [0.0000004, '<$0.000001'],
    [-0.002, '-$0.002'],
    [-18.4, '-$18.40'],
    [Number.NaN, '-'],
  ])('writes %s as %s', (amount, text) => {
    expect(usd(amount)).toBe(text);
  });
});

describe('usdOf', () => {
  it('reads the API\'s decimal string with the same rule, and a dash for a missing or unreadable one', () => {
    expect(usdOf('0.002')).toBe('$0.002');
    expect(usdOf('0.01')).toBe('$0.01');
    expect(usdOf('0')).toBe('$0');
    expect(usdOf('18.42')).toBe('$18.42');
    expect(usdOf(null)).toBe('-');
    expect(usdOf('')).toBe('-');
    expect(usdOf('abc')).toBe('-');
  });
});

describe('count', () => {
  it('groups thousands', () => {
    expect(count(2140)).toBe('2,140');
    expect(count(0)).toBe('0');
    expect(count(1_947_000)).toBe('1,947,000');
  });
});

describe('pct', () => {
  it('shows one decimal, and none for a whole share', () => {
    expect(pct(0.124)).toBe('12%');
    expect(pct(0.36)).toBe('36%');
    expect(pct(0.99)).toBe('99%');
    expect(pct(0.0996)).toBe('10%');
    expect(pct(0.042)).toBe('4.2%');
    expect(pct(1)).toBe('100%');
    expect(pct(0)).toBe('0.0%');
  });
});

describe('ms', () => {
  it('shows milliseconds under a second, and seconds from it', () => {
    expect(ms(340)).toBe('340 ms');
    expect(ms(999)).toBe('999 ms');
    expect(ms(1000)).toBe('1.0 s');
    expect(ms(1840)).toBe('1.8 s');
  });
});

describe('ago', () => {
  const now = Date.UTC(2026, 10, 12, 10, 0, 0);

  it('reads now, seconds, minutes and hours', () => {
    expect(ago(now - 2_000, now)).toBe('now');
    expect(ago(now - 12_000, now)).toBe('12s ago');
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(ago(now - 48 * 3_600_000, now)).toBe('48h ago');
    expect(ago(now - 165 * 3_600_000, now)).toBe('6 days ago');
    expect(ago(now - 337 * 3_600_000, now)).toBe('14 days ago');
    expect(ago(now - 60 * 86_400_000, now)).toBe('60 days ago');
    expect(ago(Date.parse('2026-09-11T08:00:00Z'), Date.parse('2026-11-11T12:00:00Z'))).toBe('Sep 11, 2026');
  });

  it('takes a date, and reads a moment in the future as now', () => {
    expect(ago(new Date(now - 90_000), now)).toBe('1m ago');
    expect(ago(now + 60_000, now)).toBe('now');
  });
});
