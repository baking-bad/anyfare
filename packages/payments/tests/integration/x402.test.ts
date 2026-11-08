import { createHash, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { generateKeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createClientNearSigner, decodeSignedDelegateB64 } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger, Secret, type Logger } from '@anyfare/common';
import {
  canChangePaymentStatus, InvalidPaymentStatusChangeError, loadPlatformConfig, type JsonObject, type NewPayment, type Payment, type PlatformConfig,
  type SettleInput,
} from '@anyfare/core';
import {
  associatedTokenAddress, createMemoryClaimStore, decodeSolanaPayment, encodeBase58, facilitatorAnswers, nearFacilitatorOff, startFakeFacilitator, startFakeSolanaRpc,
  type FacilitatorScript, type FakeFacilitator, type FakeSolanaRpc,
} from '@anyfare/testing';

import {
  createFacilitators, createX402Rail, FacilitatorUnavailableError, fromSettlementRequest, initializeX402, minPaymentWindowMs, PaymentInvalidError,
  SettlementFailedError, type Authorization, type PaymentRail, type PaymentRecorder, type Quote, type SettlementLedger, type X402Setup,
} from '../../src/index.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const near = 'near:testnet';
const baseUsdc = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const solanaUsdc = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const nearUsdc = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const nearPayTo = 'pay.anyfare.testnet';
const basePayTo = '0x2222222222222222222222222222222222222222';
const solanaPayTo = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const feePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 7));
const clock = { now: () => new Date() };
const logger = createLogger({ level: 'silent' });
const testApiKey = 'test-facilitator-secret-0123456789abcdef';
const facilitatorKey = () => Secret.from(testApiKey);
const noCdpKey = () => {
  throw new Error('No CDP auth here');
};

let facilitator: FakeFacilitator;
let rpc: FakeSolanaRpc;
let nearRpc: Server;
let nearNonce = 7;
let nearSigner: ReturnType<typeof createClientNearSigner>;
let config: PlatformConfig;
let setup: X402Setup;

// The settle timeout is short, so a facilitator that holds its answer back times out
const configWith = (url: string, { facilitators, ...overrides }: Record<string, unknown> = {}) => loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({
      // Every NEAR asset needs a facilitator: a test that names its own leaves ours disabled
      facilitators: [
        ...(facilitators as readonly unknown[] | undefined) ?? [{ name: 'cdp', url, networks: [base, solana] }],
        ...JSON.stringify(facilitators ?? []).includes(near) ? [] : [facilitators ? nearFacilitatorOff : { ...nearFacilitatorOff, url, enabled: true }],
      ],
      timeouts: { settleMs: 1_000 },
      ...overrides,
    })).toString('base64'),
  },
});

// Our own payTo addresses for the test, on Base and Solana
const withTestPayTo = (document: PlatformConfig): PlatformConfig => ({
  ...document,
  assets: document.assets.map(asset => asset.name === 'base-usdc' ? { ...asset, payTo: basePayTo } : asset.name === 'solana-usdc' ? { ...asset, payTo: solanaPayTo } : asset),
});

const setupFor = async (url: string): Promise<X402Setup> => {
  const document = withTestPayTo(await configWith(url));

  return initializeX402({ config: document, facilitators: createFacilitators({ config: document, cdpApiKey: noCdpKey, facilitatorApiKey: facilitatorKey, clock }), timeoutMs: 5_000 });
};

beforeAll(async () => {
  [facilitator, rpc] = await Promise.all([
    startFakeFacilitator({ networks: [base, solana, near], feePayer }),
    startFakeSolanaRpc(),
  ]);
  // A fake NEAR node, just enough for the client signer: the block height and the access key's nonce
  nearRpc = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string; params: Record<string, unknown> };
      nearNonce += call.method === 'query' ? 1 : 0;
      const result = call.method === 'block'
        ? { header: { height: 1_000, hash: '11111111111111111111111111111111' }, chunks: [], author: 'node.testnet' }
        : { nonce: nearNonce, permission: 'FullAccess', block_height: 1_000, block_hash: '11111111111111111111111111111111' };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise<void>(resolve => nearRpc.listen(0, '127.0.0.1', resolve));
  const nearKey = generateKeyPairSync('ed25519');
  nearSigner = createClientNearSigner({
    accountId: 'buyer.testnet',
    secretKey: `ed25519:${encodeBase58(Buffer.concat([Buffer.from(nearKey.privateKey.export({ format: 'jwk' }).d!, 'base64url'), Buffer.from(nearKey.publicKey.export({ format: 'jwk' }).x!, 'base64url')]))}`,
    rpcUrls: { [near]: `http://127.0.0.1:${(nearRpc.address() as AddressInfo).port}` },
  });
  config = withTestPayTo(await configWith(facilitator.url));
  setup = await initializeX402({ config, facilitators: createFacilitators({ config, cdpApiKey: noCdpKey, facilitatorApiKey: facilitatorKey, clock }), timeoutMs: 5_000 });
});

afterAll(async () => {
  await Promise.all([facilitator?.close(), rpc?.close(), new Promise<void>(resolve => nearRpc ? nearRpc.close(() => resolve()) : resolve())]);
});

beforeEach(() => {
  facilitator.reset();
});

// In-memory ports: the payment rows, with the status changes the payment status graph allows, and
// what the ledger books. `bookingFails` makes the ledger's settle throw.
const createPorts = (railSetup = setup, { log = logger, bookingFails }: { log?: Logger; bookingFails?: Error } = {}) => {
  const rows = new Map<string, Payment>();
  const created: (NewPayment & { status: string })[] = [];
  const changes: Parameters<PaymentRecorder['changeStatus']>[0][] = [];
  const settled: SettleInput[] = [];
  const update = (paymentId: string, to: Payment['status'], fields: Partial<Payment> = {}, from?: Payment['status']): Payment => {
    const row = rows.get(paymentId);
    if (!row || !canChangePaymentStatus(row.status, to) || (from !== undefined && row.status !== from))
      throw new InvalidPaymentStatusChangeError(paymentId, row?.status, to);
    const next = { ...row, ...fields, status: to };
    rows.set(paymentId, next);

    return next;
  };
  const recorder: PaymentRecorder = {
    create: async payment => {
      if (rows.has(payment.id))
        throw new Error(`The payment ${payment.id} exists`);
      created.push(payment);
      const at = new Date();
      const row: Payment = {
        ...payment, fee: undefined, decision: undefined, upstreamStatus: undefined, upstreamLatencyMs: undefined, transactionHash: payment.transactionHash,
        receipt: undefined, needsReview: false, createdAt: at, updatedAt: at,
      };
      rows.set(payment.id, row);

      return row;
    },
    recordDecision: async () => {
      throw new Error('The rail records no decision');
    },
    changeStatus: async change => {
      const next = update(change.paymentId, change.to, {
        ...change.transactionHash === undefined ? {} : { transactionHash: change.transactionHash },
        ...change.receipt === undefined ? {} : { receipt: change.receipt },
        ...change.needsReview === undefined ? {} : { needsReview: change.needsReview },
      }, change.from);
      changes.push(change);

      return next;
    },
    find: async paymentId => rows.get(paymentId),
  };
  const ledger: SettlementLedger = {
    settle: async input => {
      if (bookingFails)
        throw bookingFails;
      settled.push(input);

      return { payment: update(input.paymentId, 'settled', { transactionHash: input.transactionHash, receipt: input.receipt }), fee: 0n };
    },
  };
  const claims = createMemoryClaimStore();

  return { created, changes, settled, rows, claims, rail: createX402Rail({ setup: railSetup, recorder, ledger, claims, clock, logger: log }) };
};

