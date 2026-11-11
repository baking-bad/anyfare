// The NEAR payer's parts, one by one. Every key here is made in the test, in memory only, and holds
// nothing. Every account, height and amount is made up.

import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import { HttpError, stopFor } from '../src/errors.ts';
import { NotSupported, Stop } from '../src/util.ts';
import { readNearWallet } from '../src/wallet.ts';
import { SignerFailure, checkNearTransfer, checkOption, checkSigned, nearClient, nearSigningFailure, readProof, validFor, x402Lines } from '../src/x402.ts';
import { NEAR_USDC } from './fakeApi.ts';
import { nearTestKey } from './helpers.ts';

const PAY_TO = 'seller.example.near';
const PAYER = 'alice.near';
const option = (change: Record<string, unknown> = {}): Record<string, unknown> => ({
  scheme: 'exact',
  network: 'near:mainnet',
  asset: NEAR_USDC,
  amount: '10000',
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: {},
  ...change,
});

describe('checkOption', () => {
  it('takes the exact USDC option of NEAR', () => {
    expect(checkOption(option())).toMatchObject({ payTo: PAY_TO, amount: '10000' });
    expect(checkOption(option({ extra: undefined, maxTimeoutSeconds: 1 }))).toMatchObject({ maxTimeoutSeconds: 1 });
    // The flow that settles only after the API answered 2xx, named or not
    expect(checkOption(option({ extra: { paymentFlow: 'authorization' } }))).toMatchObject({ amount: '10000' });
    expect(checkOption(option({ extra: { paymentFlow: null } }))).toMatchObject({ amount: '10000' });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['another scheme', { scheme: 'upto' }, 'is not of the exact scheme'],
    ['another network', { network: 'near:testnet' }, 'is not on NEAR'],
    ['another token', { asset: 'usdt.tether-token.near' }, 'is not the known USDC of NEAR'],
    ['an amount of 0', { amount: '0' }, 'has no amount this app can read'],
    ['an amount with decimals', { amount: '1.5' }, 'has no amount this app can read'],
    ['an amount as a number', { amount: 10000 }, 'has no amount this app can read'],
    ['a recipient that is no NEAR account', { payTo: 'Not An Account' }, 'has no recipient this app can read'],
    ['a time limit of 0', { maxTimeoutSeconds: 0 }, 'has no time limit this app can read'],
    ['a time limit that is no whole number', { maxTimeoutSeconds: 1.5 }, 'has no time limit this app can read'],
    ['a time limit as text', { maxTimeoutSeconds: '300' }, 'has no time limit this app can read'],
    ['a time limit of 301 seconds', { maxTimeoutSeconds: 301 }, 'asks for a payment valid for more than 300 seconds'],
    ['extra fields that are not an object', { extra: 'x' }, 'has extra fields that are not an object'],
    ['the escrow payment flow', { extra: { paymentFlow: 'escrow' } }, "asks for a payment flow this app doesn't sign"],
    ['the upfront payment flow, settled before the API answers', { extra: { paymentFlow: 'upfront' } }, "asks for a payment flow this app doesn't sign"],
    ['a payment flow the SDK does not know', { extra: { paymentFlow: 'made-up' } }, "asks for a payment flow this app doesn't sign"],
  ])('refuses %s', (_what, change, why) => {
    let failure: unknown;
    try {
      checkOption(option(change));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(NotSupported);
    expect((failure as NotSupported).line()).toBe(`Not supported: the API's NEAR option ${why}, so the app won't sign it. Nothing paid.`);
  });
});

describe('the SDK, signing one option at the cap', () => {
  const required = (value: Record<string, unknown>): PaymentRequired =>
    ({ x402Version: 2, resource: { url: 'https://api.example.test/x', description: 'Made up' }, accepts: [value] }) as unknown as PaymentRequired;

  it('asks the signer for nothing above the cap', async () => {
    let calls = 0;
    const signer = {
      createSignedDelegateAction: async () => {
        calls += 1;
        return 'AAAA';
      },
    };
    const over = option({ amount: '20001' });
    await expect(nearClient(signer, over as PaymentRequirements, 20_000n).createPaymentPayload(required(over))).rejects.toThrow(/rejected by spendControls/);
    expect(calls).toBe(0);
    const at = option({ amount: '20000' });
    const payload = await nearClient(signer, at as PaymentRequirements, 20_000n).createPaymentPayload(required(at));
    expect(calls).toBe(1);
    expect(payload.accepted).toEqual(at);
  });
});

describe('what was signed, before it is sent', () => {
  const near = option() as PaymentRequirements;
  const transfer = (args: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(args));
  type Delegate = Parameters<typeof checkNearTransfer>[0];
  // A made-up height: what the app read of the RPC before signing
  const HEIGHT = 180_000_000n;
  const goodCall = { methodName: 'ft_transfer', args: transfer({ receiver_id: PAY_TO, amount: '10000' }), gas: 30_000_000_000_000n, deposit: 1n };
  const delegate = (change: Record<string, unknown> = {}): Delegate =>
    ({ senderId: PAYER, receiverId: NEAR_USDC, actionCount: 1, functionCall: goodCall, maxBlockHeight: HEIGHT + 300n, ...change }) as Delegate;
  const refusal = (value: Delegate): string => {
    try {
      checkNearTransfer(value, near, PAYER, HEIGHT, (why: string): never => {
        throw new Stop(why);
      });
    } catch (error) {
      return (error as Stop).message;
    }
    return 'not refused';
  };
  const call = (change: Record<string, unknown>) => ({ ...goodCall, ...change });

  it('takes one ft_transfer of the USDC, of the amount, to the recipient', () => {
    expect(refusal(delegate())).toBe('not refused');
    // The signer read the height a moment after the app did
    expect(refusal(delegate({ maxBlockHeight: HEIGHT + 350n }))).toBe('not refused');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['from another account', { senderId: 'other.example.near' }, 'it pays from another account'],
    ['to another contract', { receiverId: 'usdt.tether-token.near' }, 'it calls another contract than USDC'],
    ['with two actions', { actionCount: 2 }, 'it is not one ft_transfer'],
    ['with no function call', { functionCall: null }, 'it is not one ft_transfer'],
    ['another method', { functionCall: call({ methodName: 'ft_transfer_call' }) }, 'it is not one ft_transfer'],
    ['more than one yoctoNEAR', { functionCall: call({ deposit: 2n }) }, 'it attaches more than one yoctoNEAR'],
    ['to another recipient', { functionCall: call({ args: transfer({ receiver_id: 'thief.example.near', amount: '10000' }) }) }, 'it pays another recipient'],
    ['another amount', { functionCall: call({ args: transfer({ receiver_id: PAY_TO, amount: '9999' }) }) }, 'it pays another amount'],
    ['unreadable arguments', { functionCall: call({ args: transfer({ amount: 10000 }) }) }, "its transfer can't be read"],
    ['valid for 351 blocks past the height', { maxBlockHeight: HEIGHT + 351n }, "it stays valid for more blocks than the option's 300 seconds"],
    ['valid for ages', { maxBlockHeight: HEIGHT + 9_000_000_000_000_000n }, "it stays valid for more blocks than the option's 300 seconds"],
  ])('refuses a delegate action %s', (_what, change, why) => {
    expect(refusal(delegate(change))).toBe(why);
  });

  const payload = (change: Record<string, unknown> = {}, accepted: Record<string, unknown> = {}): PaymentPayload =>
    ({ x402Version: 2, accepted: { ...near, ...accepted }, payload: { signedDelegateAction: 'AAAA' }, ...change }) as unknown as PaymentPayload;
  const signedRefusal = (value: PaymentPayload, bounds: { nearHeight?: bigint } = { nearHeight: HEIGHT }): string => {
    try {
      checkSigned(near, PAYER, value, bounds);
    } catch (error) {
      expect(error).toBeInstanceOf(Stop);
      expect((error as Stop).notCharged).toBe(false);
      return (error as Stop).line();
    }
    return 'not refused';
  };

  it.each<[string, PaymentPayload, string]>([
    ['another x402 version', payload({ x402Version: 1 }), 'it is not x402 version 2'],
    ['no option', payload({ accepted: undefined }), 'it names no option'],
    ['another network', payload({}, { network: 'near:testnet' }), 'it names another scheme or network'],
    ['another asset', payload({}, { asset: 'usdt.tether-token.near' }), 'it names another asset'],
    ['another amount', payload({}, { amount: '9999' }), 'it names another amount'],
    ['another recipient', payload({}, { payTo: 'thief.example.near' }), 'it names another recipient'],
    ['another time limit', payload({}, { maxTimeoutSeconds: 3000 }), 'it names another time limit'],
    ['no signed part', payload({ payload: undefined }), 'it holds no signed part'],
    ['a delegate action that does not decode', payload(), "its delegate action can't be read"],
  ])('refuses a payload that names %s, and says nothing was sent', (_what, value, why) => {
    expect(signedRefusal(value)).toBe(`The signed payment is not the one the app chose: ${why}. Nothing was sent.`);
  });

  it('refuses with no height of its own to check against', () => {
    expect(signedRefusal(payload(), {})).toBe(
      'The signed payment is not the one the app chose: there is no block height to check it against. Nothing was sent.',
    );
  });
});

describe('the proof', () => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');

  it('reads a settled payment, a pending one, and one that did not settle', () => {
    expect(readProof(encode({ success: true, transaction: 'Hash', network: 'near:mainnet', payer: PAYER }))).toEqual({
      kind: 'settled',
      transaction: 'Hash',
      network: 'near:mainnet',
      payer: PAYER,
    });
    expect(readProof(encode({ success: false, errorReason: 'settlement_pending', transaction: 'Hash' }))).toMatchObject({ kind: 'pending', transaction: 'Hash' });
    expect(readProof(encode({ success: false, errorReason: 'invalid_transaction_state', transaction: '' }))).toEqual({
      kind: 'failed',
      reason: 'invalid_transaction_state',
    });
    expect(readProof(encode({ success: false, errorReason: 'a\u001b[2Jb' }))).toEqual({ kind: 'failed', reason: 'a [2Jb' });
    expect(readProof(null)).toEqual({ kind: 'missing' });
    expect(readProof('!!')).toEqual({ kind: 'unreadable' });
    expect(readProof(encode({ success: true }))).toEqual({ kind: 'unreadable' });
    expect(readProof(encode(['not', 'an', 'object']))).toEqual({ kind: 'unreadable' });
  });
});

