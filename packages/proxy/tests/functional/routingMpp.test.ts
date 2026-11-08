import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { eq } from 'drizzle-orm';
import { Challenge, Credential, Receipt, Store } from 'mppx';
import { Mppx, tempo } from 'mppx/server';
import { createClient, http as viemHttp } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { Transaction } from 'viem/tempo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, systemClock, type Clock, type MicroUsd, type Server } from '@anyfare/common';
import { findAsset, generateApiKey, hashApiKey, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import {
  createAccountRepository, createLedger, createPaymentKeyRepository, createRedisReplayStore, ledgerAccountIds, payments, signatures, targetPayments,
  type Database, type RedisReplayStore,
} from '@anyfare/db';
import { createFacilitators, initializeMpp, initializeX402, type MppSetup, type X402Setup } from '@anyfare/payments';
import { createApp as createSigner } from '@anyfare/signer';
import {
  createFakeResolver, nearFacilitatorOff, createTestDatabase, createTestRedis, createTestTempoPayer, encodeBase58, startFakeFacilitator, startFakeTempoRpc, startFakeUpstream,
  type FakeFacilitator, type FakeTempoRpc, type FakeUpstream, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp, type ProxyServer } from '../../src/app.js';
import { settleMarginMs } from '../../src/routing/routes.js';
import { createSignerClient, type SignerClient } from '../../src/routing/support.js';

// Payment routing pays MPP targets on Tempo, and buyers pay a routed call with any rail, MPP included
const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const tempoNetwork = 'eip155:42431';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const mppSecretKey = 'mpp-secret-key-for-the-routing-tests!!';
const targetSecretKey = 'the-target-s-own-mpp-secret-key-000000';
const targetHost = 'mpp.target.test';
// Made-up addresses: the target's on Tempo, and on Base
const targetRecipient = '0x5555555555555555555555555555555555555555';
const targetPayTo = '0x6666666666666666666666666666666666666666';
const generous = { requests: 100_000, windowSeconds: 60 };

/** A buyer account with a payment key and $1 of credits, written as the Platform API writes them. */
const createBuyer = async (db: Database, platform: PlatformConfig, credit: MicroUsd = 1_000_000n) => {
  const id = `acc_${randomUUID()}`;
  const createdAt = systemClock.now();
  await createAccountRepository({ db }).create({ id, createdAt });
  const key = generateApiKey('payment', platform.keyPrefixes);
  await createPaymentKeyRepository({ db }).insert({
    id: `key_${randomUUID()}`, accountId: id, keyHash: hashApiKey(key), label: undefined, createdAt, allowance: undefined, dailyBudget: 5_000_000n,
    maxPrice: undefined, expiresAt: undefined,
  });
  await createLedger({ db, clock: systemClock, ids: randomIdGenerator }).credit({ accountId: id, amount: credit, reference: `credit-${id}` });

  return { id, key: key.expose() };
};

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let target: FakeUpstream;
let rpc: FakeTempoRpc;
let facilitator: FakeFacilitator;
let store: RedisReplayStore;
let http: OutboundHttp;
let signer: Server;
let baseOnlySigner: Server;
let proxy: ProxyServer;
let noTempoProxy: ProxyServer;
let deadlineProxy: ProxyServer;
let proxyUrl: string;
let noTempoUrl: string;
let deadlineUrl: string;
let pathUsd: string;
let usdc: string;
const signerKey = generatePrivateKey();
const signerWallet = privateKeyToAccount(signerKey);
// Every Authorization and PAYMENT-SIGNATURE the target received: none may reach a log
const received: string[] = [];
// What the target was paid, by path: MPP receipts it issued, and x402 payments
const paid: { path: string; protocol: 'mpp' | 'x402'; amount: string }[] = [];
// The MPP credentials buyers paid us with: none may reach a log or the target
const buyerCredentials: string[] = [];
const lines: Record<string, unknown>[] = [];
const loggerFor = (name: string) => createLogger({ name, level: 'debug' }, {
  write: (line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  },
});

// The deadline proxy's clock: real time, moved on by `shiftOnSign` each time its Signer signs, as if
// signing had taken that long
let offsetMs = 0;
let shiftOnSign = 0;
const shiftingClock: Clock = { now: () => new Date(systemClock.now().getTime() + offsetMs) };
const shiftingAfterSigning = (client: SignerClient): SignerClient => ({
  sign: async input => {
    const signed = await client.sign(input);
    offsetMs += shiftOnSign;

    return signed;
  },
  release: (quoteId, context) => client.release(quoteId, context),
});

/** The target's MPP server: `mppx`'s Tempo charge in pull mode, checked against the fake Tempo RPC. */
const targetMpp = () => {
  const server = Mppx.create({
    methods: [tempo.charge({
      currencies: [pathUsd as `0x${string}`], decimals: 6, recipient: targetRecipient, chainId: tempoModerato.id, store: Store.memory(),
      getClient: () => createClient({ chain: tempoModerato, transport: viemHttp(rpc.url, { retryCount: 0 }) }), supportedModes: ['pull'], sponsorBudget: false,
      waitForConfirmation: true,
    })],
    secretKey: targetSecretKey,
    realm: targetHost,
  });
  const challenges = server.challenge as unknown as { tempo: { charge: (options: Record<string, unknown>) => Promise<Challenge.Challenge> } };
  const request = (amount: string) => ({ amount, currency: pathUsd, decimals: 6, recipient: targetRecipient, chainId: tempoModerato.id, supportedModes: ['pull'] });

  return {
    challenge: async (amount: string, scope: string) => Challenge.serialize(await challenges.tempo.charge({ ...request(amount), description: 'Pools', scope })),
    // Validates the credential, broadcasts its transaction, and waits for its receipt
    settle: async (credential: string, amount: string, scope: string) => Receipt.serialize(await server.broadcastCredential(credential, { request: request(amount), scope })),
  };
};

/** A Tempo charge `mppx`'s server would never make: one of the kinds routing refuses. */
const handMade = (details: Record<string, unknown>, request: Record<string, unknown> = {}) => Challenge.serialize(Challenge.from({
  id: 'hand-made', realm: targetHost, method: 'tempo', intent: 'charge', expires: new Date(systemClock.now().getTime() + 5 * 60_000).toISOString(),
  request: { amount: '1000', currency: pathUsd, recipient: targetRecipient, methodDetails: { chainId: tempoModerato.id, supportedModes: ['pull'], ...details }, ...request },
} as never));

const x402Option = (amount: string): PaymentRequirements => ({
  scheme: 'exact', network: base, amount, asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
} as PaymentRequirements);

beforeAll(async () => {
  [database, redis, target, rpc, facilitator] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: [targetHost] }), startFakeTempoRpc(),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        routingFeeBps: 0,
        rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous },
        facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff],
        signer: { maxPerCall: '0.05', maxPerNetworkPerDay: '100' },
      })).toString('base64'),
    },
  });
  pathUsd = findAsset(config, 'tempo-pathusd')!.address;
  usdc = findAsset(config, 'base-usdc')!.address;
  const mpp = targetMpp();

  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    const scope = `https://${targetHost}${path}`;
    const amount = path === '/v1/expensive' ? '0.06' : path === '/v1/tie' ? '0.002' : '0.001';
    const authorization = request.headers['authorization'];
    const signature = request.headers['payment-signature'];
    if (typeof authorization === 'string' || typeof signature === 'string')
      received.push(String(authorization ?? signature));

    // x402 on Base beside MPP: at the same price, or dearer than MPP
    if ((path === '/v1/tie' || path === '/v1/cheaper') && typeof signature === 'string') {
      const payload = decodePaymentSignatureHeader(signature) as unknown as { payload: { authorization: { value: string } } };
      paid.push({ path, protocol: 'x402', amount: payload.payload.authorization.value });
      const settled = encodePaymentResponseHeader({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: base, payer: signerWallet.address } as never);
      response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled }).end(JSON.stringify({ path, paidWith: 'x402' }));
      return;
    }
    if (typeof authorization !== 'string') {
      const refused: Readonly<Record<string, string>> = {
        '/v1/push-only': handMade({ supportedModes: ['push'] }),
        '/v1/splits': handMade({ splits: [{ amount: '100', recipient: targetPayTo }] }),
        '/v1/currency': handMade({}, { currency: '0x20c0000000000000000000000000000000000001' }),
        '/v1/chain': handMade({ chainId: 4_217 }),
      };
      const headers: Record<string, string> = { 'content-type': 'application/json', 'www-authenticate': refused[path] ?? await mpp.challenge(amount, scope) };
      if (path === '/v1/tie' || path === '/v1/cheaper')
        headers['payment-required'] = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: scope }, accepts: [x402Option('2000')] } as never);
      response.writeHead(402, headers).end('{}');
      return;
    }
    // Takes longer than the buyer's payment can wait, and broadcasts nothing
    if (path === '/v1/slow') {
      await sleep(3_000);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"slow":true}');
      return;
    }
    // Asks more on the paid retry, and broadcasts nothing
    if (path === '/v1/pricier') {
      response.writeHead(402, { 'www-authenticate': await mpp.challenge('0.002', scope) }).end('{}');
      return;
    }
    let receipt: string;
    try {
      receipt = await mpp.settle(authorization, amount, scope);
    }
    catch {
      response.writeHead(402, { 'www-authenticate': await mpp.challenge(amount, scope) }).end('{}');
      return;
    }
    paid.push({ path, protocol: 'mpp', amount });
    // A failure that keeps our payment
    if (path === '/v1/broken') {
      response.writeHead(500, { 'payment-receipt': receipt }).end('{"error":"boom"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'payment-receipt': receipt, 'cache-control': 'public, max-age=60' })
      .end(JSON.stringify({ path, paidWith: 'mpp' }));
  });

  http = new OutboundHttp({
    ownHosts: config.ownHosts, resolver: createFakeResolver({ [targetHost]: '127.0.0.1' }), addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000,
  });
  store = createRedisReplayStore({ redis });
  // One key for Base and Tempo; and a Signer without a Tempo wallet
  signer = createSigner({
    config, logger: loggerFor('signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet, tempo: signerWallet }, tempoRpcUrl: rpc.url,
  });
  baseOnlySigner = createSigner({ config, logger: loggerFor('signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet } });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [signerPorts, baseOnlyPorts] = await Promise.all([signer.listen(listen), baseOnlySigner.listen(listen)]);
  const x402: X402Setup = await initializeX402({
    config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: systemClock }), timeoutMs: 5_000,
  });
  const mppSetup: MppSetup = await initializeMpp({ config, secretKey: Secret.from(mppSecretKey), store, timeoutMs: 5_000, rpcUrl: rpc.url });
  const signerAt = (port: number) => createSignerClient({ url: `http://127.0.0.1:${port}`, secret: Secret.from(signerSecret), timeoutMs: 5_000 });
  const proxyFor = (client: SignerClient, clock: Clock = systemClock) => createApp({
    config, logger: loggerFor('proxy'), postgres: database.postgres, redis, http, x402, mpp: mppSetup, claims: store, signer: client, clock,
  });
  proxy = proxyFor(signerAt(signerPorts.port));
  noTempoProxy = proxyFor(signerAt(baseOnlyPorts.port));
  deadlineProxy = proxyFor(shiftingAfterSigning(signerAt(signerPorts.port)), shiftingClock);
  const [proxyPorts, noTempoPorts, deadlinePorts] = await Promise.all([proxy.listen(listen), noTempoProxy.listen(listen), deadlineProxy.listen(listen)]);
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  noTempoUrl = `http://127.0.0.1:${noTempoPorts.port}`;
  deadlineUrl = `http://127.0.0.1:${deadlinePorts.port}`;
});