const resource = 'https://pay.anyfare.test/api.example.com/v1/price';
let counter = 0;
const quoteOf = (price = 1_000n): Quote => {
  counter += 1;

  return {
    paymentId: `pay_x402_${counter}`,
    requestId: `req-${counter}`,
    resource,
    priceMicroUsd: price,
    description: 'GET api.example.com/v1/price',
    subject: { targetHost: 'api.example.com', targetPath: '/v1/price' },
  };
};

const requiredOf = async (rail: PaymentRail, quote: Quote): Promise<PaymentRequired> =>
  decodePaymentRequiredHeader((await rail.challenge(quote))!.headers!['payment-required']!);

const buyer = privateKeyToAccount(generatePrivateKey());

/** A payment the official x402 client signs for one of the 402's options, on `network`. */
const pay = async (required: PaymentRequired, network: string): Promise<string> => {
  const client = new x402Client()
    .register(base, new ExactEvmScheme(buyer))
    .register(solana, new ExactSvmScheme(await generateKeyPairSigner(), { rpcUrl: rpc.url }))
    .register(near, new ExactNearScheme(nearSigner));

  return encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === network) }));
};

const paidCredential = (rail: PaymentRail, header: string) => rail.detect({ 'payment-signature': header })!;

/** A verified payment on Base, ready to finalize or abort. */
const authorized = async (options?: Parameters<typeof createPorts>[1]) => {
  const ports = createPorts(setup, options);
  const quote = quoteOf();
  const authorization = await ports.rail.authorize(paidCredential(ports.rail, await pay(await requiredOf(ports.rail, quote), base)), quote);

  return { ...ports, quote, authorization };
};

const settleCount = (target: FakeFacilitator = facilitator) => target.requests.filter(request => request.path === '/settle').length;

// The change finalize records before the settle: settling, with the settle to repeat
const beforeSettle = (paymentId: string) => ({
  paymentId, to: 'settling', from: 'verified',
  settlementRequest: { paymentPayload: expect.objectContaining({ x402Version: 2 }), paymentRequirements: expect.objectContaining({ network: base }) },
});

/** A Base payment whose option says it accepted another value of one field. */
const altered = (field: string, value: unknown) => async (rail: PaymentRail): Promise<string> => {
  const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quoteOf()), base));

  return encodePaymentSignatureHeader({ ...payload, accepted: { ...payload.accepted, [field]: value } });
};

/** The claims of a CDP JWT in an Authorization header, once its EdDSA signature checks out. */
const jwtClaims = (authorization: unknown, publicKey: KeyObject): Record<string, unknown> => {
  const [header, claims, signature] = String(authorization).replace(/^Bearer /, '').split('.') as [string, string, string];
  expect(verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);

  return JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>;
};

const ed25519Secret = (pair: { readonly privateKey: KeyObject; readonly publicKey: KeyObject }): string => Buffer.concat([
  Buffer.from(pair.privateKey.export({ format: 'jwk' }).d!, 'base64url'),
  Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url'),
]).toString('base64');

describe('the x402 challenge', () => {
  it('offers one exact option per asset on Base, Solana and NEAR with the price in atomic units, and none on Tempo, which MPP serves', async () => {
    const { rail } = createPorts();

    const required = await requiredOf(rail, quoteOf(1_234n));

    expect(required).toMatchObject({ x402Version: 2, resource: { url: resource, description: 'GET api.example.com/v1/price' } });
    expect(required.extensions).toBeUndefined();
    expect(required.accepts).toEqual([
      expect.objectContaining({ scheme: 'exact', network: base, asset: baseUsdc, amount: '1234', payTo: basePayTo, extra: expect.objectContaining({ name: 'USDC', version: '2' }) }),
      expect.objectContaining({
        scheme: 'exact', network: solana, asset: solanaUsdc, amount: '1234', payTo: solanaPayTo, extra: expect.objectContaining({ feePayer, transactionVersions: [0, 1] }),
      }),
      // No extra: NEAR's scheme needs none
      expect.objectContaining({ scheme: 'exact', network: near, asset: nearUsdc, amount: '1234', payTo: nearPayTo, extra: {} }),
    ]);
  });

  it('skips an asset whose minimum price is above the call\'s', async () => {
    const minimum = { ...config, assets: config.assets.map(asset => asset.name === 'solana-usdc' ? { ...asset, minPrice: 50_000n } : asset) };
    const narrowed = await initializeX402({ config: minimum, facilitators: createFacilitators({ config: minimum, cdpApiKey: noCdpKey, facilitatorApiKey: facilitatorKey, clock }), timeoutMs: 5_000 });
    const { rail } = createPorts(narrowed);

    expect((await requiredOf(rail, quoteOf(1_000n))).accepts.map(option => option.network)).toEqual([base, near]);
    expect((await requiredOf(rail, quoteOf(50_000n))).accepts.map(option => option.network)).toEqual([base, solana, near]);
  });
});