describe('the NEAR signer, failing', () => {
  const { secretKey, publicKey } = nearTestKey();
  const url = 'https://rpc.example.test/made-up-path-Wq3/v3?made-up-query=Zr8LmQ';
  const wallet = () => readNearWallet({ NEAR_ACCOUNT_ID: PAYER, NEAR_PRIVATE_KEY: secretKey, NEAR_RPC_URL: url });

  // The signer's own failures: it reads the RPC
  const inSigner = (error: unknown): SignerFailure => new SignerFailure(error);

  it.each<[string, unknown, string]>([
    ['the 503 the SDK gives up on', inSigner(new Error(`${url} unavailable`)), 'the NEAR RPC at rpc.example.test answered with an error'],
    ['an answer that quotes the URL', inSigner(Object.assign(new Error(`Invalid key in ${url}`), { cause: 401 })), 'the NEAR RPC at rpc.example.test answered with an error'],
    [
      'a missing access key',
      inSigner(Object.assign(new Error(`Access key for public key ${publicKey} has never been observed on the node`), { type: 'AccessKeyDoesNotExist' })),
      `the NEAR RPC at rpc.example.test says NEAR_PRIVATE_KEY is not an access key of ${PAYER}`,
    ],
    ['an unknown account', inSigner(new Error('[-32000] Server error: UNKNOWN_ACCOUNT')), `the NEAR RPC at rpc.example.test knows no account ${PAYER}`],
    ['a fetch of the signer that was refused', inSigner(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) })), 'the NEAR RPC at rpc.example.test could not be reached (ECONNREFUSED)'],
    ['the spend controls', new Error('Payment requirements rejected by spendControls'), "the x402 client's spend controls refused it"],
    // The x402 client's own refusals: no RPC read failed
    ['a payment flow the client drops', new Error('No payment requirements with a recognized paymentFlow for x402 version: 2'), 'the x402 client refused it'],
    ['a scheme the client has none for', new Error(`No network/scheme registered for x402 version: 2 which comply with the payment requirements. ${url}`), 'the x402 client refused it'],
    ['an empty signature', new Error('Client signer returned an empty signed delegate action'), 'the x402 client refused it'],
    ['a fetch that failed with words naming the URL', new TypeError('fetch failed', { cause: new Error(`connect to ${url} failed`) }), 'the NEAR RPC at rpc.example.test could not be reached'],
    [
      'a fetch that was refused',
      new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
      'the NEAR RPC at rpc.example.test could not be reached (ECONNREFUSED)',
    ],
  ])('says %s in a fixed line, naming the host only', (_what, error, line) => {
    expect(nearSigningFailure(error, wallet())).toBe(line);
  });
});

