import { describe, expect, it } from 'vitest';

import { findNetwork, isValidAddress, isValidAssetAddress, type NetworkInfo } from '../src/index.js';

const network = (id: string): NetworkInfo => findNetwork(id)!;
const base = network('eip155:8453');
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
