import { describe, expect, it } from 'vitest';

import { createFakeClock, createMemoryClaimStore, fixtureTime } from '../src/index.js';

describe('the memory claim store', () => {
  it('gives a key to its first claim until the claim expires', async () => {
    const clock = createFakeClock(fixtureTime(0, 9, 12, 0, 0, 0));
    const store = createMemoryClaimStore({ clock });
    const expiresAt = clock.now().getTime() + 60_000;

    expect(await store.tryClaim('x402:nonce', expiresAt)).toBe(true);
    expect(await store.tryClaim('x402:nonce', expiresAt)).toBe(false);
    expect(await store.tryClaim('x402:other', expiresAt)).toBe(true);
    expect(store.claims.get('x402:nonce')).toBe(expiresAt);

    clock.advance(60_000);

    expect(await store.tryClaim('x402:nonce', expiresAt + 60_000)).toBe(true);
  });

  it('lets a released key be claimed again', async () => {
    const store = createMemoryClaimStore();
    const expiresAt = Date.now() + 60_000;
    await store.tryClaim('x402:nonce', expiresAt);

    await store.release('x402:nonce');

    expect(store.claims.has('x402:nonce')).toBe(false);
    expect(await store.tryClaim('x402:nonce', expiresAt)).toBe(true);
  });
});
