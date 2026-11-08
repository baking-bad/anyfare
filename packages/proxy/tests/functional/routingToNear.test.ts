import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, systemClock, type Clock, type MicroUsd, type Server,
} from '@anyfare/common';
import { findAsset, generateApiKey, hashApiKey, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createAccountRepository, createLedger, createPaymentKeyRepository, payments, signatures, targetPayments, type Database } from '@anyfare/db';
import { createApp as createFacilitator } from '@anyfare/facilitator';
import { createFacilitators, initializeX402, type X402Setup } from '@anyfare/payments';
import { createApp as createSigner, createRedisNearPayerStore, nearKeyPrefix, type NearPayerStore } from '@anyfare/signer';
import {
  createFakeResolver, createTestDatabase, createTestRedis, encodeBase58, generateNearKey, nearFacilitatorOff, startFakeFacilitator, startFakeNearRpc,
  startFakeUpstream, type FakeFacilitator, type FakeNearRpc, type FakeUpstream, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp, type ProxyDependencies, type ProxyServer } from '../../src/app.js';
import { createSignerClient, type SignerClient } from '../../src/routing/support.js';

// A routed call to a target that takes USDC on NEAR. The buyer pays us with a key or with x402 on Base;
// the real Signer pays the target from the NEAR hot wallet with a signed delegate action; the target
// verifies and settles it through a facilitator of its own, our facilitator app with its own relayer,
// against a fake NEAR node, and answers. Every account and key is made up here.

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const near = 'near:testnet';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const targetFacilitatorSecret = 'target-facilitator-secret-0123456789abcdef';
const targetHost = 'evidence.target.test';
const evidencePath = '/v1/evidence/account';
// Our NEAR hot wallet, which is also the account buyers pay on NEAR, as in production
const hotWallet = 'pay.anyfare.testnet';
const hotKey = generateNearKey();
// The target's account, and its facilitator's relayer
const merchant = 'count.merchant.testnet';
const merchantRelayer = 'relay.merchant.testnet';
const merchantRelayerKey = generateNearKey();
// The bodies the fake target treats apart: it holds the paid retry, breaks the connection, or refuses our payment
const gatedAccount = 'gated.testnet';
const resetAccount = 'reset.testnet';
const refusingAccount = 'refusing.testnet';
const generous = { requests: 100_000, windowSeconds: 60 };

let database: TestDatabase;
let redis: TestRedis;
let rpc: FakeNearRpc;
let front: Awaited<ReturnType<typeof startRpcFront>>;
let target: FakeUpstream;
let cdp: FakeFacilitator;
let config: PlatformConfig;
let usdc: string;
let targetFacilitator: Server;
let targetFacilitatorClient: HTTPFacilitatorClient;
let signer: Server;
let signerUrl: string;
let http: OutboundHttp;
let x402: X402Setup;
let proxy: ProxyServer;
let proxyUrl: string;
let metricsUrl: string;
// Each line the proxy, the Signer, and the target's facilitator write
const lines: Record<string, unknown>[] = [];
const loggerFor = (name: string) => createLogger({ name, level: 'debug' }, {
  write: (line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  },
});
// The paid retries the target received, with our PAYMENT-SIGNATURE
const paidRetries: { readonly requestId: string; readonly accountId: string | undefined; readonly header: string }[] = [];
// Paid retries the target holds until the test lets them go on, by request ID
const gates = new Map<string, () => void>();

/** The target's one option: 0.001 USDC on NEAR testnet to its account, as the demo target asks it. */
const nearOption = (): PaymentRequirements => ({
  scheme: 'exact', network: near, amount: '1000', asset: usdc, payTo: merchant, maxTimeoutSeconds: 300, extra: {},
} as PaymentRequirements);

