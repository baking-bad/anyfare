import { createServer as createNetServer, type AddressInfo } from 'node:net';

import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { Challenge } from 'mppx';
import { createClient, http, type LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, Secret, type MicroUsd } from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import type { NewSignature } from '@anyfare/db';
import {
  createFakeClock, createFakeIdGenerator, decodeSolanaPayment, encodeBase58, moderatoChainId, startFakeSolanaRpc, startFakeTempoRpc,
  type FakeSolanaRpc, type FakeTempoRpc,
} from '@anyfare/testing';

import { createSigner, SigningFailedError, SigningRefusedError, type SignerOptions, type SignRequest, type Signer } from '../src/sign.js';
import type { SpendEntry, SpendLimits, SpendReservation } from '../src/spend.js';
import { maxFeeOf } from '../src/tempo.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const tempo = 'eip155:42431';
const basePayTo = '0x2222222222222222222222222222222222222222';
// Made-up Solana addresses: the target's, and its facilitator's, which pays the transaction's fee
const solanaPayTo = encodeBase58(Uint8Array.from({ length: 32 }, () => 7));
const feePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 9));
const windows = { hour: 1_000, day: 41 };

const configWith = (signer: Record<string, string>): Promise<PlatformConfig> => loadPlatformConfig({
  env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ signer })).toString('base64') },
});
// $0.05 per call, $0.06 an hour, $0.10 a day
const config = await configWith({ maxPerCall: '0.05', maxPerNetworkPerHour: '0.06', maxPerNetworkPerDay: '0.1' });
const solanaUsdc = findAsset(config, 'solana-usdc')!.address;
const pathUsd = findAsset(config, 'tempo-pathusd')!.address;
// The test's clock, near the real one: mppx's client checks a challenge's expiry against the real clock
const clock = createFakeClock(new Date());

let solanaRpc: FakeSolanaRpc;
let tempoRpc: FakeTempoRpc;
let solanaWallet: KeyPairSigner;
let signer: Signer;
const baseWallet = privateKeyToAccount(generatePrivateKey());
const tempoWallet = privateKeyToAccount(generatePrivateKey());
const recorded: NewSignature[] = [];
// What the spend limits were asked, and what they answer next
const reservations: { readonly network: string; readonly amount: MicroUsd }[] = [];
const releases: SpendEntry[] = [];
const additions: SpendEntry[] = [];
let nextReservation: Omit<SpendReservation, 'windows'> | undefined;
let releaseFails = false;
const spend: SpendLimits = {
  reserve: async input => {
    reservations.push(input);

    return { ...nextReservation ?? { refusal: undefined, hour: input.amount, day: input.amount }, windows };
  },
  release: async entry => {
    if (releaseFails)
      throw new Error('Redis is not connected');
    releases.push(entry);
  },
  add: async entry => {
    additions.push(entry);
  },
};
const lines: Record<string, unknown>[] = [];
const logger = createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

const signerWith = (options: Partial<SignerOptions> = {}): Signer => createSigner({
  config, wallets: { base: baseWallet, solana: solanaWallet, tempo: tempoWallet }, solanaRpcUrl: Secret.from(solanaRpc.url),
  tempoClient: createClient({ chain: tempoModerato, transport: http(tempoRpc.url, { retryCount: 0 }) }), spend,
  signatures: { recordSignature: async signature => { recorded.push(signature); } }, clock, ids: createFakeIdGenerator(), logger, ...options,
});

const closedPort = async (): Promise<number> => {
  const listener = createNetServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise(resolve => listener.close(resolve));

  return port;
};

beforeAll(async () => {
  [solanaRpc, tempoRpc, solanaWallet] = await Promise.all([startFakeSolanaRpc(), startFakeTempoRpc(), generateKeyPairSigner()]);
  signer = signerWith();
});

afterAll(async () => {
  await Promise.all([solanaRpc?.close(), tempoRpc?.close()]);
});

beforeEach(() => {
  nextReservation = undefined;
  releaseFails = false;
});

const baseOption = (amount: string, overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: base, amount, asset: findAsset(config, 'base-usdc')!.address, payTo: basePayTo, maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2', ...extra }, ...overrides,
});

const solanaOption = (amount: string, extra: Record<string, unknown> = { feePayer }, overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: solana, amount, asset: solanaUsdc, payTo: solanaPayTo, maxTimeoutSeconds: 60, extra, ...overrides,
});

const x402 = (requirement: Record<string, unknown>, quotedPrice = String(requirement['amount']), x402Version = 2): SignRequest => ({
  protocol: 'x402', requestId: 'req-unit', quoteId: 'pay_unit', url: 'https://api.target.test/v1/price', quotedPrice: BigInt(quotedPrice),
  x402Version, requirement: requirement as unknown as PaymentRequirements, resource: { url: 'https://api.target.test/v1/price' },
});

