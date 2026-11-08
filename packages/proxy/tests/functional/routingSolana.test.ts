import { randomUUID } from 'node:crypto';

import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, systemClock, type MicroUsd, type Server } from '@anyfare/common';
import { findAsset, generateApiKey, hashApiKey, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createAccountRepository, createLedger, createPaymentKeyRepository, ledgerAccountIds, payments, signatures, targetPayments, type Database } from '@anyfare/db';
import { createFacilitators, initializeX402 } from '@anyfare/payments';
import { createApp as createSigner } from '@anyfare/signer';
import {
  associatedTokenAddress, nearFacilitatorOff, createFakeResolver, createTestDatabase, createTestRedis, decodeSolanaPayment, encodeBase58, startFakeFacilitator, startFakeSolanaRpc,
  startFakeUpstream, type FakeFacilitator, type FakeSolanaRpc, type FakeUpstream, type SolanaPayment, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createSignerClient } from '../../src/routing/support.js';

// Payment routing pays x402 targets on Solana from the Signer's Solana wallet. Buyers pay as they do for
// any routed call. The target's facilitator pays the transaction's fee.

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const targetHost = 'sol.target.test';
// Made-up addresses: the target's on Solana, its facilitator's fee payer, and the target's on Base
const targetPayTo = encodeBase58(Uint8Array.from({ length: 32 }, () => 4));
const targetFeePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 5));
const targetBasePayTo = '0x4444444444444444444444444444444444444444';
// The key in SOLANA_RPC_URL's path: no log line may hold it
const rpcKey = 'routing-solana-rpc-key-secret';
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
let solanaRpc: FakeSolanaRpc;
let facilitator: FakeFacilitator;
let http: OutboundHttp;
let signer: Server;
let baseOnlySigner: Server;
let proxy: ProxyServer;
let noSolanaProxy: ProxyServer;
let proxyUrl: string;
let noSolanaUrl: string;
let mint: string;
let usdc: string;
let solanaWallet: KeyPairSigner;
const signerKey = generatePrivateKey();
const signerWallet = privateKeyToAccount(signerKey);
// What the target was paid, by path, with the Solana transaction as it decoded it
const paid: { path: string; network: string; amount: string; payment?: SolanaPayment }[] = [];
// Every PAYMENT-SIGNATURE the target received: none may reach a log
const received: string[] = [];
const lines: Record<string, unknown>[] = [];
const loggerFor = (name: string) => createLogger({ name, level: 'debug' }, {
  write: (line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  },
});

const solanaOption = (amount: string, extra: Record<string, unknown> = { feePayer: targetFeePayer }): PaymentRequirements => ({
  scheme: 'exact', network: solana, amount, asset: mint, payTo: targetPayTo, maxTimeoutSeconds: 60, extra,
} as PaymentRequirements);

const baseOption = (amount: string): PaymentRequirements => ({
  scheme: 'exact', network: base, amount, asset: usdc, payTo: targetBasePayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
} as PaymentRequirements);

/** The target's options by path: USDC on Solana at $0.001, unless the path asks for something else. */
const optionsFor = (path: string): PaymentRequirements[] => {
  switch (path) {
    case '/v1/no-fee-payer': return [solanaOption('1000', {})];
    case '/v1/fee-payer-is-us': return [solanaOption('1000', { feePayer: solanaWallet.address })];
    case '/v1/expensive': return [solanaOption('60000')];
    case '/v1/tie': return [solanaOption('2000'), baseOption('2000')];
    case '/v1/solana-cheaper': return [baseOption('2000'), solanaOption('1999')];
    default: return [solanaOption('1000')];
  }
};