describe("the proxy's x402 lines", () => {
  const CHECK = 'https://nearblocks.io/address/alice.near shows your payments';
  const line = (code: string, message: string, status = 402, retryAfter?: string): string =>
    stopFor(new HttpError(status, message, { code, ...(retryAfter !== undefined && { retryAfter }) }), { paid: { apiName: 'The API', check: CHECK } }, x402Lines(CHECK)).line();

  it('says a payment refused before it moved is not charged, and one used before is not known', () => {
    expect(line('payment_invalid', 'Made up: the amount is wrong.')).toBe('Anyfare refused the payment, so nothing moved: Made up: the amount is wrong. Not charged.');
    expect(line('payment_invalid', 'This payment was already used.')).toBe(
      `Anyfare says this payment was used before, and took nothing for this request. Whether the other use was paid is not known: ${CHECK}.`,
    );
    expect(line('upstream_unavailable', 'Made up', 503)).toBe("The API or Anyfare's payer failed, so Anyfare cancelled your payment; retry later. Not charged.");
    expect(line('payment_unavailable', 'Made up', 503, '1')).toBe("Anyfare couldn't take a NEAR payment now, so nothing was paid; retry in 1 second. Not charged.");
  });
});

describe('validFor', () => {
  it('says how many blocks, and about how long', () => {
    expect(validFor(300)).toBe('300 blocks, about 3 minutes');
    expect(validFor(30)).toBe('30 blocks, about 18 seconds');
    expect(validFor(1)).toBe('1 block, about 1 second');
    expect(validFor(100)).toBe('100 blocks, about 1 minute');
  });
});