/** A target's Tempo charge, as `mppx`'s server writes it, expiring in five minutes unless it says. */
const mpp = (amount: string, details: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): SignRequest => ({
  protocol: 'mpp', requestId: 'req-unit', quoteId: 'pay_unit', url: 'https://api.target.test/v1/price', quotedPrice: BigInt(amount),
  challenge: Challenge.serialize(Challenge.from({
    id: 'challenge-unit', realm: 'api.target.test', method: 'tempo', intent: 'charge', expires: new Date(clock.now().getTime() + 5 * 60_000).toISOString(),
    request: { amount, currency: pathUsd, recipient: '0x5555555555555555555555555555555555555555', methodDetails: { chainId: moderatoChainId, supportedModes: ['pull'], ...details } },
    ...overrides,
  } as never)),
});

const refusalOf = async (request: SignRequest, using = signer): Promise<string | undefined> => {
  const error = await using.sign(request).then(() => undefined, (failure: unknown) => failure);

  return error instanceof SigningRefusedError ? error.reason : undefined;
};

describe('the order of the Signer\'s refusals', () => {
  it.each([
    ['not exact before the registry', baseOption('1000', { scheme: 'upto', network: 'eip155:1' }), '1000', 'not_exact'],
    ['the registry before the amount', baseOption('nope', { asset: '0x3333333333333333333333333333333333333333' }), '1000', 'not_in_registry'],
    ['the option before the amount', baseOption('nope', { payTo: '0x12' }), '1000', 'invalid_pay_to'],
    ['a fee payer before the amount', solanaOption('nope', {}), '1000', 'no_fee_payer'],
    ['the amount before the quote', baseOption('0'), '0', 'invalid_amount'],
    ['the quote before the per-call maximum', baseOption('60000'), '59999', 'above_quote'],
    ['the per-call maximum before the spend limits', baseOption('60000'), '60000', 'above_max_per_call'],
  ])('%s', async (_name, requirement, quotedPrice, reason) => {
    const before = reservations.length;

    expect(await refusalOf(x402(requirement, quotedPrice))).toBe(reason);
    expect(reservations.length).toBe(before);
  });

  it('refuses without a wallet on the chain before the option and the amount', async () => {
    const baseOnly = signerWith({ wallets: { base: baseWallet } });

    expect(await refusalOf(x402(solanaOption('nope', {}), '1000'), baseOnly)).toBe('no_wallet');
    expect(await refusalOf(mpp('1000', { machineTokenEnabled: true }), baseOnly)).toBe('machine_token');
    expect(await refusalOf(mpp('1000'), baseOnly)).toBe('no_wallet');
  });

  it('refuses our own wallet as the Solana fee payer', async () => {
    expect(await refusalOf(x402(solanaOption('1000', { feePayer: solanaWallet.address })))).toBe('fee_payer_is_us');
  });

  it('asks the spend limits last, and refuses with the window\'s total against its limit', async () => {
    nextReservation = { refusal: 'hourly_limit', hour: 55_000n, day: 55_000n };

    const error = await signer.sign(x402(baseOption('10000'))).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(SigningRefusedError);
    expect(error).toMatchObject({ reason: 'hourly_limit', message: 'The hourly spend limit is reached', spend: { window: 'hour', spent: '0.055', limit: '0.06' } });
    expect(reservations.at(-1)).toEqual({ network: base, amount: 10_000n });
  });
});

