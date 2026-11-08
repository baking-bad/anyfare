import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { Challenge, Receipt } from 'mppx';
import { describe, expect, it } from 'vitest';

import type { MicroUsd } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { encodeBase58, fixtureTime } from '@anyfare/testing';

import {
  chooseOption, InvalidTargetError, mppRefusals, parseRoutingTarget, parseTargetChallenge, routingQuote, solanaRefusals, targetReceipt, x402Refusals,
} from '../src/index.js';

const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
const baseUsdc = config.assets.find(asset => asset.name === 'base-usdc')!;
const usdc = baseUsdc.address;
const pathUsd = config.assets.find(asset => asset.name === 'tempo-pathusd')!.address;
const base = 'eip155:84532';
const now = new Date(fixtureTime(0, 8, 12, 0, 0, 0));
const expires = fixtureTime(0, 8, 12, 5, 0, 0);

/** A target's Tempo charge, as `mppx`'s server writes it in `WWW-Authenticate: Payment`. */
const mppChallenge = (amount: string, details: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): string => Challenge.serialize(Challenge.from({
  id: `challenge-${amount}`, realm: 'api.target.test', method: 'tempo', intent: 'charge', expires,
  request: { amount, currency: pathUsd, recipient: '0x5555555555555555555555555555555555555555', methodDetails: { chainId: 42_431, supportedModes: ['pull'], ...details } },
  ...overrides,
} as never));

describe('the routing link', () => {
  it('takes the host, path, and query, and targets HTTPS', () => {
    expect(parseRoutingTarget('/API.Example.com/v1/pools?limit=10')).toEqual({
      host: 'api.example.com', hostname: 'api.example.com', path: '/v1/pools', search: '?limit=10', url: 'https://api.example.com/v1/pools?limit=10',
    });
    expect(parseRoutingTarget('/api.example.com:8443')).toMatchObject({ host: 'api.example.com:8443', hostname: 'api.example.com', path: '/' });
  });

  it('takes ports from 1 to 65535, and drops 443 as the URL does', () => {
    expect(parseRoutingTarget('/api.example.com:1/v1')).toMatchObject({ host: 'api.example.com:1', url: 'https://api.example.com:1/v1' });
    expect(parseRoutingTarget('/api.example.com:65535/v1')).toMatchObject({ host: 'api.example.com:65535', url: 'https://api.example.com:65535/v1' });
    expect(parseRoutingTarget('/api.example.com:443/v1')).toMatchObject({ host: 'api.example.com', url: 'https://api.example.com/v1' });
  });

  it.each([
    '/10.0.0.1/v1', '/[::1]/v1', '/localhost/v1', '/https:/api.example.com', '/api.example.com:http/v1',
    // A host the URL parser would read differently from the checks
    '/allowed.com:443:@evil.com/x', '/allowed.com:80:@169.254.169.254/latest', '/allowed.com@169.254.169.254/latest', '/allowed.com:443@evil.com/x',
    '/user:pass@allowed.com/x', '/user@allowed.com/x', '/allowed.com#@evil.com/x', '/allowed.com\\@evil.com/x',
    // Ports out of range, or more than one
    '/allowed.com:99999/x', '/allowed.com:65536/x', '/allowed.com:0/x', '/allowed.com:/x', '/a.com:1:2/x',
  ])('refuses %s with invalid_target', path => {
    expect(() => parseRoutingTarget(path)).toThrow(InvalidTargetError);
  });

  it('reads a ? in the host segment as the start of the query, so the host stays the one checked', () => {
    const target = parseRoutingTarget('/allowed.com?@evil.com/x');

    expect(target).toMatchObject({ host: 'allowed.com', path: '/', search: '?@evil.com/x' });
    expect(new URL(target.url).host).toBe('allowed.com');
  });
});