describe('x402 payments through the facilitator', () => {
  it.each([
    ['Base', base, 'base-usdc'],
    ['Solana', solana, 'solana-usdc'],
    ['NEAR', near, 'near-usdc'],
  ])('verifies a payment signed on %s by the official client, records it, then settles and books it', async (_case, network, asset) => {
    const { rail, created, settled } = createPorts();
    const quote = quoteOf();
    const header = await pay(await requiredOf(rail, quote), network);

    const authorization = await rail.authorize(paidCredential(rail, header), quote);
    const receipt = await rail.finalize(authorization);

    expect(created).toEqual([{
      id: quote.paymentId, requestId: quote.requestId, rail: 'x402', buyerAccountId: undefined, keyId: undefined,
      targetHost: 'api.example.com', targetPath: '/v1/price', network, asset, atomicAmount: 1_000n, amount: 1_000n, status: 'verified',
    }]);
    expect(authorization.buyer).toMatch(new RegExp(`^address:${network}:`));
    expect(settled).toEqual([{ paymentId: quote.paymentId, asset, transactionHash: expect.any(String), receipt: receipt.headers['payment-response'], needsReview: false }]);
    expect(decodePaymentResponseHeader(receipt.headers['payment-response']!)).toMatchObject({ success: true, network });
    expect(facilitator.requests.map(request => request.path)).toEqual(expect.arrayContaining(['/verify', '/settle']));
  });

  it.each([
    ['both versions, the highest', undefined, 1],
    ['version 0 only', [0], 0],
  ] as const)('builds a Solana payment in a transaction version the facilitator advertised: %s', async (_case, transactionVersions, version) => {
    const advertising = transactionVersions === undefined ? facilitator : await startFakeFacilitator({ networks: [base, solana, near], feePayer, transactionVersions });
    try {
      const { rail } = createPorts(advertising === facilitator ? setup : await setupFor(advertising.url));
      const quote = quoteOf();
      const required = await requiredOf(rail, quote);

      const payload = decodePaymentSignatureHeader(await pay(required, solana));

      expect(required.accepts.find(option => option.network === solana)?.extra['transactionVersions']).toEqual(transactionVersions ?? [0, 1]);
      expect(decodeSolanaPayment(String(payload.payload['transaction']))).toMatchObject({
        version,
        feePayer,
        unsignedBy: [feePayer],
        transfer: { mint: solanaUsdc, destination: await associatedTokenAddress(solanaPayTo, solanaUsdc), amount: 1_000n, decimals: 6 },
      });
      await expect(rail.authorize(paidCredential(rail, encodePaymentSignatureHeader(payload)), quote)).resolves.toMatchObject({ network: solana, asset: 'solana-usdc' });
    }
    finally {
      if (advertising !== facilitator)
        await advertising.close();
    }
  });

  it('refuses a payment the facilitator rejects with payment_invalid, recording nothing', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    facilitator.handle('/verify', facilitatorAnswers.invalid('insufficient_funds'));

    const error = await rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PaymentInvalidError);
    expect((error as Error).message).toContain('insufficient_funds');
    expect(created).toEqual([]);
  });

  it.each([
    ['a payment for another price', async (rail: PaymentRail) => pay(await requiredOf(rail, quoteOf(999n)), base)],
    ['a header that isn\'t base64 JSON', async () => 'not a payment'],
    ['a payment to another payTo', altered('payTo', '0x3333333333333333333333333333333333333333')],
    ['a payment in another asset', altered('asset', '0x4444444444444444444444444444444444444444')],
    ['a payment on another network', altered('network', 'eip155:8453')],
    ['a payment in another scheme', altered('scheme', 'upto')],
    ['a payment with a longer deadline', altered('maxTimeoutSeconds', 3_600)],
    ['a payment that adds another transfer method to the quote, Permit2 on Base', async (rail: PaymentRail) => {
      const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quoteOf()), base));

      return encodePaymentSignatureHeader({ ...payload, accepted: { ...payload.accepted, extra: { ...payload.accepted.extra, assetTransferMethod: 'permit2' } } });
    }],
  ])('refuses %s with payment_invalid before asking the facilitator', async (_case, header) => {
    const { rail } = createPorts();
    const before = facilitator.requests.length;

    await expect(rail.authorize(paidCredential(rail, await header(rail)), quoteOf())).rejects.toBeInstanceOf(PaymentInvalidError);
    expect(facilitator.requests.length).toBe(before);
  });

  it('refuses a payment that carries extensions, which this resource doesn\'t offer, before asking the facilitator', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quote), base));
    const header = encodePaymentSignatureHeader({ ...payload, extensions: { 'example-extension': { info: { note: 'echoed' } } } });
    const before = facilitator.requests.length;

    const error = await rail.authorize(paidCredential(rail, header), quote).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PaymentInvalidError);
    expect(error).toMatchObject({ reason: 'extension_echo_mismatch' });
    expect(facilitator.requests.length).toBe(before);
    expect(created).toEqual([]);
  });

  it('refuses a Base payment signed for Permit2, when its option is EIP-3009, before asking the facilitator', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quote), base));
    const permit2Authorization = {
      from: buyer.address,
      permitted: { token: baseUsdc, amount: '1000' },
      spender: '0x5555555555555555555555555555555555555555',
      nonce: '7',
      deadline: String(Math.floor(Date.now() / 1_000) + 300),
      witness: { to: basePayTo, validAfter: '0' },
    };
    const header = encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, permit2Authorization } });
    const before = facilitator.requests.length;

    const error = await rail.authorize(paidCredential(rail, header), quote).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PaymentInvalidError);
    expect(error).toMatchObject({ reason: 'transfer_method' });
    expect(facilitator.requests.length).toBe(before);
    expect(created).toEqual([]);
  });

  it('refuses x402 v1 (X-PAYMENT) with payment_invalid', async () => {
    const { rail } = createPorts();

    await expect(rail.authorize(rail.detect({ 'x-payment': 'eyJ4NDAyVmVyc2lvbiI6MX0=' })!, quoteOf())).rejects.toThrow(/PAYMENT-SIGNATURE/);
  });

  it('refuses a payment the facilitator answers with a plain 400, as live CDP does for a malformed one', async () => {
    const { rail } = createPorts();
    const quote = quoteOf();
    facilitator.handle('/verify', () => ({ status: 400, body: { errorType: 'invalid_request', errorMessage: '\'paymentPayload\' is invalid' } }));

    await expect(rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote)).rejects.toMatchObject({
      message: 'The facilitator rejected the payment: refused_400', reason: 'refused_400',
    });
  });

  it.each([400, 404, 409])('answers a /settle refused with a plain %i as a failed settlement, refused_<status>: the status, never a reason it didn\'t give', async status => {
    const { rail, authorization } = await authorized();
    facilitator.handle('/settle', () => ({ status, body: { errorType: 'invalid_request', errorMessage: 'refused' } }));

    await expect(rail.finalize(authorization)).rejects.toMatchObject({ code: 'settlement_failed', outcome: 'failed', reason: `refused_${status}` });
  });

  it.each([
    [401, { errorType: 'unauthorized' }],
    [403, { isValid: false, invalidReason: 'insufficient_funds' }],
    [408, { isValid: false, invalidReason: 'insufficient_funds' }],
    [429, { isValid: false, invalidReason: 'insufficient_funds' }],
  ])('treats a %i at verify as the facilitator being unavailable, not the payment being invalid, whatever its body', async (status, body) => {
    const { rail } = createPorts();
    const quote = quoteOf();
    facilitator.handle('/verify', () => ({ status, body }));

    await expect(rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote)).rejects.toBeInstanceOf(FacilitatorUnavailableError);
  });

  it('answers a facilitator that is down at verify with facilitator_unavailable', async () => {
    const { rail } = createPorts();
    const quote = quoteOf();
    facilitator.handle('/verify', facilitatorAnswers.unavailable);

    await expect(rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote)).rejects.toBeInstanceOf(FacilitatorUnavailableError);
  });

  it('records the payment as settling, with the settle to repeat, before the facilitator answers', async () => {
    const { rail, changes, authorization } = await authorized();
    facilitator.handle('/settle', facilitatorAnswers.timeout(1_500));
    const before = settleCount();

    const finalizing = rail.finalize(authorization).catch((error: unknown) => error);
    await vi.waitFor(() => expect(settleCount() - before).toBe(1));

    expect(changes).toEqual([beforeSettle(authorization.paymentId)]);
    expect(await finalizing).toMatchObject({ code: 'settlement_failed', outcome: 'unknown' });
    expect(changes).toHaveLength(1);
  });

  it('sends the response on a pending settlement with a hash, and records it as settling with what to repeat', async () => {
    const { rail, changes, settled, authorization, quote } = await authorized();
    facilitator.handle('/settle', facilitatorAnswers.pending('0xbroadcast'));
    const before = facilitator.requests.length;

    const receipt = await rail.finalize(authorization);

    expect(decodePaymentResponseHeader(receipt.headers['payment-response']!)).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: '0xbroadcast' });
    expect(changes).toEqual([beforeSettle(quote.paymentId), expect.objectContaining({
      paymentId: quote.paymentId, to: 'settling', transactionHash: '0xbroadcast', receipt: receipt.headers['payment-response'],
      settlementRequest: { paymentPayload: expect.objectContaining({ x402Version: 2 }), paymentRequirements: expect.objectContaining({ network: base }) },
    })]);
    expect(settled).toEqual([]);
    // The SDK repeats a pending settle once before answering
    expect(facilitator.requests.slice(before).map(request => request.path)).toEqual(['/settle', '/settle']);
  });

  it.each<[string, string, FacilitatorScript]>([
    ['a timeout', 'settling', facilitatorAnswers.timeout(1_500)],
    ['a 503', 'settling', facilitatorAnswers.unavailable],
    ['a failed settlement', 'failed', facilitatorAnswers.failed()],
    ['a plain 400, refused before anything was submitted', 'failed', () => ({ status: 400, body: { errorMessage: 'invalid' } })],
    ['a 401', 'settling', () => ({ status: 401, body: { errorType: 'unauthorized' } })],
    ['a 429 whose body is a failed settlement', 'settling', request => ({ ...facilitatorAnswers.failed()(request), status: 429 })],
    ['a 2xx answer that isn\'t JSON', 'settling', () => ({ status: 200 })],
    ['a settled answer over 1 MiB', 'settling', request => ({ status: 200, body: { ...facilitatorAnswers.settled(request).body as object, padding: 'x'.repeat(2 * 1024 * 1024) } })],
  ])('refuses to send the response on %s with settlement_failed, recording it as %s', async (_case, status, answer) => {
    const { rail, changes, settled, authorization } = await authorized();
    facilitator.handle('/settle', answer);

    await expect(rail.finalize(authorization)).rejects.toBeInstanceOf(SettlementFailedError);

    // Settling from before the settle, so a payment whose outcome is unknown needs no other change
    expect(changes).toEqual([beforeSettle(authorization.paymentId), ...status === 'failed' ? [{ paymentId: authorization.paymentId, to: 'failed', settlementRequest: null }] : []]);
    expect(settled).toEqual([]);
  });

  it('cancels on abort: nothing settles', async () => {
    const { rail, changes, authorization } = await authorized();
    const before = facilitator.requests.filter(request => request.path === '/settle').length;

    await rail.abort(authorization);

    expect(changes).toEqual([{ paymentId: authorization.paymentId, to: 'cancelled' }]);
    expect(facilitator.requests.filter(request => request.path === '/settle')).toHaveLength(before);
  });
});

