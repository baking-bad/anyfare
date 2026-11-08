import { describe, expect, it } from 'vitest';

import { paymentMethodsFor, type PlatformConfig } from '../src/index.js';
import { examplePlatform as base } from './fixtures.js';

const withMpp = (change: Partial<PlatformConfig['mpp']>): PlatformConfig => ({ ...base, mpp: { ...base.mpp, ...change } });
const withAssets = (assets: PlatformConfig['assets']): PlatformConfig => ({ ...base, assets });
const asset = (name: string): PlatformConfig['assets'][number] => base.assets.find(candidate => candidate.name === name)!;

describe('paymentMethodsFor', () => {
  it('offers credits, x402 and MPP when each has an asset that accepts the price', () => {
    expect(paymentMethodsFor(1_000n, base)).toEqual(['credits', 'x402', 'mpp']);
  });

  it('drops MPP without a recipient or when disabled', () => {
    expect(paymentMethodsFor(1_000n, withMpp({ recipient: undefined }))).toEqual(['credits', 'x402']);
    expect(paymentMethodsFor(1_000n, withMpp({ enabled: false }))).toEqual(['credits', 'x402']);
  });

  it('drops x402 when no facilitated asset with a payTo accepts the price', () => {
    expect(paymentMethodsFor(1_000n, withAssets([asset('tempo-pathusd')]))).toEqual(['credits', 'mpp']);
    expect(paymentMethodsFor(1_000n, withAssets([{ ...asset('base-usdc'), payTo: undefined }, asset('tempo-pathusd')]))).toEqual(['credits', 'mpp']);
    expect(paymentMethodsFor(1_000n, withAssets([{ ...asset('base-usdc'), minPrice: 5_000n }, asset('tempo-pathusd')]))).toEqual(['credits', 'mpp']);
    expect(paymentMethodsFor(5_000n, withAssets([{ ...asset('base-usdc'), minPrice: 5_000n }, asset('tempo-pathusd')]))).toEqual(['credits', 'x402', 'mpp']);
    expect(paymentMethodsFor(1_000n, { ...base, facilitators: base.facilitators.map(facilitator => ({ ...facilitator, enabled: false })) })).toEqual(['credits', 'mpp']);
  });

  it('drops MPP when no asset on its network accepts the price', () => {
    expect(paymentMethodsFor(1_000n, withAssets([asset('base-usdc'), { ...asset('tempo-pathusd'), minPrice: 5_000n }]))).toEqual(['credits', 'x402']);
  });
});
