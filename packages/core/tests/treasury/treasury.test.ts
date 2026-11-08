import { describe, expect, it } from 'vitest';

import type { MicroUsd } from '@anyfare/common';

import { atomicToUsd, findAsset, reconcile, treasuryWallets } from '../../src/index.js';
import { examplePlatform } from '../fixtures.js';

const usd = (value: number): MicroUsd => BigInt(Math.round(value * 1_000_000)) as MicroUsd;

describe('the treasury', () => {
  it('lists each payTo wallet with its assets, and none for an asset without a payTo', () => {
    const wallets = treasuryWallets(examplePlatform);

    expect(wallets.map(wallet => [wallet.role, wallet.assets.map(asset => asset.name)])).toEqual([
      ['pay_to', ['base-usdc']],
      ['pay_to', ['solana-usdc']],
      ['pay_to', ['tempo-pathusd']],
      ['pay_to', ['near-usdc']],
    ]);

    const { payTo: _payTo, ...withoutPayTo } = findAsset(examplePlatform, 'base-usdc')!;
    const config = { ...examplePlatform, assets: [{ ...withoutPayTo, payTo: undefined }, ...examplePlatform.assets.slice(1)] };

    expect(treasuryWallets(config).map(wallet => wallet.name)).toEqual(['payTo:solana-usdc', 'payTo:tempo-pathusd', 'payTo:near-usdc']);
  });

  it('lists the Signer\'s hot wallets from signer.wallets, each with its chain\'s assets: Base\'s, mpp.network\'s for Tempo, and Solana\'s', () => {
    const address = '0x3333333333333333333333333333333333333333';
    const solana = '11111111111111111111111111111111';
    const config = { ...examplePlatform, signer: { ...examplePlatform.signer, wallets: { base: address, tempo: address, solana } } };

    expect(treasuryWallets(config).filter(wallet => wallet.role === 'signer').map(wallet => [wallet.name, wallet.addresses, wallet.assets.map(asset => asset.name)])).toEqual([
      ['signer:base', [address], ['base-usdc']],
      ['signer:tempo', [address], ['tempo-pathusd']],
      ['signer:solana', [solana], ['solana-usdc']],
    ]);
  });

  it('lists no Signer wallet while signer.wallets is empty', () => {
    expect(treasuryWallets(examplePlatform).some(wallet => wallet.role === 'signer')).toBe(false);
  });

  it('compares the ledger\'s holdings with the chain\'s per asset, not counting off-chain credits, and alerts above $1 of drift', () => {
    const solana = findAsset(examplePlatform, 'solana-usdc')!;
    const base = findAsset(examplePlatform, 'base-usdc')!;
    const results = reconcile({
      assets: [solana, base],
      // 100 settled in Solana USDC, 20 in Base USDC. The 50 credited through the internal API never touched a chain
      ledgerBalances: new Map([
        ['platform:treasury:solana-usdc', -100_000_000n], ['platform:deposits_clearing', -50_000_000n], ['platform:treasury:base-usdc', -20_000_000n],
      ]),
      chainBalances: new Map([['solana-usdc', usd(100)], ['base-usdc', usd(18)]]),
    });

    expect(results.get('solana-usdc')).toEqual({ ledger: usd(100), chain: usd(100), drift: 0n, alert: false });
    expect(results.get('base-usdc')).toEqual({ ledger: usd(20), chain: usd(18), drift: usd(-2), alert: true });
  });

  it('converts an asset\'s atomic units to micro-USD, rounding down', () => {
    expect(atomicToUsd(1_500_000_000_000_000_000n, 18)).toBe(usd(1.5));
    expect(atomicToUsd(15_000_009n, 7)).toBe(usd(1.5));
  });
});