const paymentRequired = (url: string): string => encodePaymentRequiredHeader({
  x402Version: 2,
  error: 'Payment required',
  resource: { url, description: 'Evidence about a NEAR account', mimeType: 'application/json' },
  accepts: [nearOption()],
  extensions: {
    bazaar: {
      info: { input: { type: 'http', method: 'POST', bodyType: 'json', body: { accountId: 'example.testnet' } } },
      schema: { type: 'object', properties: { input: { type: 'object' } } },
    },
  },
} as never);

/** The target's paid answer. */
const evidenceOf = (accountId: string | undefined) => ({
  accountId, checkedAt: '2026-11-09T08:15:00.000Z', evidence: [{ kind: 'account_created', at: '2026-11-08T21:04:00.000Z' }],
});

/**
 * The Signer's way to the fake node. While `delayMs` is set, each call waits that long before it goes
 * on; while `staleNonce` is set, `view_access_key` answers the hot wallet's key with that nonce, as a
 * node whose view lags behind the chain does.
 */
const startRpcFront = async (to: string) => {
  const state: { delayMs: number; staleNonce: bigint | undefined; staleAnswers: number } = { delayMs: 0, staleNonce: undefined, staleAnswers: 0 };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const { delayMs } = state;
        if (delayMs > 0)
          await sleep(delayMs);
        const answer = await fetch(to, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        let text = await answer.text();
        const call = JSON.parse(body) as { method?: string; params?: { request_type?: string; account_id?: string } };
        if (state.staleNonce !== undefined && call.method === 'query' && call.params?.request_type === 'view_access_key' && call.params.account_id === hotWallet) {
          const json = JSON.parse(text) as { result?: Record<string, unknown> };
          if (json.result) {
            json.result['nonce'] = Number(state.staleNonce);
            state.staleAnswers += 1;
          }
          text = JSON.stringify(json);
        }
        if (!response.destroyed)
          response.writeHead(answer.status, { 'content-type': 'application/json' }).end(text);
      })().catch(() => response.destroy());
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};

/** A buyer account with a payment key and $1 of credits, written as the Platform API writes them. */
const createBuyer = async (db: Database) => {
  const id = `acc_${randomUUID()}`;
  const keyId = `key_${randomUUID()}`;
  const createdAt = systemClock.now();
  await createAccountRepository({ db }).create({ id, createdAt });
  const key = generateApiKey('payment', config.keyPrefixes);
  await createPaymentKeyRepository({ db }).insert({
    id: keyId, accountId: id, keyHash: hashApiKey(key), label: undefined, createdAt, allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined,
    expiresAt: undefined,
  });
  await createLedger({ db, clock: systemClock, ids: randomIdGenerator }).credit({ accountId: id, amount: 1_000_000n as MicroUsd, reference: `credit-${id}` });

  return { id, key: key.expose() };
};