describe('one signed payment, one call', () => {
  it.each([
    ['Base', base],
    ['Solana', solana],
    ['NEAR', near],
  ])('verifies one of two concurrent calls paid with the same %s payment, and refuses the other as replayed', async (_case, network) => {
    const { rail, created } = createPorts();
    const [first, second] = [quoteOf(), quoteOf()];
    const header = await pay(await requiredOf(rail, first), network);
    const verifies = () => facilitator.requests.filter(request => request.path === '/verify').length;
    const before = verifies();

    const results = await Promise.allSettled([rail.authorize(paidCredential(rail, header), first), rail.authorize(paidCredential(rail, header), second)]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])).toEqual([
      expect.objectContaining({ code: 'payment_invalid', reason: 'replayed', message: 'This payment was already used. Request the resource again and sign a new one.' }),
    ]);
    expect(verifies() - before).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('takes the same payment again once its call was cancelled or its settlement failed, and not once it settled', async () => {
    const { rail } = createPorts();
    const header = await pay(await requiredOf(rail, quoteOf()), base);
    const authorize = () => rail.authorize(paidCredential(rail, header), quoteOf());

    await rail.abort(await authorize());
    facilitator.handle('/settle', facilitatorAnswers.failed());
    await expect(rail.finalize(await authorize())).rejects.toBeInstanceOf(SettlementFailedError);
    facilitator.reset();
    await rail.finalize(await authorize());

    await expect(authorize()).rejects.toMatchObject({ reason: 'replayed' });
  });

  it('holds a Base payment\'s claim until its signature\'s deadline, an hour ahead, plus a minute', async () => {
    const { rail, claims } = createPorts();
    const quote = quoteOf();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quote), base));
    const authorization = payload.payload['authorization'] as Record<string, unknown>;
    const validBefore = Math.floor(Date.now() / 1_000) + 3_600;
    const header = encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, authorization: { ...authorization, validBefore: String(validBefore) } } });

    await rail.authorize(paidCredential(rail, header), quote);

    expect([...claims.claims]).toEqual([[`x402:${base}:${String(authorization['nonce']).toLowerCase()}`, validBefore * 1_000 + 60_000]]);
  });

  it('holds a Base payment\'s claim a week at most, whatever its deadline', async () => {
    const { rail, claims } = createPorts();
    const quote = quoteOf();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quote), base));
    const authorization = payload.payload['authorization'] as Record<string, unknown>;
    const header = encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, authorization: { ...authorization, validBefore: '99999999999999999999' } } });
    const week = 7 * 24 * 60 * 60_000;
    const before = Date.now();

    await rail.authorize(paidCredential(rail, header), quote);

    const [expiresAt] = [...claims.claims.values()];
    expect(expiresAt).toBeGreaterThanOrEqual(before + week);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + week);
  });

  it.each([
    ['a deadline that isn\'t a number', 'soon'],
    ['a negative deadline', '-1'],
    ['a fractional deadline', '1.5'],
    ['no deadline', undefined],
  ])('refuses a Base payment with %s as invalid_payload, before asking the facilitator', async (_case, validBefore) => {
    const { rail, claims } = createPorts();
    const quote = quoteOf();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quote), base));
    const authorization = payload.payload['authorization'] as Record<string, unknown>;
    const header = encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, authorization: { ...authorization, validBefore } } });
    const before = facilitator.requests.length;

    await expect(rail.authorize(paidCredential(rail, header), quote)).rejects.toMatchObject({ code: 'payment_invalid', reason: 'invalid_payload' });
    expect(facilitator.requests.length).toBe(before);
    expect(claims.claims.size).toBe(0);
  });

  it('refuses a Base payment that expires in 10 seconds as too_short, before asking the facilitator: its settle could fail after the call', async () => {
    const { rail, claims } = createPorts();
    const quote = quoteOf();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quote), base));
    const authorization = payload.payload['authorization'] as Record<string, unknown>;
    const validBefore = Math.floor(Date.now() / 1_000) + 10;
    const header = encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, authorization: { ...authorization, validBefore: String(validBefore) } } });
    const before = facilitator.requests.length;

    await expect(rail.authorize(paidCredential(rail, header), quote)).rejects.toMatchObject({ code: 'payment_invalid', reason: 'too_short' });
    expect(facilitator.requests.length).toBe(before);
    expect(claims.claims.size).toBe(0);
    expect(minPaymentWindowMs).toBe(15_000);
  });

  it('gives a payment the moment it can no longer settle: a Base payment\'s validBefore, and a minute for a Solana one', async () => {
    const { rail } = createPorts();
    const baseQuote = quoteOf();
    const header = await pay(await requiredOf(rail, baseQuote), base);
    const { validBefore } = decodePaymentSignatureHeader(header).payload['authorization'] as { validBefore: string };
    const solanaQuote = quoteOf();
    const solanaHeader = await pay(await requiredOf(rail, solanaQuote), solana);

    const onBase = await rail.authorize(paidCredential(rail, header), baseQuote);
    const before = Date.now();
    const onSolana = await rail.authorize(paidCredential(rail, solanaHeader), solanaQuote);

    expect(onBase.deadlineMs).toBe(Number(validBefore) * 1_000);
    expect(onBase.deadlineMs! - Date.now()).toBeGreaterThan(minPaymentWindowMs);
    expect(onSolana.deadlineMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(onSolana.deadlineMs).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('takes a Solana transaction once, however its base64 is padded', async () => {
    const { rail, claims } = createPorts();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quoteOf()), solana));
    const transaction = String(payload.payload['transaction']);
    const stripped = transaction.replace(/=+$/, '');
    const spellings = [...new Set([transaction, stripped, `${stripped}=`, `${stripped}==`])];
    const headerOf = (spelling: string) => encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, transaction: spelling } });

    const results = await Promise.allSettled(spellings.map(spelling => rail.authorize(paidCredential(rail, headerOf(spelling)), quoteOf())));

    expect(spellings.length).toBeGreaterThanOrEqual(3);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []))
      .toEqual(spellings.slice(1).map(() => expect.objectContaining({ reason: 'replayed' })));
    expect(claims.claims.size).toBe(1);
  });

  it.each([
    ['isn\'t base64', '%%%'],
    ['is empty', ''],
    ['decodes to no bytes', 'A'],
    ['is only padding', '===='],
  ])('refuses a Solana payment whose transaction %s as invalid_payload, before asking the facilitator', async (_case, transaction) => {
    const { rail } = createPorts();
    const quote = quoteOf();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quote), solana));
    const header = encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, transaction } });
    const before = facilitator.requests.length;

    await expect(rail.authorize(paidCredential(rail, header), quote)).rejects.toMatchObject({ code: 'payment_invalid', reason: 'invalid_payload' });
    expect(facilitator.requests.length).toBe(before);
  });

  it('takes the same payment again after the facilitator was down at verify: nothing was forwarded', async () => {
    const { rail } = createPorts();
    const header = await pay(await requiredOf(rail, quoteOf()), base);
    facilitator.handle('/verify', facilitatorAnswers.unavailable);

    await expect(rail.authorize(paidCredential(rail, header), quoteOf())).rejects.toBeInstanceOf(FacilitatorUnavailableError);
    facilitator.reset();

    await expect(rail.authorize(paidCredential(rail, header), quoteOf())).resolves.toMatchObject({ rail: 'x402' });
  });
});