describe('the options the clients can\'t sign as checked, refused before the spend limits count them', () => {
  const tooLongMemo = 'm'.repeat(257);

  it.each([
    ['x402 version 1', x402(baseOption('1000'), '1000', 1), 'invalid_option'],
    ['a Base payTo that isn\'t an address', x402(baseOption('1000', { payTo: '0x2222' })), 'invalid_pay_to'],
    ['a Base payTo of 41 hex digits', x402(baseOption('1000', { payTo: `${basePayTo}2` })), 'invalid_pay_to'],
    ['a Solana payTo that isn\'t an address', x402(solanaOption('1000', { feePayer }, { payTo: basePayTo })), 'invalid_pay_to'],
    ['no maxTimeoutSeconds', x402(baseOption('1000', { maxTimeoutSeconds: undefined })), 'invalid_timeout'],
    ['maxTimeoutSeconds as the string "99"', x402(baseOption('1000', { maxTimeoutSeconds: '99' })), 'invalid_timeout'],
    ['maxTimeoutSeconds of 1e9', x402(baseOption('1000', { maxTimeoutSeconds: 1e9 })), 'invalid_timeout'],
    ['maxTimeoutSeconds of 301', x402(baseOption('1000', { maxTimeoutSeconds: 301 })), 'invalid_timeout'],
    ['maxTimeoutSeconds of 0', x402(baseOption('1000', { maxTimeoutSeconds: 0 })), 'invalid_timeout'],
    ['maxTimeoutSeconds of 1.5', x402(baseOption('1000', { maxTimeoutSeconds: 1.5 })), 'invalid_timeout'],
    ['no EIP-712 name', x402(baseOption('1000', { extra: { version: '2' } })), 'invalid_option'],
    ['an empty EIP-712 version', x402(baseOption('1000', {}, { version: '' })), 'invalid_option'],
    ['Permit2', x402(baseOption('1000', {}, { assetTransferMethod: 'permit2' })), 'transfer_method'],
    ['an unknown transfer method', x402(baseOption('1000', {}, { assetTransferMethod: 'eip2612' })), 'transfer_method'],
    ['an upfront payment flow', x402(baseOption('1000', {}, { paymentFlow: 'upfront' })), 'invalid_option'],
    ['an unknown payment flow', x402(baseOption('1000', {}, { paymentFlow: 'stream' })), 'invalid_option'],
    ['Solana transaction version 2', x402(solanaOption('1000', { feePayer, transactionVersions: [2] })), 'invalid_option'],
    ['no Solana transaction version', x402(solanaOption('1000', { feePayer, transactionVersions: [] })), 'invalid_option'],
    ['Solana transaction versions that aren\'t a list', x402(solanaOption('1000', { feePayer, transactionVersions: '0' })), 'invalid_option'],
    ['a Solana fee payer that isn\'t an address', x402(solanaOption('1000', { feePayer: 'not-an-address' })), 'invalid_option'],
    ['a Solana memo too long', x402(solanaOption('1000', { feePayer, memo: tooLongMemo })), 'invalid_option'],
    ['the Solana mint in another case', x402(solanaOption('1000', { feePayer }, { asset: solanaUsdc.toLowerCase() })), 'not_in_registry'],
    ['an MPP expiry that isn\'t a date', mpp('1000', {}, { expires: '2026-13-01T00:00:00.000Z' }), 'expired'],
    ['an expired MPP challenge', mpp('1000', {}, { expires: new Date(clock.now().getTime() - 1_000).toISOString() }), 'expired'],
    ['an MPP machine-token route', mpp('1000', { machineTokenEnabled: true }), 'machine_token'],
  ])('%s', async (_name, request, reason) => {
    const before = reservations.length;
    const rpcCalls = tempoRpc.calls.length + solanaRpc.calls.length;

    expect(await refusalOf(request)).toBe(reason);
    expect(reservations.length).toBe(before);
    expect(tempoRpc.calls.length + solanaRpc.calls.length).toBe(rpcCalls);
  });

  it('says when an MPP expiry isn\'t a date, apart from one that passed', async () => {
    await expect(signer.sign(mpp('1000', {}, { expires: '2026-13-01T00:00:00.000Z' }))).rejects.toThrow('The challenge\'s expiry isn\'t a date');
    await expect(signer.sign(mpp('1000', {}, { expires: new Date(clock.now().getTime() - 1_000).toISOString() }))).rejects.toThrow('The challenge has expired');
  });

  it('signs a maxTimeoutSeconds of 300, valid for 300 seconds at most', async () => {
    const signed = await signer.sign(x402(baseOption('1000', { maxTimeoutSeconds: 300 })));
    const { payload } = decodePaymentSignatureHeader(signed.header) as unknown as { payload: { authorization: Record<string, string> } };

    expect(Number(payload.authorization['validBefore'])).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 300);
  });
});

