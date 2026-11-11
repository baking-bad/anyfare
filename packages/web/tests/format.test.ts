import { describe, expect, it } from 'vitest';

import { ago, count, ms, pct, usd } from '../src/format';

describe('usd', () => {
  it('shows two digits, and three for an amount under ten cents', () => {
    expect(usd(18.42)).toBe('$18.42');
    expect(usd(0.002)).toBe('$0.002');
    expect(usd(0.1)).toBe('$0.10');
    expect(usd(0)).toBe('$0.00');
  });

  it('groups thousands and takes explicit digits', () => {
    expect(usd(2140.5)).toBe('$2,140.50');
    expect(usd(5, 0)).toBe('$5');
    expect(usd(0.01, 3)).toBe('$0.010');
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
  });

  it('takes a date, and reads a moment in the future as now', () => {
    expect(ago(new Date(now - 90_000), now)).toBe('1m ago');
    expect(ago(now + 60_000, now)).toBe('now');
  });
});