describe('NEAR payments', () => {
  it('names the delegate action\'s sender as the buyer and the payer, and sends the facilitator the signed action', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    const header = await pay(await requiredOf(rail, quote), near);
    const signed = String(decodePaymentSignatureHeader(header).payload['signedDelegateAction']);
    const before = facilitator.requests.length;

    const authorization = await rail.authorize(paidCredential(rail, header), quote);
    const receipt = await rail.finalize(authorization);

    expect(decodeSignedDelegateB64(signed).delegate).toMatchObject({ senderId: 'buyer.testnet', receiverId: nearUsdc });
    expect(decodeSignedDelegateB64(signed).delegate.nonce).toBeGreaterThan(7n);
    expect(authorization).toMatchObject({ buyer: 'address:near:testnet:buyer.testnet', network: near, asset: 'near-usdc' });
    expect(created[0]).toMatchObject({ network: near, asset: 'near-usdc', atomicAmount: 1_000n, status: 'verified' });
    expect(decodePaymentResponseHeader(receipt.headers['payment-response']!)).toMatchObject({ success: true, network: near, payer: 'buyer.testnet' });
    const sent = facilitator.requests.slice(before).filter(request => request.path !== '/supported');
    expect(sent.map(request => request.path)).toEqual(['/verify', '/settle']);
    expect(sent[0]!.body).toMatchObject({ paymentPayload: { payload: { signedDelegateAction: signed } }, paymentRequirements: { network: near, asset: nearUsdc, amount: '1000', payTo: nearPayTo } });
  });

  it('claims one key per signed action: a SHA-256 of its bytes, however its base64 is padded', async () => {
    const { rail, claims } = createPorts();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quoteOf()), near));
    const signed = String(payload.payload['signedDelegateAction']);
    const stripped = signed.replace(/=+$/, '');
    const spellings = [...new Set([signed, stripped, `${stripped}=`, `${stripped}==`])];
    const headerOf = (spelling: string) => encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, signedDelegateAction: spelling } });

    const results = await Promise.allSettled(spellings.map(spelling => rail.authorize(paidCredential(rail, headerOf(spelling)), quoteOf())));

    expect(spellings.length).toBeGreaterThanOrEqual(3);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect([...claims.claims.keys()]).toEqual([`x402:${near}:${createHash('sha256').update(Buffer.from(signed, 'base64')).digest('hex')}`]);

    const other = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quoteOf()), near));
    expect(other.payload['signedDelegateAction']).not.toBe(signed);
    await expect(rail.authorize(paidCredential(rail, encodePaymentSignatureHeader(other)), quoteOf())).resolves.toMatchObject({ network: near });
    expect(claims.claims.size).toBe(2);
  });

  it('gives a payment the option\'s timeout at half a second a block: the SDK counts the window in blocks, which take about 0.6 s', async () => {
    const { rail } = createPorts();
    const quote = quoteOf();
    const required = await requiredOf(rail, quote);
    const timeout = required.accepts.find(option => option.network === near)!.maxTimeoutSeconds;
    const header = await pay(required, near);

    const before = Date.now();
    const authorization = await rail.authorize(paidCredential(rail, header), quote);

    expect(timeout).toBeGreaterThan(30);
    expect(authorization.deadlineMs).toBeGreaterThanOrEqual(before + timeout * 500);
    expect(authorization.deadlineMs).toBeLessThanOrEqual(Date.now() + timeout * 500);
    expect(authorization.deadlineMs! - Date.now()).toBeGreaterThan(minPaymentWindowMs);
  });

  it('refuses a NEAR payment with no signed action as invalid_payload, before asking the facilitator', async () => {
    const { rail } = createPorts();
    const quote = quoteOf();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quote), near));
    const header = encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, signedDelegateAction: '' } });
    const before = facilitator.requests.length;

    await expect(rail.authorize(paidCredential(rail, header), quote)).rejects.toMatchObject({ code: 'payment_invalid', reason: 'invalid_payload' });
    expect(facilitator.requests.length).toBe(before);
  });
});

