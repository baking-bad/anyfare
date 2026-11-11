// Reading a 402 and choosing the option. Every option here is made up.

import { encodePaymentRequiredHeader } from '@x402/core/http';
import { describe, expect, it } from 'vitest';
import type { Answer } from '../src/http.ts';
import { chooseOption, isKnownUsdc, readX402, takesList } from '../src/offers.ts';
import { NotSupported } from '../src/util.ts';
import { NEAR_USDC } from './fakeApi.ts';

const HINT = ['  Through Anyfare it takes NEAR:', '  https://pay.example.test/api.example.test/x'];
const near = (change: Record<string, unknown> = {}): Record<string, unknown> => ({
  scheme: 'exact',
  network: 'near:mainnet',
  asset: NEAR_USDC,
  amount: '10000',
  payTo: 'seller.example.near',
  maxTimeoutSeconds: 300,
  extra: {},
  ...change,
});
const answer = (body: unknown, headers: Record<string, string> = {}): Answer => ({
  status: 402,
  headers: new Headers(headers),
  bytes: new Uint8Array(),
  truncated: false,
  body,
  ms: 0,
});

function refusal(run: () => unknown): NotSupported {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(NotSupported);
    return error as NotSupported;
  }
  throw new Error('Expected NotSupported');
}

describe('readX402', () => {
  const required = { x402Version: 2, resource: { url: 'https://api.example.test/x' }, accepts: [near()] };

  it('reads PAYMENT-REQUIRED first, then the JSON body', () => {
    const fromHeader = readX402(answer({ x402Version: 2, accepts: [] }, { 'payment-required': encodePaymentRequiredHeader(required as never) }), HINT);
    expect(fromHeader.accepts).toEqual([near()]);
    expect(fromHeader.required['resource']).toEqual({ url: 'https://api.example.test/x' });
    expect(readX402(answer(required), HINT).accepts).toEqual([near()]);
  });

  it.each<[string, Answer, string]>([
    ['a header that does not decode', answer(required, { 'payment-required': 'not base64!' }), 'Not supported: no x402 payment request. Nothing paid.'],
    ['no header and no x402 body', answer({ title: 'Payment required' }, { 'www-authenticate': 'Payment id="x"' }), 'Not supported: no x402 payment request. Nothing paid.'],
    ['a body with no accepts list', answer({ x402Version: 2, accepts: 'x' }), 'Not supported: no x402 payment request. Nothing paid.'],
    ['a body with no version', answer({ accepts: [near()] }), 'Not supported: no x402 payment request. Nothing paid.'],
    ['version 1', answer({ x402Version: 1, accepts: [near()] }), 'Not supported: it asks for x402 version 1. This app pays version 2. Nothing paid.'],
    ['version 2.5', answer({ x402Version: 2.5, accepts: [near()] }), 'Not supported: it asks for x402 version 2.5. This app pays version 2. Nothing paid.'],
  ])('is not supported for %s, with the hint', (_what, value, line) => {
    const failure = refusal(() => readX402(value, HINT));
    expect(failure.line()).toBe(line);
    expect(failure.hint).toEqual(HINT);
  });
});

describe('chooseOption', () => {
  const choose = (accepts: unknown[]) => chooseOption({ x402Version: 2, accepts, required: { x402Version: 2, resource: { url: 'x' }, accepts } }, HINT);

  it('picks the lowest amount of the USDC options on NEAR, the first on a tie, and signs from it alone', () => {
    const chosen = choose([near({ amount: '20000' }), { scheme: 'exact', network: 'eip155:8453' }, near({ amount: '9000', payTo: 'a.near' }), near({ amount: '9000', payTo: 'b.near' })]);
    expect(chosen.option).toMatchObject({ amount: '9000', payTo: 'a.near' });
    expect(chosen.micro).toBe(9000n);
    expect(chosen.required.accepts).toEqual([chosen.option]);
    expect(chosen.required.resource).toEqual({ url: 'x' });
  });

  it('skips an option it refuses when another passes', () => {
    expect(choose([near({ maxTimeoutSeconds: 3000, amount: '1' }), near()]).option.amount).toBe('10000');
  });

  it.each<[string, unknown[], string, boolean]>([
    ['no option on NEAR', [{ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }], "this API doesn't take NEAR. It takes USDC on Base.", true],
    ['no options at all', [], "this API doesn't take NEAR.", true],
    ['options that are not objects', ['x', 1], "this API doesn't take NEAR.", true],
    ['another scheme on NEAR', [near({ scheme: 'upto' })], 'it asks for the upto scheme on NEAR. This app pays exact only.', true],
    ['another token on NEAR, by address', [near({ asset: 'usdt.tether-token.near' })], 'it asks for usdt.t…near on NEAR. This app pays USDC only.', true],
    ['USDC on NEAR it would not sign', [near({ amount: '0' })], "the API's NEAR option has no amount this app can read, so the app won't sign it.", false],
  ])('is not supported for %s', (_what, accepts, line, hinted) => {
    const failure = refusal(() => choose(accepts));
    expect(failure.line()).toBe(`Not supported: ${line} Nothing paid.`);
    expect(failure.hint).toEqual(hinted ? HINT : []);
  });

  it("cleans the API's own text in a line", () => {
    const failure = refusal(() => choose([near({ scheme: `a\u001b[2J${'b'.repeat(60)}` })]));
    expect(failure.message).toBe(`Not supported: it asks for the a [2J${'b'.repeat(35)}… scheme on NEAR. This app pays exact only. Nothing paid.`);
  });
});

describe('takesList', () => {
  it('names one asset, or how many tokens, on each network once', () => {
    const base = { network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
    expect(takesList([base, { ...base, asset: base.asset.toLowerCase() }])).toBe('USDC on Base');
    expect(takesList([{ network: 'eip155:1', asset: '0xMadeUp', extra: { name: 'Made Up Coin' } }, base])).toBe('USDC on Base, and Made Up Coin on Ethereum');
    expect(takesList([{ network: 'x:y', asset: 'a' }, { network: 'x:y', asset: 'b' }, { network: 'x:y' }])).toBe('3 tokens on x:y');
    expect(takesList([{ asset: 'no network' }])).toBe('');
  });
});

describe('isKnownUsdc', () => {
  it('knows USDC on NEAR and on Base, and nothing else', () => {
    expect(isKnownUsdc('near:mainnet', NEAR_USDC)).toBe(true);
    expect(isKnownUsdc('eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(true);
    expect(isKnownUsdc('near:mainnet', NEAR_USDC.toUpperCase())).toBe(false);
    expect(isKnownUsdc('eip155:56', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d')).toBe(false);
    expect(isKnownUsdc('near:testnet', NEAR_USDC)).toBe(false);
  });
});