describe('choosing the target\'s option and the quote', () => {
  const plain = {
    scheme: 'exact', network: base, amount: '2000', asset: usdc, payTo: '0x6666666666666666666666666666666666666666', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
  };
  const required = (body: unknown) => ({ 'payment-required': encodePaymentRequiredHeader(body as never) });
  const header = (accepts: unknown[]) => required({ x402Version: 2, resource: { url: 'https://a.b/c' }, accepts });
  const parsed = (accepts: unknown[]) => parseTargetChallenge(header(accepts))!;

  it('reads the v2 header, and no v1 body', () => {
    expect(parseTargetChallenge(header([plain]))).toMatchObject({ x402Version: 2, accepts: [plain] });
    // A v1-only target offers nothing we pay
    expect(parseTargetChallenge({ 'content-type': 'application/json' })).toBeUndefined();
  });

  it('takes a header with x402 version 1 for the log, and pays none of its options', () => {
    const challenge = parseTargetChallenge(required({ x402Version: 1, accepts: [plain] }))!;

    expect(challenge).toMatchObject({ x402Version: 1, accepts: [plain] });
    expect(chooseOption(challenge, config, now)).toBeUndefined();
  });

  it.each([{}, 5, true, 'accepts', null])('ignores a header whose accepts is %j, and keeps the MPP challenges', accepts => {
    expect(parseTargetChallenge(required({ x402Version: 2, accepts }))).toBeUndefined();
    expect(parseTargetChallenge({ ...required({ x402Version: 2, accepts }), 'www-authenticate': mppChallenge('1000') }))
      .toMatchObject({ x402Version: 0, accepts: [], mpp: [{ id: 'challenge-1000' }] });
  });

  it.each(['2', null, undefined])('ignores a header whose x402Version is %j', x402Version => {
    expect(parseTargetChallenge(required({ x402Version, accepts: [plain] }))).toBeUndefined();
  });

  it('ignores a header that is not base64 of a JSON object', () => {
    expect(parseTargetChallenge({ 'payment-required': `***${header([plain])['payment-required']}` })).toBeUndefined();
    expect(parseTargetChallenge({ 'payment-required': Buffer.from(JSON.stringify([plain])).toString('base64') })).toBeUndefined();
    expect(parseTargetChallenge({ 'payment-required': Buffer.from('not json').toString('base64') })).toBeUndefined();
  });

  it('never throws on options of any JSON shape, and pays the one it can', () => {
    const challenge = parsed([
      null, 5, 'exact', true, [], [plain], {},
      { scheme: 'exact' }, { scheme: 'exact', network: 5, asset: usdc, amount: '1' }, { scheme: 'exact', network: base, asset: [usdc], amount: '1' },
      { ...plain, extra: null }, { ...plain, extra: 'USDC' }, { ...plain, extra: [] }, { ...plain, amount: '5', extra: 'not a record' }, { ...plain, amount: '7' },
      { scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', asset: 5, amount: '1', extra: null },
      { scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', extra: 'feePayer' },
    ]);

    expect(() => solanaRefusals(challenge, config)).not.toThrow();
    expect(solanaRefusals(challenge, config)).toEqual(['no_fee_payer', 'no_fee_payer']);
    expect(x402Refusals(challenge, config)).toEqual([
      'not_exact', 'not_exact', 'not_exact', 'not_exact', 'not_exact', 'not_exact', 'not_exact', 'not_exact', 'not_exact', 'not_exact',
      'invalid_option', 'invalid_option', 'invalid_option', 'invalid_option', 'not_exact', 'not_exact',
    ]);
    expect(chooseOption(challenge, config, now)).toMatchObject({ protocol: 'x402', atomicAmount: 7n, requirement: { amount: '7' } });
  });

  it('picks the cheapest exact option on a network we pay, skipping Gateway nanopayments and unknown assets', () => {
    const challenge = parsed([
      { ...plain, amount: '10000000' },
      { ...plain, amount: '100', extra: { name: 'GatewayWalletBatched', version: '1' } },
      { ...plain, amount: '50', asset: '0x0000000000000000000000000000000000000001' },
      { ...plain, amount: '10', network: 'eip155:1' },
      { ...plain, amount: '5', scheme: 'upto' },
      plain,
    ]);

    expect(chooseOption(challenge, config, now)).toMatchObject({ protocol: 'x402', asset: { name: 'base-usdc' }, atomicAmount: 2000n, price: 2000n });
    expect(chooseOption(parsed([{ ...plain, scheme: 'upto' }]), config, now)).toBeUndefined();
  });

  it('pays only an option with a decimal string amount, of up to 30 digits', () => {
    expect(chooseOption(parsed([{ ...plain, amount: null, maxAmountRequired: '1' }]), config, now)).toBeUndefined();
    expect(chooseOption(parsed([{ ...plain, amount: undefined, maxAmountRequired: '1' }]), config, now)).toBeUndefined();
    expect(chooseOption(parsed([{ ...plain, amount: 2000 }]), config, now)).toBeUndefined();
    expect(chooseOption(parsed([{ ...plain, amount: '0' }]), config, now)).toBeUndefined();
    expect(chooseOption(parsed([{ ...plain, amount: '-1' }]), config, now)).toBeUndefined();
    expect(chooseOption(parsed([{ ...plain, amount: '1e3' }]), config, now)).toBeUndefined();
    expect(chooseOption(parsed([{ ...plain, amount: '9'.repeat(30) }]), config, now))
      .toMatchObject({ atomicAmount: BigInt('9'.repeat(30)), price: BigInt('9'.repeat(30)) });
    expect(chooseOption(parsed([{ ...plain, amount: '9'.repeat(31) }]), config, now)).toBeUndefined();
  });

  it('prices assets of other decimals in micro-USD, rounded up', () => {
    const wad = { ...baseUsdc, name: 'base-wad', address: '0x1818181818181818181818181818181818181818', decimals: 18 };
    const cents = { ...baseUsdc, name: 'base-cents', address: '0x0202020202020202020202020202020202020202', decimals: 2 };
    const withDecimals: PlatformConfig = { ...config, assets: [...config.assets, wad, cents] };
    const choose = (asset: string, amount: string) => chooseOption(parsed([{ ...plain, asset, amount }]), withDecimals, now);

    expect(choose(wad.address, '2000000000000')).toMatchObject({ asset: { name: 'base-wad' }, atomicAmount: 2_000_000_000_000n, price: 2n });
    expect(choose(wad.address, '1000000000000000001')).toMatchObject({ atomicAmount: 1_000_000_000_000_000_001n, price: 1_000_001n });
    expect(choose(wad.address, '1')).toMatchObject({ price: 1n });
    expect(choose(cents.address, '150')).toMatchObject({ asset: { name: 'base-cents' }, atomicAmount: 150n, price: 1_500_000n });
  });

  it('matches EVM asset addresses in any case', () => {
    expect(chooseOption(parsed([{ ...plain, asset: usdc.toLowerCase() }]), config, now)).toMatchObject({ asset: { name: 'base-usdc' } });
    expect(chooseOption(parsed([{ ...plain, asset: usdc.toUpperCase().replace('0X', '0x') }]), config, now)).toMatchObject({ asset: { name: 'base-usdc' } });
  });

  it('skips an option the Signer would refuse, such as Permit2 listed first, and pays the next one at the same price', () => {
    const challenge = parsed([{ ...plain, extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } }, { ...plain, extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' } }]);

    expect(chooseOption(challenge, config, now)).toMatchObject({ protocol: 'x402', requirement: { extra: { assetTransferMethod: 'eip3009' } } });
    expect(x402Refusals(challenge, config)).toEqual(['transfer_method']);
  });

  it('pays an option with up to 5 minutes to settle, and skips a longer one', () => {
    const challenge = parsed([{ ...plain, amount: '1000', maxTimeoutSeconds: 301 }, { ...plain, amount: '1001', maxTimeoutSeconds: 300 }]);

    expect(chooseOption(challenge, config, now)).toMatchObject({ protocol: 'x402', atomicAmount: 1001n, requirement: { maxTimeoutSeconds: 300 } });
    expect(x402Refusals(challenge, config)).toEqual(['invalid_timeout']);
    expect(chooseOption(parsed([{ ...plain, maxTimeoutSeconds: '99' }]), config, now)).toBeUndefined();
  });

  it.each([
    ['a payTo that isn\'t an address', { payTo: '0x1' }, 'invalid_pay_to'],
    ['an upfront payment flow', { extra: { name: 'USDC', version: '2', paymentFlow: 'upfront' } }, 'invalid_option'],
    ['a Gateway nanopayment', { extra: { name: 'GatewayWalletBatched', version: '1' } }, 'transfer_method'],
    ['an asset outside the registry', { asset: '0x0000000000000000000000000000000000000001' }, 'not_in_registry'],
    ['a network we don\'t pay x402 on', { network: 'eip155:42431', asset: pathUsd }, 'not_in_registry'],
    ['no amount', { amount: '0' }, 'invalid_amount'],
  ])('skips %s, and says why', (_name, overrides, refusal) => {
    const challenge = parsed([{ ...plain, ...overrides }]);

    expect(chooseOption(challenge, config, now)).toBeUndefined();
    expect(x402Refusals(challenge, config)).toEqual([refusal]);
  });

  it('gives no x402 reason for a challenge whose options aren\'t version 2', () => {
    expect(x402Refusals(parseTargetChallenge(required({ x402Version: 1, accepts: [{}] }))!, config)).toEqual([]);
  });

  it('reads an MPP challenge of WWW-Authenticate: Payment, alone or beside x402, keeping its expiry and digest', () => {
    const alone = parseTargetChallenge({ 'www-authenticate': mppChallenge('1000', {}, { digest: 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:' }) })!;
    const both = parseTargetChallenge({ ...header([plain]), 'www-authenticate': [mppChallenge('1000'), mppChallenge('2000')] })!;

    expect(alone).toMatchObject({ x402Version: 0, accepts: [], mpp: [{ method: 'tempo', intent: 'charge', expires }] });
    expect(alone.mpp[0]!.digest).toBeDefined();
    expect(both).toMatchObject({ x402Version: 2, accepts: [plain] });
    expect(both.mpp.map(item => item.request['amount'])).toEqual(['1000', '2000']);
    expect(parseTargetChallenge({ 'www-authenticate': 'Bearer realm="api"' })).toBeUndefined();
  });

  it('keeps every MPP challenge that parses when another in the same header does not', () => {
    const broken = 'Payment id="broken", realm="api.target.test", method="tempo"';
    const ids = (value: string) => parseTargetChallenge({ 'www-authenticate': value })?.mpp.map(item => item.id);

    expect(ids(`${mppChallenge('1000')}, ${broken}`)).toEqual(['challenge-1000']);
    expect(ids(`${broken}, ${mppChallenge('1000')}`)).toEqual(['challenge-1000']);
    expect(ids(`${mppChallenge('1000')}, ${broken}, ${mppChallenge('2000')}`)).toEqual(['challenge-1000', 'challenge-2000']);
    expect(ids(`Bearer realm="api", ${mppChallenge('1000')},Payment request="e30", ${mppChallenge('2000')}`)).toEqual(['challenge-1000', 'challenge-2000']);
    expect(ids(broken)).toBeUndefined();
  });

  it('keeps a challenge whole when a quoted value holds a comma and Payment', () => {
    const challenge = parseTargetChallenge({ 'www-authenticate': `${mppChallenge('1000', {}, { description: 'Pay, Payment due "now"' })}, ${mppChallenge('2000')}` })!;

    expect(challenge.mpp.map(item => [item.id, item.description])).toEqual([['challenge-1000', 'Pay, Payment due "now"'], ['challenge-2000', undefined]]);
  });

  it('chooses an MPP Tempo charge at its price, rounded up, and binds no quote to a body unless its challenge does', () => {
    const chosen = chooseOption(parseTargetChallenge({ 'www-authenticate': mppChallenge('1500') })!, config, now);

    expect(chosen).toMatchObject({ protocol: 'mpp', asset: { name: 'tempo-pathusd' }, atomicAmount: 1500n, price: 1500n, expires, bindsBody: false });
    expect(chosen?.protocol === 'mpp' && Challenge.deserialize(chosen.challenge).id).toBe('challenge-1500');
  });

  it('chooses x402 on Base on a tie, and MPP on Tempo when it is cheaper', () => {
    const tie = parseTargetChallenge({ ...header([plain]), 'www-authenticate': mppChallenge('2000') })!;
    const cheaper = parseTargetChallenge({ ...header([plain]), 'www-authenticate': mppChallenge('1999') })!;

    expect(chooseOption(tie, config, now)).toMatchObject({ protocol: 'x402', price: 2000n });
    expect(chooseOption(cheaper, config, now)).toMatchObject({ protocol: 'mpp', price: 1999n });
  });

  describe('x402 targets on Solana', () => {
    const solanaUsdc = config.assets.find(asset => asset.name === 'solana-usdc')!;
    const ourWallet = encodeBase58(Uint8Array.from({ length: 32 }, () => 7));
    const theirFeePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 8));
    const theirPayTo = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
    const withWallet = { ...config, signer: { ...config.signer, wallets: { ...config.signer.wallets, solana: ourWallet } } };
    const onSolana = (amount: string, extra: Record<string, unknown> = { feePayer: theirFeePayer }) => ({
      scheme: 'exact', network: solanaUsdc.network.id, amount, asset: solanaUsdc.address, payTo: theirPayTo, maxTimeoutSeconds: 60, extra,
    });

    it('pays USDC on Solana at its price when the option names its facilitator\'s fee payer', () => {
      expect(chooseOption(parsed([onSolana('1500')]), withWallet, now))
        .toMatchObject({ protocol: 'x402', asset: { name: 'solana-usdc' }, atomicAmount: 1500n, price: 1500n });
    });

    it('matches the mint\'s base58 address exactly: another case is another address', () => {
      const flipped = solanaUsdc.address.replace('z', 'Z');

      expect(flipped).not.toBe(solanaUsdc.address);
      expect(chooseOption(parsed([{ ...onSolana('1500'), asset: flipped }]), withWallet, now)).toBeUndefined();
      expect(chooseOption(parsed([{ ...onSolana('1500'), asset: solanaUsdc.address.toLowerCase() }]), withWallet, now)).toBeUndefined();
    });

    it('pays no Solana option without a fee payer, or whose fee payer is our own wallet, and says why', () => {
      const challenge = parsed([onSolana('1000', {}), onSolana('1001', { feePayer: ourWallet })]);

      expect(chooseOption(challenge, withWallet, now)).toBeUndefined();
      expect(solanaRefusals(challenge, withWallet)).toEqual(['no_fee_payer', 'fee_payer_is_us']);
      // Base options give no Solana reason, nor does a challenge whose options aren't version 2
      expect(solanaRefusals(parsed([plain]), withWallet)).toEqual([]);
      expect(solanaRefusals(parseTargetChallenge(required({ x402Version: 1, accepts: [onSolana('1000', {})] }))!, withWallet)).toEqual([]);
    });

    it('takes no fee payer for ours when the config names no Solana wallet', () => {
      const challenge = parsed([onSolana('1000', {}), onSolana('1001', { feePayer: ourWallet })]);

      expect(config.signer.wallets.solana).toBeUndefined();
      expect(solanaRefusals(challenge, config)).toEqual(['no_fee_payer']);
      expect(chooseOption(challenge, config, now)).toMatchObject({ protocol: 'x402', asset: { name: 'solana-usdc' }, atomicAmount: 1001n });
    });

    it('chooses Base, then Solana, then MPP on Tempo at the same price, and a cheaper Solana option over both', () => {
      const all = (solanaAmount: string) => parseTargetChallenge({ ...header([onSolana(solanaAmount), plain]), 'www-authenticate': mppChallenge('2000') })!;
      const withoutBase = parseTargetChallenge({ ...header([onSolana('2000')]), 'www-authenticate': mppChallenge('2000') })!;

      expect(chooseOption(all('2000'), withWallet, now)).toMatchObject({ protocol: 'x402', asset: { name: 'base-usdc' } });
      expect(chooseOption(withoutBase, withWallet, now)).toMatchObject({ protocol: 'x402', asset: { name: 'solana-usdc' } });
      expect(chooseOption(all('1999'), withWallet, now)).toMatchObject({ protocol: 'x402', asset: { name: 'solana-usdc' }, price: 1999n });
    });
  });

  it('pays no MPP challenge in push mode only, with splits, in another currency, on another chain, or expired, and says why', () => {
    const challenge = parseTargetChallenge({
      'www-authenticate': [
        mppChallenge('1000', { supportedModes: ['push'] }),
        mppChallenge('1001', { splits: [{ amount: '100', recipient: '0x6666666666666666666666666666666666666666' }] }),
        mppChallenge('1002', {}, { request: { amount: '1002', currency: '0x20c0000000000000000000000000000000000001', recipient: '0x5555555555555555555555555555555555555555' } }),
        mppChallenge('1003', { chainId: 4_217 }),
        mppChallenge('1004', {}, { expires: fixtureTime(0, 8, 11, 59, 59, 0) }),
      ].join(', '),
    })!;

    expect(challenge.mpp).toHaveLength(5);
    expect(chooseOption(challenge, config, now)).toBeUndefined();
    expect(mppRefusals(challenge, config, now)).toEqual(['push_only', 'splits', 'unsupported_currency', 'wrong_chain', 'expired']);
  });

  it('takes an MPP expiry that isn\'t a date for expired, and a challenge without one for current', () => {
    const undated = mppChallenge('1000', {}, { expires: '2026-13-01T00:00:00.000Z' });
    const timeless = mppChallenge('1001', {}, { expires: undefined });
    const challenge = parseTargetChallenge({ 'www-authenticate': [undated, timeless].join(', ') })!;

    expect(challenge.mpp.map(item => item.expires)).toEqual(['2026-13-01T00:00:00.000Z', undefined]);
    expect(mppRefusals(challenge, config, now)).toEqual(['expired']);
    expect(chooseOption(challenge, config, now)).toMatchObject({ protocol: 'mpp', atomicAmount: 1001n, expires: undefined });
    expect(chooseOption(parseTargetChallenge({ 'www-authenticate': undated })!, config, now)).toBeUndefined();
  });

  describe('the target\'s receipt', () => {
    const settled = encodePaymentResponseHeader({ success: true, transaction: '0xabc', network: base } as never);
    const failed = encodePaymentResponseHeader({ success: false, transaction: '', network: base, errorReason: 'insufficient_funds' } as never);
    const receipt = Receipt.serialize(Receipt.from({ method: 'tempo', status: 'success', reference: '0xdef', timestamp: now.toISOString() }));

    it('reads an x402 PAYMENT-RESPONSE that succeeded, or the v1 X-PAYMENT-RESPONSE, with its transaction', () => {
      expect(targetReceipt({ 'payment-response': settled }, 'x402')).toEqual({ receipt: settled, transaction: '0xabc' });
      expect(targetReceipt({ 'x-payment-response': settled }, 'x402')).toEqual({ receipt: settled, transaction: '0xabc' });
      expect(targetReceipt({ 'payment-response': failed }, 'x402')).toBeUndefined();
      expect(targetReceipt({}, 'x402')).toBeUndefined();
    });

    it('reads an MPP Payment-Receipt that succeeded, with its transaction', () => {
      expect(targetReceipt({ 'payment-receipt': receipt }, 'mpp')).toEqual({ receipt, transaction: '0xdef' });
      expect(targetReceipt({ 'payment-receipt': 'not-a-receipt' }, 'mpp')).toBeUndefined();
      expect(targetReceipt({}, 'mpp')).toBeUndefined();
    });

    it('reads only the headers of the protocol we paid with', () => {
      expect(targetReceipt({ 'payment-response': failed, 'payment-receipt': receipt }, 'x402')).toBeUndefined();
      expect(targetReceipt({ 'payment-receipt': receipt }, 'x402')).toBeUndefined();
      expect(targetReceipt({ 'payment-response': settled }, 'mpp')).toBeUndefined();
    });

    it('takes no x402 receipt that is not strict base64 of a JSON object', () => {
      expect(targetReceipt({ 'payment-response': `***${settled}` }, 'x402')).toBeUndefined();
      expect(targetReceipt({ 'payment-response': Buffer.from(JSON.stringify([{ success: true }])).toString('base64') }, 'x402')).toBeUndefined();
      expect(targetReceipt({ 'payment-response': Buffer.from(JSON.stringify({ success: 'true', transaction: '0xabc' })).toString('base64') }, 'x402')).toBeUndefined();
      expect(targetReceipt({ 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: 5 })).toString('base64') }, 'x402'))
        .toMatchObject({ transaction: undefined });
    });
  });

  it('adds the routing fee, rounded down', () => {
    expect(routingQuote(1_000n as MicroUsd, 250)).toEqual({ quote: 1_025n, fee: 25n });
    expect(routingQuote(1_001n as MicroUsd, 250)).toEqual({ quote: 1_026n, fee: 25n });
    expect(routingQuote(1_000n as MicroUsd, 0)).toEqual({ quote: 1_000n, fee: 0n });
    expect(routingQuote(1_000n as MicroUsd, 10_000)).toEqual({ quote: 2_000n, fee: 1_000n });
  });

  it.each([-1, 10_001, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses a routing fee of %s basis points', feeBps => {
    expect(() => routingQuote(1_000n as MicroUsd, feeBps)).toThrow(RangeError);
  });
});
