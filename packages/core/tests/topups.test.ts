import { describe, expect, it } from 'vitest';

import { isTopupStatus, openTopupStatuses, topupMessages, topupStatuses } from '../src/index.js';

describe('top-up statuses', () => {
  it('are the ten a top-up row can have', () => {
    expect(topupStatuses).toEqual(['quoting', 'quote_failed', 'quote_unknown', 'waiting', 'incomplete', 'processing', 'credited', 'refunded', 'failed', 'expired']);
  });

  it('each have a short message in plain words', () => {
    expect(Object.keys(topupMessages).sort()).toEqual([...topupStatuses].sort());
    for (const status of topupStatuses) {
      expect(topupMessages[status]).toMatch(/^[A-Z]/);
      expect(topupMessages[status].length).toBeLessThanOrEqual(80);
    }
    expect(topupMessages.waiting).toBe('Waiting for your transfer');
    expect(topupMessages.credited).toBe('Added to your balance');
    expect(topupMessages.expired).toBe('The time to pay ran out. Don\'t send to this address');
    expect(Object.isFrozen(topupMessages)).toBe(true);
  });

  it('poll the open ones only: waiting, incomplete and processing', () => {
    expect(openTopupStatuses).toEqual(['waiting', 'incomplete', 'processing']);
  });

  it('tell a status from another string', () => {
    expect(isTopupStatus('credited')).toBe(true);
    expect(isTopupStatus('CREDITED')).toBe(false);
    expect(isTopupStatus('success')).toBe(false);
  });
});