describe('finalize and abort, run twice', () => {
  it('answers a second finalize with the stored receipt, asking the facilitator once', async () => {
    const { rail, settled, authorization } = await authorized();
    const before = settleCount();

    const first = await rail.finalize(authorization);
    const second = await rail.finalize(authorization);

    expect(second).toEqual(first);
    expect(first.settlement).toMatchObject({ status: 'settled', transaction: expect.stringMatching(/^0x/) });
    expect(settleCount() - before).toBe(1);
    expect(settled).toHaveLength(1);
  });

  it('settles once for two concurrent finalizes: the other answers unknown, and the payment ends settled', async () => {
    const { rail, rows, changes, settled, authorization } = await authorized();
    const before = settleCount();

    const results = await Promise.allSettled([rail.finalize(authorization), rail.finalize(authorization)]);

    expect(settleCount() - before).toBe(1);
    const receipts = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
    expect(receipts).toEqual([expect.objectContaining({ settlement: { status: 'settled', transaction: expect.stringMatching(/^0x/) } })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SettlementFailedError);
    expect(errors[0]).toMatchObject({ outcome: 'unknown' });
    expect(rows.get(authorization.paymentId)).toMatchObject({ status: 'settled', receipt: receipts[0]!.headers['payment-response'] });
    expect(changes.map(change => change.to)).not.toContain('failed');
    expect(settled).toHaveLength(1);
  });

  it('records a payment that settled but whose booking failed as settling, with the settled answer to book, and sends no response', async () => {
    const { rail, changes, authorization } = await authorized({ bookingFails: new Error('The call has no target leg to charge') });
    const before = settleCount();

    const error = await rail.finalize(authorization).catch((thrown: unknown) => thrown) as SettlementFailedError;

    expect(error).toBeInstanceOf(SettlementFailedError);
    expect(error).toMatchObject({ outcome: 'unknown', reason: 'booking_failed', network: base, transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(changes).toEqual([
      beforeSettle(authorization.paymentId),
      expect.objectContaining({ to: 'settling', transactionHash: error.transaction, receipt: expect.any(String), needsReview: true }),
    ]);
    const request = fromSettlementRequest(changes[1]!.settlementRequest as JsonObject);
    expect(request?.settled).toMatchObject({ success: true, transaction: error.transaction, network: base });
    expect(request?.paymentRequirements).toMatchObject({ network: base, payTo: basePayTo });
    // The settlement follow-up books it. A second finalize answers what was stored, without settling again.
    expect(await rail.finalize(authorization)).toEqual({
      headers: { 'payment-response': changes[1]!.receipt }, settlement: { status: 'settling', transaction: error.transaction },
    });
    expect(settleCount() - before).toBe(1);
  });

  it.each<[string, FacilitatorScript]>([
    ['a plain 400', () => ({ status: 400, body: { errorMessage: 'already submitted' } })],
    ['a failed settlement', facilitatorAnswers.failed('transaction_not_found')],
    ['a 503', facilitatorAnswers.unavailable],
  ])('keeps the broadcast hash when the repeat of a pending settle answers %s, and records the payment as settling', async (_case, repeat) => {
    const { rail, changes, settled, authorization } = await authorized();
    let calls = 0;
    facilitator.handle('/settle', request => calls++ === 0 ? facilitatorAnswers.pending('0xbroadcast')(request) : repeat(request));

    const receipt = await rail.finalize(authorization);

    expect(calls).toBe(2);
    expect(decodePaymentResponseHeader(receipt.headers['payment-response']!)).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: '0xbroadcast' });
    expect(receipt.settlement).toEqual({ status: 'settling', transaction: '0xbroadcast' });
    expect(changes).toEqual([beforeSettle(authorization.paymentId), expect.objectContaining({ to: 'settling', transactionHash: '0xbroadcast' })]);
    expect(settled).toEqual([]);
  });

  it('records the payment as failed when the repeat of a pending settle reports that transaction failed on chain', async () => {
    const { rail, changes, settled, authorization } = await authorized();
    let calls = 0;
    facilitator.handle('/settle', request => calls++ === 0
      ? facilitatorAnswers.pending('0xbroadcast')(request)
      : { status: 200, body: { success: false, errorReason: 'transaction_failed', transaction: '0xbroadcast', network: base } });

    await expect(rail.finalize(authorization)).rejects.toMatchObject({ code: 'settlement_failed', outcome: 'failed', reason: 'transaction_failed', transaction: '0xbroadcast' });

    expect(calls).toBe(2);
    expect(changes).toEqual([beforeSettle(authorization.paymentId), expect.objectContaining({ to: 'failed', settlementRequest: null })]);
    expect(settled).toEqual([]);
  });

  it('answers a second finalize of an unknown outcome with settlement_failed, without settling again', async () => {
    const { rail, authorization } = await authorized();
    facilitator.handle('/settle', facilitatorAnswers.unavailable);
    await expect(rail.finalize(authorization)).rejects.toBeInstanceOf(SettlementFailedError);
    const before = settleCount();

    await expect(rail.finalize(authorization)).rejects.toMatchObject({ code: 'settlement_failed', outcome: 'unknown' });
    expect(settleCount()).toBe(before);
  });

  it('gives nothing back on a second abort, refuses to finalize a cancelled payment, and refuses an abort after the settlement', async () => {
    const aborted = await authorized();
    await aborted.rail.abort(aborted.authorization);
    await aborted.rail.abort(aborted.authorization);

    expect(aborted.changes).toEqual([{ paymentId: aborted.authorization.paymentId, to: 'cancelled' }]);
    await expect(aborted.rail.finalize(aborted.authorization)).rejects.toBeInstanceOf(InvalidPaymentStatusChangeError);

    const done = await authorized();
    await done.rail.finalize(done.authorization);

    await expect(done.rail.abort(done.authorization)).rejects.toThrow('can\'t be cancelled after its settlement');
  });
});

describe('the facilitator client', () => {
  it('treats a verify answer over 1 MiB as the facilitator being unavailable', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    facilitator.handle('/verify', request => ({ status: 200, body: { ...facilitatorAnswers.valid(request).body as object, padding: 'x'.repeat(2 * 1024 * 1024) } }));

    const error = await rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FacilitatorUnavailableError);
    expect((error as Error).message).toContain('more than 1048576 bytes');
    expect(created).toEqual([]);
  });

  it('treats a redirect as the facilitator being unavailable, and doesn\'t follow it', async () => {
    const redirector = createServer((request, response) => {
      response.writeHead(307, { location: `${facilitator.url}${request.url ?? '/'}` });
      response.end();
    });
    await new Promise<void>(resolve => redirector.listen(0, '127.0.0.1', resolve));
    const before = facilitator.requests.length;
    try {
      const document = await configWith(`http://127.0.0.1:${(redirector.address() as AddressInfo).port}`);
      const [client] = createFacilitators({ config: document, cdpApiKey: noCdpKey, facilitatorApiKey: facilitatorKey, clock });

      await expect(client!.getSupported()).rejects.toMatchObject({ code: 'facilitator_unavailable', reason: 'connection failed' });
      expect(facilitator.requests.length).toBe(before);
    }
    finally {
      redirector.closeAllConnections();
      await new Promise<void>(resolve => redirector.close(() => resolve()));
    }
  });

  it('routes each network to the facilitator platform config names for it, though another lists it too', async () => {
    const otherFeePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 9));
    const [wide, narrow] = await Promise.all([
      startFakeFacilitator({ networks: [base, solana], feePayer }),
      startFakeFacilitator({ networks: [solana], feePayer: otherFeePayer }),
    ]);
    try {
      const document = withTestPayTo(await configWith(wide.url, {
        facilitators: [
          { name: 'wide', url: wide.url, networks: [base] },
          { name: 'narrow', url: narrow.url, networks: [solana] },
        ],
      }));
      const routed = await initializeX402({ config: document, facilitators: createFacilitators({ config: document, cdpApiKey: noCdpKey, facilitatorApiKey: facilitatorKey, clock }), timeoutMs: 5_000 });
      const { rail } = createPorts(routed);
      const quote = quoteOf();
      const required = await requiredOf(rail, quote);

      await rail.finalize(await rail.authorize(paidCredential(rail, await pay(required, solana)), quote));

      expect(required.accepts.find(option => option.network === solana)?.extra['feePayer']).toBe(otherFeePayer);
      expect(routed.facilitatorFor(solana)?.name).toBe('narrow');
      expect(narrow.requests.map(request => request.path)).toEqual(['/supported', '/supported', '/verify', '/settle']);
      expect(wide.requests.map(request => request.path)).toEqual(['/supported', '/supported']);
    }
    finally {
      await Promise.all([wide.close(), narrow.close()]);
    }
  });

  it('signs a payment\'s POST /verify and /settle with a CDP JWT naming each, as it does GET /supported', async () => {
    const pair = generateKeyPairSync('ed25519');
    const signed = await startFakeFacilitator({ networks: [base, solana], feePayer });
    try {
      const document = withTestPayTo(await configWith(signed.url, {
        facilitators: [
          { name: 'cdp', url: signed.url, networks: [base, solana], auth: { type: 'cdp', apiKeyId: 'CDP_API_KEY_ID', apiKeySecret: 'CDP_API_KEY_SECRET' } },
        ],
      }));
      const cdpApiKey = () => ({ id: Secret.from('organizations/test/apiKeys/key-1'), secret: Secret.from(ed25519Secret(pair)) });
      const signedSetup = await initializeX402({ config: document, facilitators: createFacilitators({ config: document, cdpApiKey, clock }), timeoutMs: 5_000 });
      const { rail } = createPorts(signedSetup);
      const quote = quoteOf();

      await rail.finalize(await rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote));

      const host = new URL(signed.url).host;
      expect(signed.requests.map(request => `${request.method} ${request.path}`)).toEqual(['GET /supported', 'GET /supported', 'POST /verify', 'POST /settle']);
      for (const request of signed.requests)
        expect(jwtClaims(request.headers.authorization, pair.publicKey)).toMatchObject({ uris: [`${request.method} ${host}${request.path}`] });
    }
    finally {
      await signed.close();
    }
  });
});