afterAll(async () => {
  await Promise.all([proxy?.close(), noTempoProxy?.close(), deadlineProxy?.close(), signer?.close(), baseOnlySigner?.close()]);
  await Promise.all([http?.close(), target?.close(), rpc?.close(), facilitator?.close(), store?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// The fake target listens on a port of its own: links name it, as /<host>:<port>/… allows
const link = (path: string, at = proxyUrl): string => `${at}/${targetHost}:${target.port}${path}`;
const ledger = () => createLedger({ db: database.db, clock: systemClock, ids: randomIdGenerator });
const buyer = () => createBuyer(database.db, config);
const balance = async (accountId: string): Promise<bigint> => (await ledger().balance(accountId)).available;
const legOf = async (targetPath: string) => {
  const [buyerLeg] = await database.db.select().from(payments).where(eq(payments.targetPath, targetPath));
  const [targetLeg] = buyerLeg ? await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, buyerLeg.id)) : [];

  return { buyerLeg, targetLeg };
};
const routingLossesBalance = async (): Promise<bigint> => (await ledger().balancesOf([ledgerAccountIds.routingLosses])).get(ledgerAccountIds.routingLosses) ?? 0n;
const challengeOf = async (path: string, at = proxyUrl): Promise<{ readonly response: Response; readonly required: PaymentRequired }> => {
  const response = await fetch(link(path, at));

  return { response, required: decodePaymentRequiredHeader(response.headers.get('payment-required')!) };
};
const lineOf = (requestId: string, msg: string, app = 'proxy') => lines.find(line => line['requestId'] === requestId && line['name'] === app && line['msg'] === msg);

/** An MPP buyer's credential for the link's 402, signed by a new Tempo wallet with `mppx`'s client. */
const mppCredential = async (path: string, at = proxyUrl): Promise<string> => {
  const credential = await createTestTempoPayer({ rpcUrl: rpc.url }).credentialFor(await fetch(link(path, at)));
  buyerCredentials.push(credential);

  return credential;
};

describe('payment routing pays MPP targets on Tempo', () => {
  it('pays an MPP target in pull mode for a payment key: the Signer signs the target\'s challenge, the target broadcasts it, and target_payments keeps the receipt', async () => {
    const paying = await buyer();

    const response = await fetch(link('/v1/pools'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: '/v1/pools', paidWith: 'mpp' });
    // Our receipt, never the target's
    expect(response.headers.get('anyfare-receipt')).toContain('amount="0.001"');
    expect(response.headers.get('payment-receipt')).toBeNull();
    expect(paid.at(-1)).toEqual({ path: '/v1/pools', protocol: 'mpp', amount: '0.001' });
    expect(await balance(paying.id)).toBe(1_000_000n - 1_000n);
    // The target got our credential, never the buyer's key
    expect(received.at(-1)).toMatch(/^Payment /);
    expect(received.some(value => value.includes(paying.key))).toBe(false);
    // The credential answers the very challenge the target sent
    const [probe] = target.requests.filter(request => request.path === '/v1/pools' && request.headers['authorization'] === undefined);
    expect(probe).toBeDefined();
    expect(Credential.deserialize(received.at(-1)!).challenge).toMatchObject({ realm: targetHost, method: 'tempo', intent: 'charge' });
    const { buyerLeg, targetLeg } = await legOf('/v1/pools');
    expect(buyerLeg).toMatchObject({ rail: 'credits', amount: 1_000n });
    expect(targetLeg).toMatchObject({
      protocol: 'mpp', network: tempoNetwork, asset: 'tempo-pathusd', amount: 1_000n, atomicAmount: 1_000n, payTo: targetRecipient, status: 'settled',
      receipt: expect.any(String), transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(Receipt.deserialize(targetLeg!.receipt!)).toMatchObject({ method: 'tempo', status: 'success', reference: targetLeg!.transactionHash });
    // The Tempo node got the Signer's transaction, broadcast by the target
    expect(rpc.transactions.map(hash => hash.toLowerCase())).toContain(targetLeg!.transactionHash);
    const [signature] = await database.db.select().from(signatures).where(eq(signatures.id, targetLeg!.signatureId));
    expect(signature).toMatchObject({ protocol: 'mpp', network: tempoNetwork, asset: 'tempo-pathusd', atomicAmount: 1_000n, payTo: targetRecipient, quoteId: buyerLeg!.id });
    await expect.poll(async () => (await legOf('/v1/pools')).buyerLeg?.status).toBe('captured');
  });

  it('is paid by an x402 buyer on Base, and by an MPP buyer on Tempo', async () => {
    const { response, required } = await challengeOf('/v1/x402-buyer');
    expect(response.status).toBe(402);
    // The combined 402 at the quote: x402 on Base and Solana, and MPP
    expect(required.accepts.map(option => option.network)).toEqual([base, solana]);
    expect(response.headers.get('www-authenticate')).toMatch(/^Payment /);
    const client = new x402Client().register(base, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
    const signed = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));

    const viaX402 = await fetch(link('/v1/x402-buyer'), { headers: { 'payment-signature': signed } });

    expect(viaX402.status).toBe(200);
    expect(viaX402.headers.get('payment-response')).not.toBeNull();
    expect(await legOf('/v1/x402-buyer')).toMatchObject({ buyerLeg: { rail: 'x402', status: 'settled', amount: 1_000n }, targetLeg: { protocol: 'mpp', status: 'settled' } });

    const credential = await mppCredential('/v1/mpp-buyer');
    const viaMpp = await fetch(link('/v1/mpp-buyer'), { headers: { authorization: credential } });

    expect(viaMpp.status).toBe(200);
    expect(await viaMpp.json()).toEqual({ path: '/v1/mpp-buyer', paidWith: 'mpp' });
    // Our Payment-Receipt for the buyer's payment, private: one buyer's paid answer is never another's
    expect(Receipt.deserialize(viaMpp.headers.get('payment-receipt')!)).toMatchObject({ method: 'tempo', status: 'success' });
    expect(viaMpp.headers.get('cache-control')).toBe('max-age=60, private');
    // The buyer's credential paid us; the target got the Signer's
    expect(received.includes(credential)).toBe(false);
    expect(await legOf('/v1/mpp-buyer')).toMatchObject({ buyerLeg: { rail: 'mpp', status: 'settled', amount: 1_000n }, targetLeg: { protocol: 'mpp', status: 'settled' } });
  });

  it('chooses x402 on Base at the same price, and MPP on Tempo when it is cheaper', async () => {
    const paying = await buyer();

    const tie = await fetch(link('/v1/tie'), { headers: { authorization: `Bearer ${paying.key}` } });
    const cheaper = await fetch(link('/v1/cheaper'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(await tie.json()).toEqual({ path: '/v1/tie', paidWith: 'x402' });
    expect(paid.at(-2)).toEqual({ path: '/v1/tie', protocol: 'x402', amount: '2000' });
    expect(await cheaper.json()).toEqual({ path: '/v1/cheaper', paidWith: 'mpp' });
    expect(paid.at(-1)).toEqual({ path: '/v1/cheaper', protocol: 'mpp', amount: '0.001' });
    expect(await balance(paying.id)).toBe(1_000_000n - 2_000n - 1_000n);
  });

  it.each([
    ['push mode only', '/v1/push-only', 'push_only'],
    ['splits', '/v1/splits', 'splits'],
    ['a currency outside the registry', '/v1/currency', 'unsupported_currency'],
    ['another chain than mpp.network', '/v1/chain', 'wrong_chain'],
  ])('refuses a challenge with %s: 502 unsupported_payment with its reason, and nobody charged', async (_name, path, reason) => {
    const paying = await buyer();

    const response = await fetch(link(path), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': `refused-${reason}` } });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_payment' } });
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(lineOf(`refused-${reason}`, 'The routed target offers no payment we make')).toMatchObject({
      code: 'unsupported_payment', offered: ['mpp tempo.charge'], reasons: [reason],
    });
  });

  it('refuses above the per-call maximum and without a Tempo wallet: 503, the Signer\'s reason in the log, and nobody charged', async () => {
    const paying = await buyer();

    const expensive = await fetch(link('/v1/expensive'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'mpp-expensive' } });
    const noWallet = await fetch(link('/v1/no-wallet', noTempoUrl), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'mpp-no-wallet' } });

    expect([expensive.status, noWallet.status]).toEqual([503, 503]);
    await expect.poll(async () => (await legOf('/v1/no-wallet')).buyerLeg?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(lineOf('mpp-expensive', 'The Signer didn\'t sign a routed payment')).toMatchObject({
      protocol: 'mpp', network: tempoNetwork, code: 'signing_refused', reason: 'The amount is above the per-call maximum',
    });
    expect(lineOf('mpp-no-wallet', 'The Signer didn\'t sign a routed payment')).toMatchObject({
      protocol: 'mpp', code: 'signing_refused', reason: 'The Signer holds no wallet on Tempo Moderato',
    });
    expect(lineOf('mpp-no-wallet', 'Refused to sign a routed payment', 'signer')).toMatchObject({ reason: 'no_wallet' });
  });

  it('refuses a target that asks more on the paid retry: 502 quote_exceeded, nothing broadcast, nobody charged', async () => {
    const paying = await buyer();
    const before = rpc.transactions.length;

    const response = await fetch(link('/v1/pricier'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'quote_exceeded' } });
    await expect.poll(async () => (await legOf('/v1/pricier')).buyerLeg?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(rpc.transactions.length).toBe(before);
    expect((await legOf('/v1/pricier')).targetLeg).toMatchObject({ protocol: 'mpp', status: 'failed' });
  });

  it('books one routing loss when the target answers 5xx with a Payment-Receipt', async () => {
    const paying = await buyer();
    const before = await routingLossesBalance();

    const response = await fetch(link('/v1/broken'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(503);
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(await routingLossesBalance() - before).toBe(-1_000n);
    expect((await legOf('/v1/broken')).targetLeg).toMatchObject({ protocol: 'mpp', status: 'settled', lossBooked: true, receipt: expect.any(String) });
  });

  it('quotes an MPP-only target at GET /_/check without paying', async () => {
    const before = rpc.transactions.length;

    const checked = await (await fetch(`${proxyUrl}/_/check?url=${encodeURIComponent(`https://${targetHost}:${target.port}/v1/checked`)}`)).json();

    expect(checked).toEqual({
      payable: true, target: `https://${targetHost}:${target.port}/v1/checked`,
      price: { amount: '0.001', currency: 'USD', asset: 'tempo-pathusd', network: tempoNetwork },
      quote: { amount: '0.001', fee: '0', currency: 'USD' },
      link: `${config.urls.pay}/${targetHost}:${target.port}/v1/checked`,
    });
    expect(rpc.transactions.length).toBe(before);
  });
});

describe('an MPP buyer\'s deadline on the target call', () => {
  it('keeps the target call under the buyer\'s transaction expiry, less the time its settlement needs; a payment key\'s call gets the full timeout', async () => {
    const paying = await buyer();
    const credential = await mppCredential('/v1/deadline-mpp');
    const { validBefore } = Transaction.deserialize(Credential.deserialize<{ signature: `0x${string}` }>(credential).payload.signature) as { validBefore: number };
    const started = systemClock.now().getTime();

    const viaMpp = await fetch(link('/v1/deadline-mpp'), { headers: { authorization: credential, 'x-request-id': 'deadline-mpp' } });
    await fetch(link('/v1/deadline-key'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'deadline-key' } });

    expect(viaMpp.status).toBe(200);
    const timeoutMs = lineOf('deadline-mpp', 'Routed call answered')!['timeoutMs'] as number;
    expect(timeoutMs).toBeLessThanOrEqual(validBefore * 1_000 - started - settleMarginMs);
    expect(timeoutMs).toBeGreaterThan(validBefore * 1_000 - systemClock.now().getTime() - settleMarginMs - 1_000);
    expect(lineOf('deadline-key', 'Routed call answered')).toMatchObject({ timeoutMs: config.timeouts.requestMs });
  });

  it('answers 503 when the target runs past the deadline: the buyer\'s payment is cancelled and never broadcast', async () => {
    const credential = await mppCredential('/v1/slow', deadlineUrl);
    const before = rpc.rawTransactions.length;
    offsetMs = 0;
    // Signing took 18 s: about a second is left before the buyer's payment must settle
    shiftOnSign = 18_000;
    let response: Response;
    const started = performance.now();
    try {
      response = await fetch(link('/v1/slow', deadlineUrl), { headers: { authorization: credential, 'x-request-id': 'deadline-slow' } });
    }
    finally {
      shiftOnSign = 0;
      offsetMs = 0;
    }

    expect(await response.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
    expect(response.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(2_900);
    expect(lineOf('deadline-slow', 'The routed target didn\'t answer the paid retry: its payment\'s outcome is unknown')).toMatchObject({
      level: 40, targetLeg: 'unknown', timeoutMs: expect.any(Number),
    });
    expect(lineOf('deadline-slow', 'The routed target couldn\'t be reached')).toMatchObject({ code: 'outbound_timeout', attempt: 2 });
    expect(await legOf('/v1/slow')).toMatchObject({ buyerLeg: { rail: 'mpp', status: 'cancelled' }, targetLeg: { protocol: 'mpp', status: 'unknown' } });
    expect(rpc.rawTransactions.length).toBe(before);
  });

  it('sends the target nothing when the buyer\'s payment expires too soon to wait for an answer', async () => {
    const credential = await mppCredential('/v1/expiring', deadlineUrl);
    const sent = target.requests.length;
    offsetMs = 0;
    // Signing took 21 s: the buyer's payment couldn't settle after any answer
    shiftOnSign = 21_000;
    let response: Response;
    try {
      response = await fetch(link('/v1/expiring', deadlineUrl), { headers: { authorization: credential, 'x-request-id': 'deadline-expiring' } });
    }
    finally {
      shiftOnSign = 0;
      offsetMs = 0;
    }

    expect(response.status).toBe(503);
    expect(target.requests.length).toBe(sent);
    expect(lineOf('deadline-expiring', 'The buyer\'s payment expires too soon to call the target: nothing was sent')).toMatchObject({
      level: 40, reason: 'payment_expiring', targetLeg: 'failed',
    });
    expect(await legOf('/v1/expiring')).toMatchObject({ buyerLeg: { rail: 'mpp', status: 'cancelled' }, targetLeg: { status: 'failed' } });
  });
});

describe('the MPP routing lines', () => {
  it('names the protocol, network, and amount on the routing and Signer lines', async () => {
    const paying = await buyer();
    await fetch(link('/v1/logged'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'mpp-logged' } });

    expect(lineOf('mpp-logged', 'Routing quote')).toMatchObject({ protocol: 'mpp', network: tempoNetwork, asset: 'tempo-pathusd', price: '0.001', quote: '0.001' });
    expect(lineOf('mpp-logged', 'Signed a routed payment', 'signer')).toMatchObject({ protocol: 'mpp', network: tempoNetwork, amount: '0.001', maxFee: expect.any(String) });
    expect(lineOf('mpp-logged', 'Routed call answered')).toMatchObject({ protocol: 'mpp', network: tempoNetwork, price: '0.001', targetStatus: 200, receipt: true });
  });

  it('never logs the Tempo key, a signed transaction, or a credential', () => {
    const logged = JSON.stringify(lines);
    const credentials = [...received.filter(value => value.startsWith('Payment ')), ...buyerCredentials];

    expect(credentials.length).toBeGreaterThan(3);
    for (const credential of credentials) {
      expect(logged).not.toContain(credential.slice('Payment '.length));
      expect(logged).not.toContain(Credential.deserialize<{ signature: string }>(credential).payload.signature);
    }
    expect(logged).not.toContain(signerKey.slice(2));
  });
});