beforeAll(async () => {
  [database, redis, rpc, target, cdp] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeNearRpc(), startFakeUpstream({ hosts: [targetHost] }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
  ]);
  front = await startRpcFront(rpc.url);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        // A 10% routing fee, so the quote shows it
        routingFeeBps: 1000,
        rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous },
        // Buyers pay with a key, or with x402 on Base and Solana; nothing is offered to buyers on NEAR
        facilitators: [{ name: 'cdp', url: cdp.url, networks: [base, solana] }, nearFacilitatorOff],
        mpp: { enabled: false },
        signer: { maxPerCall: '0.5', maxPerNetworkPerDay: '100', wallets: { near: hotWallet } },
      })).toString('base64'),
    },
  });
  usdc = findAsset(config, 'near-usdc')!.address;

  // The chain: our hot wallet with 1 USDC, the target's account, and its facilitator's relayer
  rpc.addAccount({ accountId: hotWallet, publicKey: hotKey.publicKey });
  rpc.addAccount({ accountId: merchant });
  rpc.addAccount({ accountId: merchantRelayer, publicKey: merchantRelayerKey.publicKey });
  rpc.addToken({ contractId: usdc, balances: { [hotWallet]: 1_000_000n }, registered: [merchant] });

  // The target's facilitator: our facilitator app, taking payments to the target's account only.
  // Short deadlines: a second per read and per send, and a settle answers within its least wait, 5 s.
  const facilitatorConfig = await loadPlatformConfig({
    env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ timeouts: { connectMs: 1_000, settleMs: 1_500 } })).toString('base64') },
  });
  targetFacilitator = createFacilitator({
    config: facilitatorConfig, logger: loggerFor('target-facilitator'), secret: Secret.from(targetFacilitatorSecret),
    relayer: { accountId: merchantRelayer, secretKey: Secret.from(merchantRelayerKey.secretKey) }, recipients: [merchant], rpcUrls: { [near]: rpc.url }, pollMs: 200,
  });
  const facilitatorPorts = await targetFacilitator.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  const auth = { 'x-api-key': targetFacilitatorSecret };
  targetFacilitatorClient = new HTTPFacilitatorClient({
    url: `http://127.0.0.1:${facilitatorPorts.port}`, timeoutMs: 15_000, createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
  });

  // The target: the demo's evidence API. Paid, it has its facilitator verify and settle our payment, as
  // an x402 server does, and answers with the settlement in PAYMENT-RESPONSE.
  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    const url = `https://${targetHost}${path}`;
    const header = request.headers['payment-signature'];
    if (typeof header !== 'string') {
      response.writeHead(402, { 'payment-required': paymentRequired(url), 'content-type': 'application/json' }).end('{}');
      return;
    }
    const requestId = String(request.headers['x-request-id']);
    const accountId = (JSON.parse(request.body.toString('utf8') || '{}') as { accountId?: string }).accountId;
    paidRetries.push({ requestId, accountId, header });
    if (accountId === gatedAccount)
      await new Promise<void>(resolve => gates.set(requestId, resolve));
    if (accountId === resetAccount) {
      response.destroy();
      return;
    }
    if (accountId === refusingAccount) {
      response.writeHead(402, { 'payment-required': paymentRequired(url), 'content-type': 'application/json' }).end('{}');
      return;
    }
    const payload = decodePaymentSignatureHeader(header);
    const verified = await targetFacilitatorClient.verify(payload, nearOption());
    const settled = verified.isValid ? await targetFacilitatorClient.settle(payload, nearOption()) : undefined;
    if (!settled?.success) {
      response.writeHead(402, { 'payment-required': paymentRequired(url), 'content-type': 'application/json' })
        .end(JSON.stringify({ error: verified.invalidReason ?? settled?.errorReason ?? 'payment_failed' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'payment-response': encodePaymentResponseHeader(settled) }).end(JSON.stringify(evidenceOf(accountId)));
  });

  http = new OutboundHttp({
    ownHosts: config.ownHosts, resolver: createFakeResolver({ [targetHost]: '127.0.0.1' }), addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000,
  });
  // The real Signer, with the NEAR hot wallet only, reading the chain through the front
  signer = createSigner({
    config, logger: loggerFor('signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret),
    wallets: { near: { accountId: hotWallet, secretKey: Secret.from(hotKey.secretKey), rpcUrl: Secret.from(front.url) } },
  });
  signerUrl = `http://127.0.0.1:${(await signer.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
  x402 = await initializeX402({
    config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: systemClock }), timeoutMs: 5_000,
  });
  proxy = createApp({
    config, logger: loggerFor('proxy'), postgres: database.postgres, redis, http, x402,
    signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
  });
  const ports = await proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  proxyUrl = `http://127.0.0.1:${ports.port}`;
  metricsUrl = `http://127.0.0.1:${ports.metricsPort}/metrics`;
});