describe('the payment in logs and errors', () => {
  it.each([
    ['Base', base],
    ['Solana', solana],
    ['NEAR', near],
  ])('never writes a %s payment\'s header or signature to the log, or into an error\'s message', async (_case, network) => {
    const lines: string[] = [];
    const captured = createLogger({ level: 'trace' }, { write: (line: string) => lines.push(line) });
    const secrets: string[] = [];
    const messages: string[] = [];
    // Signs a payment, keeps what must stay out of the log, and runs the call with it
    const attempt = async (ports: ReturnType<typeof createPorts>, run: (authorize: () => Promise<Authorization>) => Promise<unknown>) => {
      const quote = { ...quoteOf(), log: captured };
      const header = await pay(await requiredOf(ports.rail, quote), network);
      const payload = decodePaymentSignatureHeader(header).payload;
      secrets.push(header, String(payload['signature'] ?? payload['transaction'] ?? payload['signedDelegateAction']));
      try {
        await run(() => ports.rail.authorize(paidCredential(ports.rail, header), quote));
      }
      catch (error) {
        messages.push((error as Error).message);
        captured.error({ error }, 'The call failed');
      }
    };
    const ports = createPorts(setup, { log: captured });

    facilitator.handle('/verify', facilitatorAnswers.invalid('insufficient_funds'));
    await attempt(ports, authorize => authorize());
    facilitator.reset();
    await attempt(ports, async authorize => {
      await authorize();
      await authorize();
    });
    facilitator.handle('/settle', facilitatorAnswers.failed());
    await attempt(ports, async authorize => ports.rail.finalize(await authorize()));
    facilitator.handle('/settle', facilitatorAnswers.unavailable);
    await attempt(ports, async authorize => ports.rail.finalize(await authorize()));
    facilitator.reset();
    const booking = createPorts(setup, { log: captured, bookingFails: new Error('The ledger is down') });
    await attempt(booking, async authorize => booking.rail.finalize(await authorize()));

    expect(messages).toHaveLength(5);
    expect(lines.length).toBeGreaterThanOrEqual(8);
    const written = [...lines, ...messages].join('\n');
    for (const secret of secrets)
      expect(written).not.toContain(secret);
  });
});

