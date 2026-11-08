import { describe, expect, it } from 'vitest';

import { findNetwork, isValidAddress, isValidAssetAddress, type NetworkInfo } from '../src/index.js';

const network = (id: string): NetworkInfo => findNetwork(id)!;
const base = network('eip155:8453');
const near = network('near:mainnet');
const solana = network('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

describe('isValidAddress', () => {
  it('checks EVM and Solana addresses lexically', () => {
    expect(isValidAddress(base, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true);
    expect(isValidAddress(base, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA0291')).toBe(false);
    expect(isValidAddress(base, '833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
    expect(isValidAddress(solana, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isValidAddress(solana, '11111111111111111111111111111111')).toBe(true);
    // 0, O, I and l aren't base58; a 31-byte key isn't a Solana key
    expect(isValidAddress(solana, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt10')).toBe(false);
    expect(isValidAddress(solana, '1111111111111111111111111111111')).toBe(false);
  });
});

describe('isValidAddress on NEAR', () => {
  it('accepts named, implicit and contract accounts', () => {
    expect(isValidAddress(near, 'alice.near')).toBe(true);
    expect(isValidAddress(near, 'buyer.testnet')).toBe(true);
    expect(isValidAddress(near, 'pay.anyfare.testnet')).toBe(true);
    expect(isValidAddress(near, 'a-b_c.d1.near')).toBe(true);
    expect(isValidAddress(near, 'ab')).toBe(true);
    expect(isValidAddress(near, '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')).toBe(true);
  });

  it('refuses malformed account IDs', () => {
    expect(isValidAddress(near, 'a')).toBe(false);
    expect(isValidAddress(near, 'Alice.near')).toBe(false);
    expect(isValidAddress(near, '.near')).toBe(false);
    expect(isValidAddress(near, 'alice..near')).toBe(false);
    expect(isValidAddress(near, 'alice.near.')).toBe(false);
    expect(isValidAddress(near, '-alice.near')).toBe(false);
    expect(isValidAddress(near, 'al--ice.near')).toBe(false);
    expect(isValidAddress(near, 'alice@near')).toBe(false);
    expect(isValidAddress(near, `${'a'.repeat(65)}`)).toBe(false);
    expect(isValidAddress(near, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
    expect(isValidAddress(base, 'alice.near')).toBe(false);
  });
});

describe('isValidAssetAddress', () => {
  it('accepts the registry\'s assets', () => {
    expect(isValidAssetAddress(base, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true);
    expect(isValidAssetAddress(solana, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
  });

  it('refuses an address of the wrong kind', () => {
    expect(isValidAssetAddress(base, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false);
    expect(isValidAssetAddress(solana, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
  });
});
