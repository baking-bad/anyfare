import { describe, expect, it } from 'vitest';

import { createFakeClock, fixtureTime } from '@anyfare/testing';

import { createOutcomeMemory, maxOutcomes, outcomeRetentionMs, requirementOf } from '../src/outcomes.js';

const requirement = requirementOf({ network: 'near:testnet', asset: 'usdc.test.near', amount: '10000', payTo: 'pay.test.near' });
const settle = (transaction: string, maxBlockHeight = 1_000n) => ({ transaction, payer: 'buyer.test.near', network: 'near:testnet', requirement, maxBlockHeight });

describe('the outcome memory', () => {
  it('keeps a settle from its signing as pending, then its final outcome', () => {
    const memory = createOutcomeMemory({ clock: createFakeClock(fixtureTime()) });

    memory.pending('key', settle('first'));
    expect(memory.get('key')).toMatchObject({ outcome: { state: 'pending', transaction: 'first' }, payer: 'buyer.test.near', requirement });
    // Signed again with a new nonce: the new hash
    memory.pending('key', settle('second'));
    expect(memory.get('key')?.outcome).toEqual({ state: 'pending', transaction: 'second' });

    memory.finish('key', { state: 'settled', transaction: 'second' });
    expect(memory.get('key')?.outcome).toEqual({ state: 'settled', transaction: 'second' });
    // Only a settle it holds
    memory.finish('other', { state: 'failed', reason: 'settlement_failed', message: undefined, transaction: '' });
    expect(memory.get('other')).toBeUndefined();
  });

  it('forgets a settle 10 minutes after the height has passed its delegate action\'s max_block_height', () => {
    const clock = createFakeClock(fixtureTime());
    const memory = createOutcomeMemory({ clock });
    memory.pending('key', settle('hash', 1_000n));

    memory.observeHeight(1_000n);
    clock.advance(60 * 60_000);
    expect(memory.get('key')).toBeDefined();

    memory.observeHeight(1_001n);
    clock.advance(10 * 60_000 - 1);
    expect(memory.get('key')).toBeDefined();
    clock.advance(1);
    expect(memory.get('key')).toBeUndefined();
  });

  it('starts the 10 minutes at once for a settle signed past its height, and sweeps on a new height', () => {
    const clock = createFakeClock(fixtureTime());
    const memory = createOutcomeMemory({ clock });
    memory.observeHeight(2_000n);
    memory.pending('late', settle('hash', 1_000n));
    memory.pending('current', settle('hash', 5_000n));

    clock.advance(10 * 60_000);
    memory.observeHeight(2_001n);

    expect(memory.size).toBe(1);
    expect(memory.get('current')).toBeDefined();
  });

  it('keeps its capacity at most, 10,000 by default, the oldest going first', () => {
    const memory = createOutcomeMemory({ clock: createFakeClock(fixtureTime()), capacity: 3 });
    for (const key of ['a', 'b', 'c', 'd'])
      memory.pending(key, settle(key));

    expect(memory.size).toBe(3);
    expect(memory.get('a')).toBeUndefined();
    expect(memory.get('d')).toBeDefined();
    expect(maxOutcomes).toBe(10_000);
    expect(outcomeRetentionMs).toBe(10 * 60_000);
  });
});