afterAll(async () => {
  for (const open of gates.values())
    open();
  await Promise.all([proxy?.close(), signer?.close()]);
  await targetFacilitator?.close();
  await Promise.all([http?.close(), target?.close(), cdp?.close(), front?.close(), rpc?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// The fake target listens on a port of its own: links name it, as /<host>:<port>/… allows
const link = (at = proxyUrl): string => `${at}/${targetHost}:${target.port}${evidencePath}`;
const call = (accountId: string, headers: Record<string, string> = {}, at = proxyUrl): Promise<Response> =>
  fetch(link(at), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ accountId }) });
const buyer = () => createBuyer(database.db);
const balance = async (accountId: string): Promise<bigint> => (await createLedger({ db: database.db, clock: systemClock, ids: randomIdGenerator }).balance(accountId)).available;
const rowOf = async (requestId: string) => (await database.db.select().from(payments).where(eq(payments.requestId, requestId)))[0];
const legOf = async (paymentId: string) => (await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, paymentId)))[0];
const signaturesOf = (quoteId: string) => database.db.select().from(signatures).where(eq(signatures.quoteId, quoteId));
const errorOf = async (response: Response) => [response.status, (await response.json() as { error: { code: string } }).error.code];
const lineOf = (requestId: string, msg: string) => lines.find(line => line['requestId'] === requestId && line['msg'] === msg);
// The hot wallet's transactions on the fake chain, and its lease in the Signer's Redis
const ours = () => rpc.transactions.filter(transaction => transaction.delegate.senderId === hotWallet);
const leaseOf = () => redis.client.get(`${redis.prefix}${nearKeyPrefix}payer:${hotWallet}`);
const leaseIsFree = () => expect.poll(leaseOf, { timeout: 2_000 }).toBeNull();

/** An x402 payment of the proxy's Base option, signed by a new buyer wallet with the official client. */
const payOnBase = async (): Promise<string> => {
  const required = decodePaymentRequiredHeader((await call('example.testnet')).headers.get('payment-required')!);
  const client = new x402Client().register(base, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));

  return encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));
};

/** Another proxy, on the same database, target, and Signer, with some dependencies of its own. */
const withProxy = async (overrides: Partial<ProxyDependencies>, work: (url: string) => Promise<void>): Promise<void> => {
  const other = createApp({
    config, logger: loggerFor('other-proxy'), postgres: database.postgres, redis, http, x402,
    signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 }), ...overrides,
  });
  const { port } = await other.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  try {
    await work(`http://127.0.0.1:${port}`);
  }
  finally {
    await other.close();
  }
};

/** A paid call's NEAR leg: the transfer on the chain, and the leg recorded as settled with its transaction. */
const expectPaidOnNear = async (requestId: string, before: { readonly hot: bigint; readonly merchant: bigint; readonly transactions: number }) => {
  expect(ours()).toHaveLength(before.transactions + 1);
  const transaction = ours().at(-1)!;
  expect(transaction).toMatchObject({
    signerId: merchantRelayer, receiverId: hotWallet, status: 'success',
    delegate: { senderId: hotWallet, receiverId: usdc, transfer: { receiverId: merchant, amount: 1_000n } },
  });
  // 0.001 USDC from our hot wallet to the target's account
  expect(rpc.balanceOf(usdc, hotWallet)).toBe(before.hot - 1_000n);
  expect(rpc.balanceOf(usdc, merchant)).toBe(before.merchant + 1_000n);
  const row = (await rowOf(requestId))!;
  await expect.poll(async () => (await legOf(row.id))?.buyerCharged).toBe(true);
  const leg = await legOf(row.id);
  expect(leg).toMatchObject({
    protocol: 'x402', network: near, asset: 'near-usdc', amount: 1_000n, atomicAmount: 1_000n, payTo: merchant, status: 'settled', transactionHash: transaction.hash,
  });
  expect(decodePaymentResponseHeader(leg!.receipt!)).toEqual({ success: true, transaction: transaction.hash, network: near, payer: hotWallet });

  return { row, leg: leg!, transaction };
};

const chainNow = () => ({ hot: rpc.balanceOf(usdc, hotWallet), merchant: rpc.balanceOf(usdc, merchant), transactions: ours().length });

