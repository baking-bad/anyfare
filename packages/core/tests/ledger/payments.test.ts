import { describe, expect, it } from 'vitest';

import { canChangePaymentStatus, paymentStatuses, statusesBefore, utcDay } from '../../src/index.js';

describe('payment status changes', () => {
  it.each([
    ['held', 'captured'],
    ['held', 'released'],
    ['verified', 'settling'],
    ['verified', 'settled'],
    ['verified', 'cancelled'],
    ['verified', 'failed'],
    ['settling', 'settling'],
    ['settling', 'settled'],
    ['settling', 'failed'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(canChangePaymentStatus(from, to)).toBe(true);
  });

  it('allows nothing else, and nothing out of a final status', () => {
    const allowed = paymentStatuses.flatMap(from => paymentStatuses.filter(to => canChangePaymentStatus(from, to)).map(to => `${from}→${to}`));

    expect(allowed).toHaveLength(9);
    for (const final of ['captured', 'settled', 'released', 'cancelled', 'failed'] as const)
      expect(paymentStatuses.filter(to => canChangePaymentStatus(final, to))).toEqual([]);
    expect(statusesBefore('held')).toEqual([]);
    expect(statusesBefore('verified')).toEqual([]);
    expect(statusesBefore('settling')).toEqual(['verified', 'settling']);
    expect(statusesBefore('settled')).toEqual(['verified', 'settling']);
  });
});

describe('dates', () => {
  it('counts a daily budget by the UTC day', () => {
    expect(utcDay(new Date('2026-11-08T23:59:59.999Z'))).toBe('2026-11-08');
    expect(utcDay(new Date('2026-11-09T00:00:00.000Z'))).toBe('2026-11-09');
    // Before 8 in the morning in UTC+8, it is still the day before in UTC
    expect(utcDay(new Date('2026-11-09T07:59:59.999+08:00'))).toBe('2026-11-08');
  });
});
