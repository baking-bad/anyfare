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
      ['treasury', ['near-usdc']],
    ]);

    const { payTo: _payTo, ...withoutPayTo } = findAsset(examplePlatform, 'base-usdc')!;
    const config = { ...examplePlatform, assets: [{ ...withoutPayTo, payTo: undefined }, ...examplePlatform.assets.slice(1)] };

    expect(treasuryWallets(config).map(wallet => wallet.name)).toEqual(['payTo:solana-usdc', 'payTo:tempo-pathusd', 'payTo:near-usdc', 'treasury:near']);
  });

  it('lists the Signer\'s hot wallets from signer.wallets, each with its chain\'s assets: Base\'s, mpp.network\'s for Tempo, Solana\'s, and NEAR\'s', () => {
    const address = '0x3333333333333333333333333333333333333333';
    const solana = '11111111111111111111111111111111';
    const near = 'hot.anyfare.testnet';
    const config = { ...examplePlatform, signer: { ...examplePlatform.signer, wallets: { base: address, tempo: address, solana, near } } };

    expect(treasuryWallets(config).filter(wallet => wallet.role === 'signer').map(wallet => [wallet.name, wallet.addresses, wallet.assets.map(asset => asset.name)])).toEqual([
      ['signer:base', [address], ['base-usdc']],
      ['signer:tempo', [address], ['tempo-pathusd']],
      ['signer:solana', [solana], ['solana-usdc']],
      ['signer:near', [near], ['near-usdc']],
    ]);
    expect(treasuryWallets(config).some(wallet => wallet.signer !== undefined)).toBe(false);
  });

  it('lists the NEAR hot wallet once when it is the account buyers pay: as the payTo row, noted as signer:near', () => {
    const wallets = { ...examplePlatform.signer.wallets, near: findAsset(examplePlatform, 'near-usdc')!.payTo };
    const config = { ...examplePlatform, signer: { ...examplePlatform.signer, wallets } };

    const listed = treasuryWallets(config);

    expect(listed.map(wallet => [wallet.name, wallet.role, wallet.signer, wallet.addresses])).toEqual([
      ['payTo:base-usdc', 'pay_to', undefined, ['0x1111111111111111111111111111111111111111']],
      ['payTo:solana-usdc', 'pay_to', undefined, ['11111111111111111111111111111111']],
      ['payTo:tempo-pathusd', 'pay_to', undefined, ['0x2222222222222222222222222222222222222222']],
      ['payTo:near-usdc', 'pay_to', 'signer:near', ['pay.anyfare.testnet']],
      ['treasury:near', 'treasury', undefined, ['treasury.anyfare.testnet']],
    ]);
    // Each asset of the account once: its balance is never counted twice
    expect(listed.flatMap(wallet => wallet.addresses.flatMap(address => wallet.assets.map(asset => `${asset.name} ${address}`))).filter(entry => entry.endsWith(' pay.anyfare.testnet')))
      .toEqual(['near-usdc pay.anyfare.testnet']);
  });

  it('keeps a signer:near row for the NEAR assets paid to another account than the hot wallet', () => {
    const nearUsdc = findAsset(examplePlatform, 'near-usdc')!;
    const other = { ...nearUsdc, name: 'near-usdt' as typeof nearUsdc.name, address: 'usdt.fakes.testnet', payTo: 'other.anyfare.testnet' };
    const unoffered = { ...nearUsdc, name: 'near-dai' as typeof nearUsdc.name, address: 'dai.fakes.testnet', payTo: undefined };
    const config = {
      ...examplePlatform, assets: [...examplePlatform.assets, other, unoffered],
      signer: { ...examplePlatform.signer, wallets: { ...examplePlatform.signer.wallets, near: nearUsdc.payTo } },
    };

    expect(treasuryWallets(config).filter(wallet => wallet.assets.some(asset => asset.network.chain === 'near'))
      .map(wallet => [wallet.name, wallet.role, wallet.signer, wallet.addresses, wallet.assets.map(asset => asset.name)])).toEqual([
      ['payTo:near-usdc', 'pay_to', 'signer:near', ['pay.anyfare.testnet'], ['near-usdc']],
      ['payTo:near-usdt', 'pay_to', undefined, ['other.anyfare.testnet'], ['near-usdt']],
      ['signer:near', 'signer', undefined, ['pay.anyfare.testnet'], ['near-usdt', 'near-dai']],
      ['treasury:near', 'treasury', undefined, ['treasury.anyfare.testnet'], ['near-usdc']],
    ]);
  });

  it('lists the account top-ups deliver to, with the asset 1Click delivers, whether or not top-ups are on', () => {
    const recipient = (config: typeof examplePlatform) => treasuryWallets(config).filter(wallet => wallet.role === 'treasury')
      .map(wallet => [wallet.name, wallet.signer, wallet.addresses, wallet.assets.map(asset => asset.name)]);
    const expected = [['treasury:near', undefined, ['treasury.anyfare.testnet'], ['near-usdc']]];

    expect(examplePlatform.topups.enabled).toBe(false);
    expect(recipient(examplePlatform)).toEqual(expected);
    expect(recipient({ ...examplePlatform, topups: { ...examplePlatform.topups, enabled: true } })).toEqual(expected);
    expect(treasuryWallets(examplePlatform).find(wallet => wallet.role === 'treasury')?.assets).toEqual([findAsset(examplePlatform, 'near-usdc')]);
  });

  it('lists no top-up account without a recipient or an asset', () => {
    expect(treasuryWallets({ ...examplePlatform, topups: { ...examplePlatform.topups, recipient: undefined } }).some(wallet => wallet.role === 'treasury')).toBe(false);
    expect(treasuryWallets({ ...examplePlatform, topups: { ...examplePlatform.topups, asset: undefined } }).some(wallet => wallet.role === 'treasury')).toBe(false);
  });

  it('lists the top-up account once when a payTo already lists it with the asset', () => {
    const nearUsdc = findAsset(examplePlatform, 'near-usdc')!;
    const config = { ...examplePlatform, topups: { ...examplePlatform.topups, recipient: nearUsdc.payTo } };

    expect(treasuryWallets(config).map(wallet => [wallet.name, wallet.role, wallet.addresses])).toEqual([
      ['payTo:base-usdc', 'pay_to', ['0x1111111111111111111111111111111111111111']],
      ['payTo:solana-usdc', 'pay_to', ['11111111111111111111111111111111']],
      ['payTo:tempo-pathusd', 'pay_to', ['0x2222222222222222222222222222222222222222']],
      ['payTo:near-usdc', 'pay_to', ['pay.anyfare.testnet']],
    ]);
  });

  it('lists the top-up account once when it is the Signer\'s NEAR wallet holding the asset', () => {
    const near = 'treasury.anyfare.testnet';
    const config = { ...examplePlatform, signer: { ...examplePlatform.signer, wallets: { ...examplePlatform.signer.wallets, near } } };

    expect(treasuryWallets(config).filter(wallet => wallet.addresses.includes(near)).map(wallet => [wallet.name, wallet.role, wallet.assets.map(asset => asset.name)])).toEqual([
      ['signer:near', 'signer', ['near-usdc']],
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