describe('a client that fails after the reservation', () => {
  it('gives the reservation back when the Solana RPC fails, in the windows it counted in', async () => {
    const down = signerWith({ solanaRpcUrl: Secret.from(`http://127.0.0.1:${await closedPort()}`) });
    const before = releases.length;

    await expect(down.sign(x402(solanaOption('10000')))).rejects.toBeInstanceOf(SigningFailedError);

    expect(releases.slice(before)).toEqual([{ network: solana, amount: 10_000n, windows }]);
  });

  it('gives the reservation back when the EVM client fails, and throws its error', async () => {
    const failing: LocalAccount = { ...baseWallet, signTypedData: async () => { throw new Error('the key store is locked'); } };
    const before = releases.length;

    await expect(signerWith({ wallets: { base: failing } }).sign(x402(baseOption('10000')))).rejects.toThrow('the key store is locked');

    expect(releases.slice(before)).toEqual([{ network: base, amount: 10_000n, windows }]);
  });

  it('gives the reservation back when the Tempo RPC fails', async () => {
    const before = releases.length;
    tempoRpc.unavailable(true);
    try {
      await expect(signer.sign(mpp('1500'))).rejects.toBeInstanceOf(SigningFailedError);
    }
    finally {
      tempoRpc.unavailable(false);
    }

    expect(releases.slice(before)).toEqual([{ network: tempo, amount: 1_500n, windows }]);
  });

  it('logs a release that fails, and throws the client\'s failure', async () => {
    releaseFails = true;
    const down = signerWith({ solanaRpcUrl: Secret.from(`http://127.0.0.1:${await closedPort()}`) });

    await expect(down.sign(x402(solanaOption('10000')))).rejects.toBeInstanceOf(SigningFailedError);

    expect(lines.filter(line => line['msg'] === 'The Signer couldn\'t give back a spend reservation').at(-1)).toMatchObject({ level: 50, network: solana, amount: '0.01' });
  });

  it('keeps the reservation when the signature can\'t be recorded, and returns no payment', async () => {
    const before = releases.length;
    let signed = 0;
    const unrecorded = signerWith({
      signatures: { recordSignature: async () => { throw new Error('the database is down'); } },
      onSigned: () => { signed += 1; },
    });

    await expect(unrecorded.sign(x402(baseOption('10000')))).rejects.toThrow('the database is down');

    expect(releases.length).toBe(before);
    expect(signed).toBe(0);
  });
});

describe('signing x402 payments', () => {
  it('signs an EIP-3009 authorization on Base to the option\'s payTo, for its amount, valid for its timeout', async () => {
    const signed = await signer.sign(x402(baseOption('10000')));
    const { payload } = decodePaymentSignatureHeader(signed.header) as unknown as { payload: { authorization: Record<string, string> } };
    const now = Math.floor(Date.now() / 1_000);

    expect(payload.authorization).toMatchObject({ from: baseWallet.address, to: basePayTo, value: '10000' });
    expect(Number(payload.authorization['validBefore'])).toBeGreaterThanOrEqual(now + 59);
    expect(Number(payload.authorization['validBefore'])).toBeLessThanOrEqual(now + 61);
    expect(signed).toMatchObject({ protocol: 'x402', network: base, asset: 'base-usdc', atomicAmount: 10_000n, amount: 10_000n, payTo: basePayTo });
    expect(recorded.at(-1)).toMatchObject({ id: signed.signatureId, requestId: 'req-unit', quoteId: 'pay_unit', resource: 'https://api.target.test/v1/price' });
  });

  it('signs above the SDK\'s own default cap of $1 when the Signer\'s per-call maximum allows it', async () => {
    const generous = signerWith({ config: await configWith({ maxPerCall: '2' }) });

    const signed = await generous.sign(x402(baseOption('1500000')));
    const { payload } = decodePaymentSignatureHeader(signed.header) as unknown as { payload: { authorization: Record<string, string> } };

    expect(payload.authorization['value']).toBe('1500000');
    expect(signed.amount).toBe(1_500_000n);
  });

  it.each([
    ['only version 0', [0], 0],
    ['versions 0 and 1', [0, 1], 1],
    ['no version, which means version 0', undefined, 0],
  ])('builds the Solana transaction version the option advertises: %s', async (_name, transactionVersions, version) => {
    const extra = transactionVersions === undefined ? { feePayer } : { feePayer, transactionVersions };

    const signed = await signer.sign(x402(solanaOption('10000', extra)));
    const { payload } = decodePaymentSignatureHeader(signed.header) as unknown as { payload: { transaction: string } };
    const payment = decodeSolanaPayment(payload.transaction);

    expect(payment.version).toBe(version);
    expect(payment.feePayer).toBe(feePayer);
    expect(payment.signedBy).toEqual([solanaWallet.address]);
    expect(payment.transfer).toMatchObject({ authority: solanaWallet.address, amount: 10_000n, decimals: 6 });
  });
});

describe('signing Tempo charges', () => {
  it('adds the most our transaction pays in fees to the network\'s windows, after signing', async () => {
    const before = additions.length;

    const signed = await signer.sign(mpp('1500'));

    expect(signed.maxFee).toBe(maxFeeOf(signed.header));
    expect(signed.maxFee).toBeGreaterThan(0n);
    expect(additions.slice(before)).toEqual([{ network: tempo, amount: signed.maxFee, windows }]);
  });

  it('adds no fee when the target sponsors it', async () => {
    const before = additions.length;

    expect((await signer.sign(mpp('1500', { feePayer: true }))).maxFee).toBe(0n);
    expect(additions.length).toBe(before);
  });
});