beforeAll(async () => {
  [database, redis, target, solanaRpc, facilitator, solanaWallet] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: [targetHost] }), startFakeSolanaRpc(),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }), generateKeyPairSigner(),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        routingFeeBps: 0,
        rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous },
        facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff],
        mpp: { enabled: false },
        signer: { maxPerCall: '0.05', maxPerNetworkPerDay: '100', wallets: { solana: solanaWallet.address } },
      })).toString('base64'),
    },
  });
  mint = findAsset(config, 'solana-usdc')!.address;
  usdc = findAsset(config, 'base-usdc')!.address;

  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    const url = `https://${targetHost}${path}`;
    const header = request.headers['payment-signature'];
    if (typeof header !== 'string') {
      const required = encodePaymentRequiredHeader({ x402Version: 2, error: 'Payment required', resource: { url, mimeType: 'application/json' }, accepts: optionsFor(path) } as never);
      response.writeHead(402, { 'payment-required': required, 'content-type': 'application/json' }).end('{}');
      return;
    }
    received.push(header);
    // Asks more on the paid retry, and settles nothing
    if (path === '/v1/pricier') {
      const required = encodePaymentRequiredHeader({ x402Version: 2, error: 'Payment required', resource: { url }, accepts: [solanaOption('5000')] } as never);
      response.writeHead(402, { 'payment-required': required }).end('{}');
      return;
    }
    const signed = decodePaymentSignatureHeader(header) as unknown as { accepted: PaymentRequirements; payload: Record<string, any> };
    const network = signed.accepted.network;
    if (network === solana) {
      // As its facilitator would: the transaction pays exactly the amount asked, into its payTo's USDC account, with its fee payer
      const payment = decodeSolanaPayment(signed.payload['transaction'] as string);
      paid.push({ path, network, amount: signed.accepted.amount, payment });
    }
    else
      paid.push({ path, network, amount: String(signed.payload['authorization']?.value) });
    const settled = encodePaymentResponseHeader({ success: true, transaction: encodeBase58(Uint8Array.from({ length: 64 }, () => 7)), network, payer: solanaWallet.address } as never);
    // A failure that keeps our payment
    if (path === '/v1/broken') {
      response.writeHead(500, { 'payment-response': settled }).end('{"error":"boom"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled }).end(JSON.stringify({ path, paidOn: network }));
  });

  http = new OutboundHttp({
    ownHosts: config.ownHosts, resolver: createFakeResolver({ [targetHost]: '127.0.0.1' }), addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000,
  });
  const signerDependencies = { config, logger: loggerFor('signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret) };
  // Base and Solana, with the Solana RPC's key in its path; and a Signer without SIGNER_SOLANA_KEY
  signer = createSigner({ ...signerDependencies, wallets: { base: signerWallet, solana: solanaWallet }, solanaRpcUrl: Secret.from(`${solanaRpc.url}/${rpcKey}`) });
  baseOnlySigner = createSigner({ ...signerDependencies, wallets: { base: signerWallet } });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [signerPorts, baseOnlyPorts] = await Promise.all([signer.listen(listen), baseOnlySigner.listen(listen)]);
  const x402 = await initializeX402({
    config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: systemClock }), timeoutMs: 5_000,
  });
  const proxyFor = (signerPort: number) => createApp({
    config, logger: loggerFor('proxy'), postgres: database.postgres, redis, http, x402,
    signer: createSignerClient({ url: `http://127.0.0.1:${signerPort}`, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
  });
  proxy = proxyFor(signerPorts.port);
  noSolanaProxy = proxyFor(baseOnlyPorts.port);
  const [proxyPorts, noSolanaPorts] = await Promise.all([proxy.listen(listen), noSolanaProxy.listen(listen)]);
  proxyUrl = `http://127.0.0.1:${proxyPorts.port}`;
  noSolanaUrl = `http://127.0.0.1:${noSolanaPorts.port}`;
});

