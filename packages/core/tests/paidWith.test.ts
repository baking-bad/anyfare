import { describe, expect, it } from 'vitest';

import { assetToken } from '../src/index.js';

describe('assetToken', () => {
  it('names a registry asset\'s token as people write it, and any other in capitals', () => {
    expect(['base-usdc', 'near-usdc', 'tempo-usdce', 'tempo-pathusd', 'base-eurc'].map(assetToken)).toEqual(['USDC', 'USDC', 'USDC.e', 'pathUSD', 'EURC']);
  });
});
