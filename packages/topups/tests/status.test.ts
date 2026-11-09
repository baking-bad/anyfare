import { describe, expect, it } from 'vitest';

import { fromOneClickStatus, oneClickStatuses, UnknownOneClickStatusError } from '../src/index.js';

describe('fromOneClickStatus', () => {
  it('reads every 1Click status', () => {
    expect(Object.fromEntries(oneClickStatuses.map(status => [status, fromOneClickStatus(status)]))).toEqual({
      KNOWN_DEPOSIT_TX: 'waiting',
      PENDING_DEPOSIT: 'waiting',
      INCOMPLETE_DEPOSIT: 'incomplete',
      PROCESSING: 'processing',
      SUCCESS: 'success',
      REFUNDED: 'refunded',
      FAILED: 'failed',
    });
  });

  it.each(['EXPIRED', 'success', '', 'toString', '__proto__'])('throws for %j', status => {
    expect(() => fromOneClickStatus(status)).toThrow(UnknownOneClickStatusError);
  });

  it('keeps the unknown value, with a stable code', () => {
    expect(() => fromOneClickStatus('EXPIRED')).toThrow(expect.objectContaining({ code: 'oneclick_unknown_status', status: 'EXPIRED', message: 'Unknown 1Click status "EXPIRED"' }));
  });
});