afterAll(async () => {
  await Promise.all([proxy?.close(), noSolanaProxy?.close(), signer?.close(), baseOnlySigner?.close()]);
  await Promise.all([http?.close(), target?.close(), solanaRpc?.close(), facilitator?.close()]);
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
const treasuryAndLosses = async () => {
  const found = await ledger().balancesOf([ledgerAccountIds.treasury('solana-usdc'), ledgerAccountIds.routingLosses]);

  return { treasury: found.get(ledgerAccountIds.treasury('solana-usdc')) ?? 0n, losses: found.get(ledgerAccountIds.routingLosses) ?? 0n };
};
const lineOf = (requestId: string, msg: string, app = 'proxy') => lines.find(line => line['requestId'] === requestId && line['name'] === app && line['msg'] === msg);

describe('payment routing pays x402 targets on Solana', () => {
  it('pays a Solana target for a payment key: our wallet signs a USDC transfer of exactly its price to its payTo, with its fee payer', async () => {
    const paying = await buyer();
    const before = await treasuryAndLosses();
    const rpcCalls = solanaRpc.calls.length;

    const response = await fetch(link('/v1/slot'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: '/v1/slot', paidOn: solana });
    // Our receipt, never the target's
    expect(response.headers.get('anyfare-receipt')).toContain('amount="0.001"');
    expect(response.headers.get('payment-response')).toBeNull();
    expect(await balance(paying.id)).toBe(1_000_000n - 1_000n);
    // The Signer built the transaction through the Solana RPC
    expect(solanaRpc.calls.slice(rpcCalls)).toEqual(expect.arrayContaining(['getAccountInfo', 'getLatestBlockhash']));
    const { payment } = paid.at(-1)!;
    expect(payment).toMatchObject({
      feePayer: targetFeePayer,
      signedBy: [solanaWallet.address],
      unsignedBy: [targetFeePayer],
      transfer: {
        source: await associatedTokenAddress(solanaWallet.address, mint), mint, destination: await associatedTokenAddress(targetPayTo, mint), authority: solanaWallet.address,
        amount: 1_000n, decimals: 6,
      },
    });
    const { buyerLeg, targetLeg } = await legOf('/v1/slot');
    expect(buyerLeg).toMatchObject({ rail: 'credits', amount: 1_000n });
    expect(targetLeg).toMatchObject({
      protocol: 'x402', network: solana, asset: 'solana-usdc', amount: 1_000n, atomicAmount: 1_000n, payTo: targetPayTo, status: 'settled', receipt: expect.any(String),
      transactionHash: expect.any(String),
    });
    const [signature] = await database.db.select().from(signatures).where(eq(signatures.id, targetLeg!.signatureId));
    expect(signature).toMatchObject({ protocol: 'x402', network: solana, asset: 'solana-usdc', atomicAmount: 1_000n, payTo: targetPayTo, quoteId: buyerLeg!.id });
    await expect.poll(async () => (await legOf('/v1/slot')).buyerLeg?.status).toBe('captured');
    // The target's price leaves the Solana treasury
    expect((await treasuryAndLosses()).treasury - before.treasury).toBe(1_000n);
  });

  it('is paid by an x402 buyer on Base for a Solana target', async () => {
    const unpaid = await fetch(link('/v1/x402-buyer'));
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    const client = new x402Client().register(base, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
    const signed = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));

    const viaX402 = await fetch(link('/v1/x402-buyer'), { headers: { 'payment-signature': signed } });

    expect(viaX402.status).toBe(200);
    expect(await legOf('/v1/x402-buyer')).toMatchObject({ buyerLeg: { rail: 'x402', network: base, status: 'settled', amount: 1_000n }, targetLeg: { network: solana, status: 'settled' } });
  });

  it('chooses Base over Solana at the same price, and a cheaper Solana option', async () => {
    const paying = await buyer();

    const tie = await fetch(link('/v1/tie'), { headers: { authorization: `Bearer ${paying.key}` } });
    const cheaper = await fetch(link('/v1/solana-cheaper'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(await tie.json()).toEqual({ path: '/v1/tie', paidOn: base });
    expect(await cheaper.json()).toEqual({ path: '/v1/solana-cheaper', paidOn: solana });
    expect(paid.at(-1)).toMatchObject({ path: '/v1/solana-cheaper', network: solana, payment: { transfer: { amount: 1_999n } } });
  });

  it.each([
    ['without a fee payer', '/v1/no-fee-payer', 'no_fee_payer'],
    ['whose fee payer is our own wallet', '/v1/fee-payer-is-us', 'fee_payer_is_us'],
  ])('refuses a Solana option %s: 502 unsupported_payment with its reason, and nobody charged', async (_case, path, reason) => {
    const paying = await buyer();
    const requestId = `solana-${reason}`;

    const response = await fetch(link(path), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': requestId } });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_payment' } });
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(lineOf(requestId, 'The routed target offers no payment we make')).toMatchObject({ code: 'unsupported_payment', offered: [`exact ${solana}`], reasons: [reason] });
  });

  it('refuses a Solana target that asks more on the paid retry: 502 quote_exceeded, and nobody charged', async () => {
    const paying = await buyer();

    const response = await fetch(link('/v1/pricier'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'quote_exceeded' } });
    await expect.poll(async () => (await legOf('/v1/pricier')).buyerLeg?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect((await legOf('/v1/pricier')).targetLeg).toMatchObject({ network: solana, status: 'failed' });
  });

  it('refuses above the per-call maximum and without a Solana wallet: 503, the Signer\'s reason in the log, and nobody charged', async () => {
    const paying = await buyer();

    const expensive = await fetch(link('/v1/expensive'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'solana-expensive' } });
    const noWallet = await fetch(link('/v1/no-wallet', noSolanaUrl), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'solana-no-wallet' } });

    expect([expensive.status, noWallet.status]).toEqual([503, 503]);
    await expect.poll(async () => (await legOf('/v1/no-wallet')).buyerLeg?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(lineOf('solana-expensive', 'The Signer didn\'t sign a routed payment')).toMatchObject({
      protocol: 'x402', network: solana, code: 'signing_refused', reason: 'The amount is above the per-call maximum',
    });
    expect(lineOf('solana-no-wallet', 'The Signer didn\'t sign a routed payment')).toMatchObject({
      network: solana, code: 'signing_refused', reason: 'The Signer holds no wallet on Solana Devnet',
    });
    expect(lineOf('solana-no-wallet', 'Refused to sign a routed payment', 'signer')).toMatchObject({ reason: 'no_wallet' });
  });

  it('books one routing loss when the target answers 5xx with a successful PAYMENT-RESPONSE', async () => {
    const paying = await buyer();
    const before = await treasuryAndLosses();

    const response = await fetch(link('/v1/broken'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(503);
    expect(await balance(paying.id)).toBe(1_000_000n);
    const after = await treasuryAndLosses();
    expect(after.losses - before.losses).toBe(-1_000n);
    expect(after.treasury - before.treasury).toBe(1_000n);
    expect((await legOf('/v1/broken')).targetLeg).toMatchObject({ network: solana, status: 'settled', lossBooked: true, receipt: expect.any(String) });
  });

  it('quotes a Solana-only target at GET /_/check without paying', async () => {
    const before = paid.length;

    const checked = await (await fetch(`${proxyUrl}/_/check?url=${encodeURIComponent(`https://${targetHost}:${target.port}/v1/checked`)}`)).json();

    expect(checked).toEqual({
      payable: true, target: `https://${targetHost}:${target.port}/v1/checked`,
      price: { amount: '0.001', currency: 'USD', asset: 'solana-usdc', network: solana },
      quote: { amount: '0.001', fee: '0', currency: 'USD' },
      link: `${config.urls.pay}/${targetHost}:${target.port}/v1/checked`,
    });
    expect(paid.length).toBe(before);
  });

  it('names the network and amount on the routing and Signer lines, and never logs the RPC\'s key, a signed transaction, or a key', async () => {
    const paying = await buyer();
    await fetch(link('/v1/logged'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'solana-logged' } });

    expect(lineOf('solana-logged', 'Routing quote')).toMatchObject({ protocol: 'x402', network: solana, asset: 'solana-usdc', price: '0.001' });
    expect(lineOf('solana-logged', 'Signed a routed payment', 'signer')).toMatchObject({ protocol: 'x402', network: solana, amount: '0.001' });
    expect(lineOf('solana-logged', 'Routed call answered')).toMatchObject({ network: solana, targetStatus: 200, receipt: true, targetLeg: 'settled' });

    const logged = JSON.stringify(lines);
    expect(received.length).toBeGreaterThan(4);
    for (const header of received) {
      expect(logged).not.toContain(header);
      const transaction = (decodePaymentSignatureHeader(header) as unknown as { payload: { transaction?: string } }).payload.transaction;
      if (transaction)
        expect(logged).not.toContain(transaction);
    }
    expect(logged).not.toContain(rpcKey);
    expect(logged).not.toContain(signerKey.slice(2));
    expect(logged).not.toContain(paying.key);
  });
});
