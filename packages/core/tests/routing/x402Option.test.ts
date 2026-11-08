import { describe, expect, it } from 'vitest';

import { asExactX402Option, checkX402Option, findAsset, findNetwork, findOptionAsset, maxX402TimeoutSeconds } from '../../src/index.js';
import { examplePlatform } from '../fixtures.js';

// config/example.yaml: USDC on Base Sepolia and on Solana Devnet
const baseUsdc = findAsset(examplePlatform, 'base-usdc')!;
const solanaUsdc = findAsset(examplePlatform, 'solana-usdc')!;
const base = findNetwork('eip155:84532')!;
const solana = findNetwork('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')!;
// Made-up Solana accounts: the target's, its facilitator's fee payer, and our wallet
const base58Of = (byte: number): string => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = Array.from({ length: 32 }, () => byte).reduce((result, item) => (result << 8n) | BigInt(item), 0n);
  let text = '';
  for (; value > 0n; value /= 58n)
    text = alphabet[Number(value % 58n)] + text;

  return text;
};
const solanaPayTo = base58Of(7);
const feePayer = base58Of(9);
const ourWallet = base58Of(5);

const onBase = (overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: base.id, amount: '1500', asset: baseUsdc.address, payTo: '0x6666666666666666666666666666666666666666', maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2', ...extra }, ...overrides,
});
const onSolana = (overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: solana.id, amount: '1500', asset: solanaUsdc.address, payTo: solanaPayTo, maxTimeoutSeconds: 60, extra: { feePayer, ...extra }, ...overrides,
});
const checkBase = (option: unknown) => checkX402Option(option, { asset: baseUsdc, network: base });
const checkSolana = (option: unknown) => checkX402Option(option, { asset: solanaUsdc, network: solana, ourSolanaWallet: ourWallet });