describe('a routed call to a target that takes USDC on NEAR', () => {
  it('is quoted like a Base-only target: the combined 402 offers every rail we take, and GET /_/check names NEAR', async () => {
    const unpaid = await call('example.testnet');
    const body = await unpaid.json() as { credits: { price: string } };
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    const checked = await (await fetch(`${proxyUrl}/_/check?url=${encodeURIComponent(`${targetHost}:${target.port}${evidencePath}`)}`)).json();

    expect(unpaid.status).toBe(402);
    expect(body.credits).toMatchObject({ price: '0.0011' });
    expect(required.accepts.map(option => [option.network, option.amount])).toEqual([[base, '1100'], [solana, '1100']]);
    expect(required.resource).toMatchObject({ url: `${config.urls.pay}/${targetHost}:${target.port}${evidencePath}` });
    expect(checked).toMatchObject({
      payable: true, price: { amount: '0.001', asset: 'near-usdc', network: near }, quote: { amount: '0.0011', fee: '0.0001', currency: 'USD' },
    });
    expect(lines.find(line => line['msg'] === 'Routing quote' && line['network'] === near)).toMatchObject({ protocol: 'x402', price: '0.001', quote: '0.0011' });
  });

  it('pays the target from the hot wallet for a buyer with a key: the target\'s answer, its settlement on NEAR, and the quote charged', async () => {
    const paying = await buyer();
    const requestId = `near-key-${randomUUID()}`;
    const before = chainNow();

    const response = await call('alice.testnet', { authorization: `Bearer ${paying.key}`, 'x-request-id': requestId });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(evidenceOf('alice.testnet'));
    const { row, leg } = await expectPaidOnNear(requestId, before);
    await expect.poll(async () => (await rowOf(requestId))?.status).toBe('captured');
    expect(await rowOf(requestId)).toMatchObject({ rail: 'credits', amount: 1_100n, fee: 100n });
    expect(await balance(paying.id)).toBe(1_000_000n - 1_100n);
    // The Signer recorded what it signed, for this quote
    expect(await signaturesOf(row.id)).toEqual([expect.objectContaining({ id: leg.signatureId, network: near, asset: 'near-usdc', atomicAmount: 1_000n, payTo: merchant })]);
    await leaseIsFree();
  });

  it('pays the target for a buyer paying with x402 on Base, and settles the buyer before answering', async () => {
    const signature = await payOnBase();
    const requestId = `near-x402-${randomUUID()}`;
    const before = chainNow();

    const response = await call('bob.testnet', { 'payment-signature': signature, 'x-request-id': requestId });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(evidenceOf('bob.testnet'));
    expect(decodePaymentResponseHeader(response.headers.get('payment-response')!)).toMatchObject({ success: true, network: base });
    const { row } = await expectPaidOnNear(requestId, before);
    expect(row).toMatchObject({ rail: 'x402', status: 'settled', network: base, asset: 'base-usdc', amount: 1_100n, fee: 100n });
    await leaseIsFree();
  });

  it('settles two calls back to back, the second with a higher nonce, though the node\'s view of the key lags', async () => {
    const paying = await buyer();
    const [firstId, secondId] = [`near-first-${randomUUID()}`, `near-second-${randomUUID()}`];
    const before = chainNow();
    // From here on, the Signer's node answers the key's nonce as it was before either payment
    front.state.staleNonce = rpc.nonceOf(hotWallet, hotKey.publicKey);
    front.state.staleAnswers = 0;
    try {
      const first = await call('carol.testnet', { authorization: `Bearer ${paying.key}`, 'x-request-id': firstId });
      expect(first.status).toBe(200);
      await leaseIsFree();
      const second = await call('dave.testnet', { authorization: `Bearer ${paying.key}`, 'x-request-id': secondId });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(evidenceOf('dave.testnet'));
    }
    finally {
      front.state.staleNonce = undefined;
    }

    expect(front.state.staleAnswers).toBe(2);
    const [first, second] = ours().slice(before.transactions);
    expect([first?.status, second?.status]).toEqual(['success', 'success']);
    expect(second!.delegate.nonce).toBeGreaterThan(first!.delegate.nonce);
    expect(rpc.balanceOf(usdc, merchant)).toBe(before.merchant + 2_000n);
    for (const requestId of [firstId, secondId])
      await expect.poll(async () => (await legOf((await rowOf(requestId))!.id))?.status).toBe('settled');
    await leaseIsFree();
  });

  it('answers a second NEAR-paid call while the first is in flight with 503 and Retry-After, charges it nothing, and the first succeeds', async () => {
    const paying = await buyer();
    const waiting = await buyer();
    const [firstId, secondId, thirdId] = [`near-held-${randomUUID()}`, `near-busy-${randomUUID()}`, `near-after-${randomUUID()}`];
    const before = chainNow();
    const pending = call(gatedAccount, { authorization: `Bearer ${paying.key}`, 'x-request-id': firstId });
    await expect.poll(() => gates.has(firstId)).toBe(true);
    const firstRow = (await rowOf(firstId))!;
    expect(await leaseOf()).toBe(firstRow.id);

    const busy = await call('erin.testnet', { authorization: `Bearer ${waiting.key}`, 'x-request-id': secondId });

    expect(busy.headers.get('retry-after')).toBe('2');
    expect(await busy.json()).toEqual({ error: { code: 'payment_unavailable', message: 'A payment on NEAR is in flight: retry in a moment' } });
    expect(busy.status).toBe(503);
    const busyRow = (await rowOf(secondId))!;
    await expect.poll(async () => (await rowOf(secondId))?.status).toBe('released');
    expect(await balance(waiting.id)).toBe(1_000_000n);
    expect(await legOf(busyRow.id)).toBeUndefined();
    expect(paidRetries.some(item => item.requestId === secondId)).toBe(false);
    expect(lineOf(secondId, 'The Signer is paying another NEAR payment: nothing was paid, and the buyer may retry')).toMatchObject({
      level: 30, code: 'payer_busy', signer: { status: 409, code: 'payer_busy' },
    });
    expect(lines.some(line => line['requestId'] === secondId && line['msg'] === 'The Signer didn\'t sign a routed payment')).toBe(false);
    // The busy call's own release reached the Signer, and left the first payment's lease alone
    await expect.poll(() => lines.some(line => line['name'] === 'signer' && line['msg'] === 'Released a quote\'s NEAR lease' && line['quoteId'] === busyRow.id && line['released'] === false))
      .toBe(true);
    expect(await leaseOf()).toBe(firstRow.id);
    expect(await (await fetch(metricsUrl)).text()).toMatch(/proxy_routing_total\{outcome="signer_busy"\} 1\n/);

    gates.get(firstId)!();
    const first = await pending;
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(evidenceOf(gatedAccount));
    await expectPaidOnNear(firstId, before);
    await leaseIsFree();
    const third = await call('frank.testnet', { authorization: `Bearer ${waiting.key}`, 'x-request-id': thirdId });
    expect(third.status).toBe(200);
    await leaseIsFree();
  });

  it('releases the lease when the paid retry breaks off, charges nothing, and the next call signs at once', async () => {
    const paying = await buyer();
    const requestId = `near-reset-${randomUUID()}`;
    const before = chainNow();

    const response = await call(resetAccount, { authorization: `Bearer ${paying.key}`, 'x-request-id': requestId });

    expect(await errorOf(response)).toEqual([503, 'upstream_unavailable']);
    expect(paidRetries.some(item => item.requestId === requestId)).toBe(true);
    await expect.poll(async () => (await rowOf(requestId))?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(await legOf((await rowOf(requestId))!.id)).toMatchObject({ status: 'unknown' });
    expect(chainNow()).toEqual(before);
    await leaseIsFree();
    expect((await call('grace.testnet', { authorization: `Bearer ${paying.key}` })).status).toBe(200);
  });

  it('releases the lease when the target refuses our payment with another 402, and charges nothing', async () => {
    const paying = await buyer();
    const requestId = `near-refused-${randomUUID()}`;
    const before = chainNow();

    const response = await call(refusingAccount, { authorization: `Bearer ${paying.key}`, 'x-request-id': requestId });

    expect(await errorOf(response)).toEqual([503, 'upstream_unavailable']);
    await expect.poll(async () => (await rowOf(requestId))?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(await legOf((await rowOf(requestId))!.id)).toMatchObject({ status: 'failed' });
    expect(lineOf(requestId, 'The routed target refused our payment on the paid retry')).toMatchObject({ targetStatus: 402, targetLeg: 'failed' });
    expect(chainNow()).toEqual(before);
    await leaseIsFree();
    expect((await call('heidi.testnet', { authorization: `Bearer ${paying.key}` })).status).toBe(200);
  });

  it('frees the lease the Signer took after the proxy gave up on it: the buyer pays nothing, and the next call signs at once', async () => {
    const paying = await buyer();
    const requestId = `near-late-${randomUUID()}`;
    const before = chainNow();
    let response: Response | undefined;
    // The Signer's reads take 1.2 s, well within its own budget, and the proxy waits 400 ms for it
    front.state.delayMs = 1_200;
    try {
      await withProxy({ signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 400 }) }, async url => {
        response = await call('ivan.testnet', { authorization: `Bearer ${paying.key}`, 'x-request-id': requestId }, url);
      });
    }
    finally {
      front.state.delayMs = 0;
    }

    expect(await errorOf(response!)).toEqual([503, 'upstream_unavailable']);
    const row = (await rowOf(requestId))!;
    expect(row.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(await legOf(row.id)).toBeUndefined();
    expect(lineOf(requestId, 'The Signer didn\'t sign a routed payment')).toMatchObject({ level: 40 });
    // The Signer signed once its reads came back, after the proxy had released the quote: its lease stays free
    await expect.poll(async () => (await signaturesOf(row.id)).length, { timeout: 5_000 }).toBe(1);
    expect(await leaseOf()).toBeNull();
    expect(paidRetries.some(item => item.requestId === requestId)).toBe(false);
    expect(chainNow()).toEqual(before);
    const started = performance.now();
    expect((await call('judy.testnet', { authorization: `Bearer ${paying.key}` })).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(5_000);
    await leaseIsFree();
  });

  it('refuses to sign a quote the proxy released before the Signer took the lease: the lease stays free, and the next call signs at once', async () => {
    // A Signer replica on the same Redis that takes the lease a second late, and a proxy that waits 400 ms for it
    const store = createRedisNearPayerStore({ redis });
    const slowStore: NearPayerStore = {
      ...store,
      takeLease: async (lease, lifetimeMs) => {
        await sleep(1_000);

        return store.takeLease(lease, lifetimeMs);
      },
    };
    const slowSigner = createSigner({
      config, logger: loggerFor('slow-signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret), nearStore: slowStore,
      wallets: { near: { accountId: hotWallet, secretKey: Secret.from(hotKey.secretKey), rpcUrl: Secret.from(front.url) } },
    });
    const slowUrl = `http://127.0.0.1:${(await slowSigner.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
    const paying = await buyer();
    const requestId = `near-abandoned-${randomUUID()}`;
    const before = chainNow();
    let response: Response | undefined;
    try {
      await withProxy({ signer: createSignerClient({ url: slowUrl, secret: Secret.from(signerSecret), timeoutMs: 400 }) }, async url => {
        response = await call('mallory.testnet', { authorization: `Bearer ${paying.key}`, 'x-request-id': requestId }, url);
      });
      const row = (await rowOf(requestId))!;
      // The release came first, and freed nothing; the sign that came after took nothing, and was refused
      await expect.poll(() => lines.find(line => line['name'] === 'slow-signer' && line['msg'] === 'Refused to sign a routed payment' && line['quoteId'] === row.id), { timeout: 5_000 })
        .toMatchObject({ result: 'refused', reason: 'quote_released' });
      expect(lines.find(line => line['name'] === 'slow-signer' && line['msg'] === 'Released a quote\'s NEAR lease' && line['quoteId'] === row.id)).toMatchObject({ released: false });
    }
    finally {
      // A connection the client opened and sent no request on would hold the close for its keep-alive timeout
      slowSigner.app.server.closeAllConnections();
      await slowSigner.close();
    }

    expect(await errorOf(response!)).toEqual([503, 'upstream_unavailable']);
    const row = (await rowOf(requestId))!;
    expect(row.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(await signaturesOf(row.id)).toEqual([]);
    expect(await leaseOf()).toBeNull();
    expect(chainNow()).toEqual(before);
    const started = performance.now();
    expect((await call('niaj.testnet', { authorization: `Bearer ${paying.key}` })).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(5_000);
    await leaseIsFree();
  });

  it('releases the lease when the buyer\'s payment expires too soon to call the target, and sends the target nothing', async () => {
    // The proxy's clock moves an hour on once the Signer has signed, as if signing had taken that long
    let offsetMs = 0;
    const shifting: Clock = { now: () => new Date(systemClock.now().getTime() + offsetMs) };
    const client = createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 });
    const releases: string[] = [];
    const slowToSign: SignerClient = {
      sign: async input => {
        const signed = await client.sign(input);
        offsetMs = 60 * 60_000;

        return signed;
      },
      release: async (quoteId, context) => {
        releases.push(quoteId);
        await client.release(quoteId, context);
      },
    };
    const signature = await payOnBase();
    const requestId = `near-expiring-${randomUUID()}`;
    const before = chainNow();
    let response: Response | undefined;

    await withProxy({ signer: slowToSign, clock: shifting }, async url => {
      response = await call('olivia.testnet', { 'payment-signature': signature, 'x-request-id': requestId }, url);
    });

    expect(await errorOf(response!)).toEqual([503, 'upstream_unavailable']);
    expect(lineOf(requestId, 'The buyer\'s payment expires too soon to call the target: nothing was sent')).toMatchObject({ reason: 'payment_expiring', targetLeg: 'failed' });
    const row = (await rowOf(requestId))!;
    expect(row).toMatchObject({ rail: 'x402', status: 'cancelled' });
    expect(await legOf(row.id)).toMatchObject({ status: 'failed' });
    expect(releases).toEqual([row.id]);
    expect(paidRetries.some(item => item.requestId === requestId)).toBe(false);
    expect(chainNow()).toEqual(before);
    await leaseIsFree();
  });

  it('writes the signature ID on a NEAR-paid call\'s lines, and never the signed payment or a key', () => {
    const paid = lines.filter(line => line['msg'] === 'Routed call answered' && line['network'] === near && line['targetStatus'] === 200);
    const logged = JSON.stringify(lines);

    expect(paid.length).toBeGreaterThan(5);
    for (const line of paid)
      expect(line['signatureId']).toMatch(/^sig_/);
    expect(lines.filter(line => line['name'] === 'signer' && line['msg'] === 'Signed a routed payment' && line['network'] === near).length).toBeGreaterThan(5);
    expect(paidRetries.length).toBeGreaterThan(5);
    for (const { header } of paidRetries) {
      expect(logged).not.toContain(header);
      const signed = String((decodePaymentSignatureHeader(header).payload as { signedDelegateAction: string }).signedDelegateAction);
      expect(logged).not.toContain(signed.slice(0, 48));
    }
    for (const secret of [hotKey.secretKey.slice('ed25519:'.length), merchantRelayerKey.secretKey.slice('ed25519:'.length), signerSecret, targetFacilitatorSecret])
      expect(logged).not.toContain(secret);
  });
});
