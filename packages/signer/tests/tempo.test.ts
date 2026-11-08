import { Challenge, Credential } from 'mppx';
import { HttpRequestError, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Transaction } from 'viem/tempo';
import { describe, expect, it } from 'vitest';

import { fixtureTime, moderatoChainId, pathUsdAddress } from '@anyfare/testing';

import { errorReason, maxFeeOf } from '../src/tempo.js';

const account = privateKeyToAccount(generatePrivateKey());

const challenge = Challenge.from({
  id: 'challenge-fee', realm: 'api.target.test', method: 'tempo', intent: 'charge', expires: fixtureTime(0, 9, 12, 5, 0, 0),
  request: { amount: '1000', currency: pathUsdAddress, recipient: '0x5555555555555555555555555555555555555555', methodDetails: { chainId: moderatoChainId } },
} as never);

/** A pull credential: a Tempo transaction our wallet signed, with this gas limit and maximum fee per gas. */
const pullCredential = async (gas: bigint, maxFeePerGas: bigint): Promise<string> => {
  const signature = await account.signTransaction({
    type: 'tempo', chainId: moderatoChainId, nonce: 0, gas, maxFeePerGas, maxPriorityFeePerGas: 1n, calls: [{ to: pathUsdAddress, data: '0x' }],
  } as never, { serializer: Transaction.serialize as never }) as Hex;

  return Credential.serialize({ challenge, payload: { signature, type: 'transaction' } });
};

describe('maxFeeOf', () => {
  it('is the transaction\'s gas limit at its maximum fee per gas, in micro-USD', async () => {
    // 100,000 gas at 20 billion attodollars: 2 * 10^15 attodollars, $0.002
    expect(maxFeeOf(await pullCredential(100_000n, 20_000_000_000n))).toBe(2_000n);
  });

  it('rounds a fraction of a micro-USD up', async () => {
    // 2,500,000,000,100,000 attodollars: just above 2,500 micro-USD
    expect(maxFeeOf(await pullCredential(100_000n, 25_000_000_001n))).toBe(2_501n);
    expect(maxFeeOf(await pullCredential(1n, 1n))).toBe(1n);
  });

  it('is 0 for a credential without a signed transaction', () => {
    const credential = Credential.serialize({ challenge, payload: { hash: `0x${'1'.repeat(64)}`, type: 'hash' } });

    expect(maxFeeOf(credential)).toBe(0n);
  });
});

describe('errorReason', () => {
  it('takes viem\'s short message, never its details with the request and the URL', () => {
    const error = new HttpRequestError({ url: 'https://rpc.target.test/secret-rpc-key', body: { method: 'eth_sendRawTransaction', params: ['0xdeadbeef'] }, status: 503 });

    expect(error.message).toContain('secret-rpc-key');
    expect(errorReason(error)).toBe('HTTP request failed.');
  });

  it('keeps an error\'s first line only, without URLs', () => {
    const error = new Error('request to https://sol.rpc.test/secret-rpc-key failed, reason: connect ECONNREFUSED\n    at the request body {"transaction":"AQID"}');

    expect(errorReason(error)).toBe('request to <rpc> failed, reason: connect ECONNREFUSED');
  });

  it('is at most 200 characters', () => {
    expect(errorReason(new Error('x'.repeat(500)))).toBe('x'.repeat(200));
  });

  it('names an error that isn\'t one', () => {
    expect(errorReason('a string')).toBe('unknown error');
    expect(errorReason(undefined)).toBe('unknown error');
  });
});