describe('a routed target\'s x402 option', () => {
  it('pays an EIP-3009 authorization on Base, at its price rounded up to the micro-USD', () => {
    expect(checkBase(onBase())).toEqual({ ok: true, atomicAmount: 1_500n, price: 1_500n });
    expect(checkBase(onBase({ maxTimeoutSeconds: maxX402TimeoutSeconds }, { assetTransferMethod: 'eip3009', paymentFlow: 'authorization' }))).toMatchObject({ ok: true });
    // An 18-decimal asset: a fraction of a micro-USD costs a whole one
    expect(checkX402Option(onBase({ amount: '1000000000001' }), { asset: { ...baseUsdc, decimals: 18 }, network: base })).toMatchObject({ price: 2n });
  });

  it('pays a USDC transfer on Solana whose fee the target\'s facilitator pays', () => {
    expect(checkSolana(onSolana())).toEqual({ ok: true, atomicAmount: 1_500n, price: 1_500n });
    expect(checkSolana(onSolana({}, { transactionVersions: [0], memo: 'm'.repeat(256) }))).toMatchObject({ ok: true });
    expect(checkSolana(onSolana({}, { transactionVersions: [0, 1] }))).toMatchObject({ ok: true });
    // Without our wallet, no fee payer is ours
    expect(checkX402Option(onSolana({}, { feePayer: ourWallet }), { asset: solanaUsdc, network: solana })).toMatchObject({ ok: true });
  });

  it.each([
    ['an option that isn\'t a record', 'exact', 'not_exact'],
    ['another scheme', onBase({ scheme: 'upto' }), 'not_exact'],
    ['no network', onBase({ network: undefined }), 'not_exact'],
    ['an asset that isn\'t a string', onBase({ asset: 5 }), 'not_exact'],
    ['a payTo that isn\'t an address', onBase({ payTo: '0x1' }), 'invalid_pay_to'],
    ['no payTo', onBase({ payTo: undefined }), 'invalid_pay_to'],
    ['no maxTimeoutSeconds', onBase({ maxTimeoutSeconds: undefined }), 'invalid_timeout'],
    ['maxTimeoutSeconds as the string "99"', onBase({ maxTimeoutSeconds: '99' }), 'invalid_timeout'],
    ['maxTimeoutSeconds of 1e9', onBase({ maxTimeoutSeconds: 1e9 }), 'invalid_timeout'],
    ['maxTimeoutSeconds of 301', onBase({ maxTimeoutSeconds: 301 }), 'invalid_timeout'],
    ['maxTimeoutSeconds of 0', onBase({ maxTimeoutSeconds: 0 }), 'invalid_timeout'],
    ['maxTimeoutSeconds of 1.5', onBase({ maxTimeoutSeconds: 1.5 }), 'invalid_timeout'],
    ['an upfront payment flow', onBase({}, { paymentFlow: 'upfront' }), 'invalid_option'],
    ['Permit2', onBase({}, { assetTransferMethod: 'permit2' }), 'transfer_method'],
    ['a Gateway nanopayment', onBase({}, { name: 'GatewayWalletBatched' }), 'transfer_method'],
    ['no EIP-712 name', onBase({ extra: { version: '2' } }), 'invalid_option'],
    ['an empty EIP-712 version', onBase({}, { version: '' }), 'invalid_option'],
    ['extra that isn\'t a record', onBase({ extra: 'USDC' }), 'invalid_option'],
    ['an amount that isn\'t a string', onBase({ amount: 1500 }), 'invalid_amount'],
    ['a zero amount', onBase({ amount: '0' }), 'invalid_amount'],
    ['an amount of 31 digits', onBase({ amount: '9'.repeat(31) }), 'invalid_amount'],
  ])('refuses on Base %s', (_name, option, refusal) => {
    expect(checkBase(option)).toEqual({ refusal });
  });

  it.each([
    ['a payTo that isn\'t a Solana address', onSolana({ payTo: '0x6666666666666666666666666666666666666666' }), 'invalid_pay_to'],
    ['no fee payer', onSolana({ extra: {} }), 'no_fee_payer'],
    ['an empty fee payer', onSolana({}, { feePayer: '' }), 'no_fee_payer'],
    ['our wallet as the fee payer', onSolana({}, { feePayer: ourWallet }), 'fee_payer_is_us'],
    ['a fee payer that isn\'t an address', onSolana({}, { feePayer: 'not-an-address' }), 'invalid_option'],
    ['transaction version 2', onSolana({}, { transactionVersions: [2] }), 'invalid_option'],
    ['no transaction version', onSolana({}, { transactionVersions: [] }), 'invalid_option'],
    ['transaction versions that aren\'t a list', onSolana({}, { transactionVersions: '0' }), 'invalid_option'],
    ['a memo of 257 bytes', onSolana({}, { memo: 'm'.repeat(257) }), 'invalid_option'],
    ['a memo that isn\'t text', onSolana({}, { memo: 5 }), 'invalid_option'],
    ['an escrow payment flow', onSolana({}, { paymentFlow: 'escrow' }), 'invalid_option'],
    ['maxTimeoutSeconds of 301', onSolana({ maxTimeoutSeconds: 301 }), 'invalid_timeout'],
    ['an amount that isn\'t atomic', onSolana({ amount: '0.001' }), 'invalid_amount'],
  ])('refuses on Solana %s', (_name, option, refusal) => {
    expect(checkSolana(option)).toEqual({ refusal });
  });
});

describe('an x402 option\'s network and asset', () => {
  it('is an exact option with both as strings', () => {
    expect(asExactX402Option(onBase())).toMatchObject({ scheme: 'exact', network: base.id });
    expect(asExactX402Option(onBase({ scheme: 'upto' }))).toBeUndefined();
    expect(asExactX402Option(null)).toBeUndefined();
  });

  it('finds the registry\'s asset, matching EVM addresses in any case and base58 ones exactly', () => {
    expect(findOptionAsset(examplePlatform, base, baseUsdc.address.toLowerCase())).toBe(baseUsdc);
    expect(findOptionAsset(examplePlatform, solana, solanaUsdc.address)).toBe(solanaUsdc);
    expect(findOptionAsset(examplePlatform, solana, solanaUsdc.address.toLowerCase())).toBeUndefined();
    expect(findOptionAsset(examplePlatform, solana, baseUsdc.address)).toBeUndefined();
  });
});