describe('facilitators at startup', () => {
  it.each([
    ['no fee payer', { networks: [base, solana] }, 'no fee payer'],
    ['no transaction versions', { networks: [base, solana], feePayer, transactionVersions: [] }, 'no transaction versions of 0 or 1'],
    ['a transaction version other than 0 and 1', { networks: [base, solana], feePayer, transactionVersions: [0, 2] }, 'no transaction versions of 0 or 1'],
  ])('fails fast when a facilitator\'s /supported has %s on a Solana network', async (_case, options, problem) => {
    const lacking = await startFakeFacilitator(options);
    try {
      const document = await configWith(lacking.url);

      await expect(initializeX402({ config: document, facilitators: createFacilitators({ config: document, cdpApiKey: noCdpKey, facilitatorApiKey: facilitatorKey, clock }), timeoutMs: 2_000 }))
        .rejects.toThrow(`The cdp facilitator's /supported has ${problem} on ${solana}`);
    }
    finally {
      await lacking.close();
    }
  });

  it('fails fast when a facilitator\'s /supported fails', async () => {
    const down = await startFakeFacilitator({ networks: [base] });
    down.handle('/supported', facilitatorAnswers.unavailable);
    try {
      const broken = await configWith(down.url);

      await expect(initializeX402({ config: broken, facilitators: createFacilitators({ config: broken, cdpApiKey: noCdpKey, facilitatorApiKey: facilitatorKey, clock }), timeoutMs: 2_000 }))
        .rejects.toThrow('The cdp facilitator\'s /supported failed');
    }
    finally {
      await down.close();
    }
  });

  it('fails fast when a facilitator\'s /supported doesn\'t list exact on a network it is configured for', async () => {
    const baseOnly = await startFakeFacilitator({ networks: [base] });
    try {
      const both = await configWith(baseOnly.url);

      await expect(initializeX402({ config: both, facilitators: createFacilitators({ config: both, cdpApiKey: noCdpKey, facilitatorApiKey: facilitatorKey, clock }), timeoutMs: 2_000 }))
        .rejects.toThrow(`The cdp facilitator's /supported doesn't list exact on ${solana}`);
    }
    finally {
      await baseOnly.close();
    }
  });

  it('sends the api-key auth\'s secret in X-API-Key on every call, and never in an error', async () => {
    const keyed = await startFakeFacilitator({ networks: [near] });
    try {
      const withKey = await configWith(keyed.url, {
        facilitators: [
          { name: 'cdp', url: keyed.url, networks: [base, solana], enabled: false },
          { name: 'near', url: keyed.url, networks: [near], auth: { type: 'api-key', apiKey: 'FACILITATOR_SECRET' } },
        ],
      });
      const [client] = createFacilitators({ config: withKey, cdpApiKey: noCdpKey, facilitatorApiKey: auth => auth.apiKey === 'FACILITATOR_SECRET' ? Secret.from(testApiKey) : Secret.from('wrong'), clock });
      const requirements: PaymentRequirements = { scheme: 'exact', network: near, asset: 'token', amount: '1', payTo: 'pay.anyfare.testnet', maxTimeoutSeconds: 60, extra: {} };

      await client!.getSupported();
      await client!.verify({ x402Version: 2, accepted: requirements, payload: {} }, requirements);
      await client!.settle({ x402Version: 2, accepted: requirements, payload: {} }, requirements);

      expect(keyed.requests.map(request => [request.path, request.headers['x-api-key'], request.headers.authorization])).toEqual([
        ['/supported', testApiKey, undefined],
        ['/verify', testApiKey, undefined],
        ['/settle', testApiKey, undefined],
      ]);

      keyed.handle('/supported', () => ({ status: 401, body: { error: testApiKey } }));
      const failure = await client!.getSupported().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FacilitatorUnavailableError);
      expect(JSON.stringify(failure) + String((failure as Error).message)).not.toContain(testApiKey);
    }
    finally {
      await keyed.close();
    }
  });

  it('refuses to start a facilitator whose api-key reader is missing', async () => {
    const withKey = await configWith('http://127.0.0.1:1');

    expect(() => createFacilitators({ config: withKey, cdpApiKey: noCdpKey, clock })).toThrow(/uses an API key \(FACILITATOR_SECRET\)/);
  });

  it.each([
    ['Ed25519', 'EdDSA'],
    ['P-256', 'ES256'],
  ])('signs every request with a CDP JWT naming its method and path, with an %s key', async (kind, alg) => {
    const pair = kind === 'Ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const secret = kind === 'Ed25519'
      ? Buffer.concat([
        Buffer.from(pair.privateKey.export({ format: 'jwk' }).d!, 'base64url'),
        Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url'),
      ]).toString('base64')
      : pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().replaceAll('\n', '\\n');
    const signed = await startFakeFacilitator({ networks: [base] });
    try {
      const withAuth = await configWith(signed.url, {
        facilitators: [
          { name: 'cdp', url: signed.url, networks: [base, solana], auth: { type: 'cdp', apiKeyId: 'CDP_API_KEY_ID', apiKeySecret: 'CDP_API_KEY_SECRET' } },
        ],
      });
      const [client] = createFacilitators({ config: withAuth, cdpApiKey: () => ({ id: Secret.from('organizations/test/apiKeys/key-1'), secret: Secret.from(secret) }), clock });

      await client!.getSupported();

      const token = String(signed.requests[0]!.headers.authorization).replace(/^Bearer /, '');
      const [header, claims, signature] = token.split('.') as [string, string, string];
      const { publicKey } = pair;
      const valid = alg === 'EdDSA'
        ? verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))
        : verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
      expect(valid).toBe(true);
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg, kid: 'organizations/test/apiKeys/key-1', typ: 'JWT', nonce: expect.stringMatching(/^[0-9a-f]{32}$/) });
      const payload = JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>;
      expect(payload).toEqual({
        sub: 'organizations/test/apiKeys/key-1', iss: 'cdp', uris: [`GET ${new URL(signed.url).host}/supported`],
        iat: expect.any(Number), nbf: expect.any(Number), exp: (payload['iat'] as number) + 120,
      });
    }
    finally {
      await signed.close();
    }
  });
});
