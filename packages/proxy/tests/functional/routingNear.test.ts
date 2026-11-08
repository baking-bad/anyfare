import { randomUUID } from 'node:crypto';

import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, systemClock, type Server } from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createLedger, createPaymentRepository, payments, targetPayments } from '@anyfare/db';
import { createApp as createFacilitator } from '@anyfare/facilitator';
import { createFacilitatorLookup, createFacilitators, initializeX402, type X402Setup } from '@anyfare/payments';
import { createApp as createSigner } from '@anyfare/signer';
import {
  createFakeClock, createFakeResolver, createTestDatabase, createTestNearPayer, createTestRedis, generateNearKey, startFakeNearRpc, startFakeUpstream,
  type FakeNearRpc, type FakeUpstream, type TestDatabase, type TestNearPayer, type TestRedis,
} from '@anyfare/testing';
import { createSettlementFollowUp, settlingGraceMs } from '@anyfare/workers';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createSignerClient } from '../../src/routing/support.js';

// A routed call paid on NEAR: the buyer signs a delegate action with the x402 SDK's client, our own
// facilitator verifies and settles it through its relayer against a fake NEAR node, and the Signer pays
// the target on Base, as for any routed call. Every account and key is made up here.

const base = 'eip155:84532';
const near = 'near:testnet';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const facilitatorSecret = 'facilitator-secret-0123456789abcdef-0123';
const targetHost = 'near.target.test';
const targetPayTo = '0x4444444444444444444444444444444444444444';
// Ours, and an account of ours the facilitator doesn't take payments to
const payTo = 'pay.anyfare.testnet';
const notOurs = 'elsewhere.anyfare.testnet';
const relayerId = 'relay.anyfare.testnet';
const relayerKey = generateNearKey();
const generous = { requests: 100_000, windowSeconds: 60 };

let database: TestDatabase;
let redis: TestRedis;
let rpc: FakeNearRpc;
let target: FakeUpstream;
let config: PlatformConfig;
let facilitatorConfig: PlatformConfig;
let usdc: string;
let facilitator: Server;
let facilitatorUrl: string;
let signer: Server;
let signerUrl: string;
let http: OutboundHttp;
let x402: X402Setup;
let proxy: ProxyServer;
let proxyUrl: string;
const signerWallet = privateKeyToAccount(generatePrivateKey());
// Each line the proxy and the facilitator write
const lines: Record<string, unknown>[] = [];
const loggerFor = (name: string) => createLogger({ name, level: 'debug' }, {
  write: (line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  },
});
// What happened, in order: the target's paid retries, with how many NEAR transactions the node had then
const events: string[] = [];
// Every PAYMENT-SIGNATURE a buyer sent: none may reach a log
const sent: string[] = [];
// Paid retries the target holds until the test lets them answer, by request ID
const gates = new Map<string, () => void>();

/** The target's x402 option: USDC on Base at $0.001. */
const baseOption = (): PaymentRequirements => ({
  scheme: 'exact', network: base, amount: '1000', asset: findAsset(config, 'base-usdc')!.address, payTo: targetPayTo, maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
} as PaymentRequirements);

/** The proxy's config, with our facilitator for NEAR at `url`, and `payTo` for the NEAR asset. */
const proxyConfigFor = async (url: string, nearPayTo = payTo): Promise<PlatformConfig> => {
  const loaded = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous },
        // NEAR only, through our facilitator with its key. A settle may take the facilitator's 5 s to answer.
        facilitators: [
          { name: 'cdp', url: 'https://api.cdp.coinbase.com/platform/v2/x402', networks: [base, 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'], enabled: false },
          { name: 'near', url, networks: [near], auth: { type: 'api-key', apiKey: 'FACILITATOR_SECRET' } },
        ],
        mpp: { enabled: false },
        timeouts: { settleMs: 10_000 },
        signer: { maxPerCall: '0.05', maxPerNetworkPerDay: '100' },
      })).toString('base64'),
    },
  });

  return { ...loaded, assets: loaded.assets.map(asset => asset.name === 'near-usdc' ? { ...asset, payTo: nearPayTo } : asset) };
};

const x402For = (platform: PlatformConfig): Promise<X402Setup> => initializeX402({
  config: platform, timeoutMs: 5_000,
  facilitators: createFacilitators({ config: platform, cdpApiKey: () => { throw new Error('No CDP auth'); }, facilitatorApiKey: () => Secret.from(facilitatorSecret), clock: systemClock }),
});

const proxyFor = (platform: PlatformConfig, setup: X402Setup): ProxyServer => createApp({
  config: platform, logger: loggerFor('proxy'), postgres: database.postgres, redis, http, x402: setup,
  signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
});

beforeAll(async () => {
  [database, redis, rpc, target] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeNearRpc(), startFakeUpstream({ hosts: [targetHost] })]);
  // Short deadlines for the facilitator: a second per read and per send, and a settle answers within its least wait, 5 s
  facilitatorConfig = await loadPlatformConfig({
    env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ timeouts: { connectMs: 1_000, settleMs: 1_500 } })).toString('base64') },
  });
  usdc = findAsset(facilitatorConfig, 'near-usdc')!.address;
  rpc.addAccount({ accountId: relayerId, publicKey: relayerKey.publicKey });
  rpc.addAccount({ accountId: payTo });
  rpc.addToken({ contractId: usdc, registered: [payTo] });
  facilitator = createFacilitator({
    config: facilitatorConfig, logger: loggerFor('facilitator'), secret: Secret.from(facilitatorSecret),
    relayer: { accountId: relayerId, secretKey: Secret.from(relayerKey.secretKey) }, recipients: [payTo], rpcUrls: { [near]: rpc.url }, pollMs: 200,
  });
  facilitatorUrl = `http://127.0.0.1:${(await facilitator.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
  config = await proxyConfigFor(facilitatorUrl);

  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    const header = request.headers['payment-signature'];
    if (typeof header !== 'string') {
      const required = encodePaymentRequiredHeader({ x402Version: 2, error: 'Payment required', resource: { url: `https://${targetHost}${path}` }, accepts: [baseOption()] } as never);
      response.writeHead(402, { 'payment-required': required, 'content-type': 'application/json' }).end('{}');
      return;
    }
    events.push(`target:${path}:${rpc.transactions.length}`);
    // The node stops taking transactions while the target answers: the buyer's settle can't be sent
    if (path === '/v1/node-down')
      rpc.unavailable(true, { methods: ['send_tx'] });
    if (path === '/v1/slow')
      await new Promise<void>(resolve => gates.set(String(request.headers['x-request-id']), resolve));
    const settled = encodePaymentResponseHeader({ success: true, transaction: `0x${'cd'.repeat(32)}`, network: base, payer: signerWallet.address } as never);
    response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled }).end(JSON.stringify({ path, paid: true }));
  });

  http = new OutboundHttp({
    ownHosts: config.ownHosts, resolver: createFakeResolver({ [targetHost]: '127.0.0.1' }), addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca, connectTimeoutMs: 5_000, totalTimeoutMs: 5_000,
  });
  signer = createSigner({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet } });
  signerUrl = `http://127.0.0.1:${(await signer.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
  x402 = await x402For(config);
  proxy = proxyFor(config, x402);
  proxyUrl = `http://127.0.0.1:${(await proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await Promise.all([proxy?.close(), signer?.close()]);
  await facilitator?.close();
  await Promise.all([http?.close(), target?.close(), rpc?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// The fake target listens on a port of its own: links name it, as /<host>:<port>/… allows
const link = (path: string, at = proxyUrl): string => `${at}/${targetHost}:${target.port}${path}`;
const rowOf = async (requestId: string) => (await database.db.select().from(payments).where(eq(payments.requestId, requestId)))[0];
const legOf = async (paymentId: string) => (await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, paymentId)))[0];
const lineOf = (requestId: string, msg: string) => lines.find(line => line['requestId'] === requestId && line['msg'] === msg);
const errorOf = async (response: Response) => [response.status, (await response.json() as { error: { code: string } }).error.code];

let payers = 0;

/** A buyer on NEAR with $0.1 of USDC: a key made here, on the fake node. */
const newPayer = (): TestNearPayer => {
  const accountId = `near-buyer-${++payers}.testnet`;
  const payer = createTestNearPayer({ accountId, rpc });
  rpc.setBalance(usdc, accountId, 100_000n);

  return payer;
};

/** The payer's PAYMENT-SIGNATURE for the proxy's 402 at `url`, as the x402 SDK's client signs it. */
const signedFor = async (payer: TestNearPayer, url: string): Promise<string> => {
  const unpaid = await fetch(url);
  const header = encodePaymentSignatureHeader(await payer.paymentFor(decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!)));
  sent.push(header);

  return header;
};

const ofPayer = (payer: TestNearPayer) => rpc.transactions.filter(transaction => transaction.delegate.senderId === payer.accountId);

/** The workers' settlement follow-up, as its job runs it once the grace period has passed. */
const followUp = () => {
  const clock = createFakeClock(new Date(Date.now() + settlingGraceMs(config) + 1_000));

  return createSettlementFollowUp({
    payments: createPaymentRepository({ db: database.db, clock }),
    ledger: createLedger({ db: database.db, clock, ids: randomIdGenerator }),
    facilitatorFor: createFacilitatorLookup(config, createFacilitators({
      config, cdpApiKey: () => { throw new Error('No CDP auth'); }, facilitatorApiKey: () => Secret.from(facilitatorSecret), clock,
    })),
    clock,
    settleMs: config.timeouts.settleMs,
    logger: loggerFor('workers'),
  })();
};

describe('a routed call paid on NEAR through our facilitator', () => {
  it('offers NEAR in the 402, verifies the payment, pays the target, settles before answering, and books it', async () => {
    const payer = newPayer();
    const requestId = `near-paid-${randomUUID()}`;
    const unpaid = await fetch(link('/v1/paid'));
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    const signature = await signedFor(payer, link('/v1/paid'));
    const [received, buyerBefore] = [rpc.balanceOf(usdc, payTo), rpc.balanceOf(usdc, payer.accountId)];
    const transactions = rpc.transactions.length;

    const paid = await fetch(link('/v1/paid'), { headers: { 'payment-signature': signature, 'x-request-id': requestId } });

    expect(unpaid.status).toBe(402);
    expect(required.accepts).toEqual([{ scheme: 'exact', network: near, amount: '1000', asset: usdc, payTo, maxTimeoutSeconds: 300, extra: {} }]);
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ path: '/v1/paid', paid: true });
    // The target was paid before the buyer's settle, and the settle landed before the answer
    expect(events.at(-1)).toBe(`target:/v1/paid:${transactions}`);
    expect(rpc.transactions.length).toBe(transactions + 1);
    const transaction = rpc.transactions.at(-1)!;
    expect(transaction).toMatchObject({
      signerId: relayerId, receiverId: payer.accountId, status: 'success', delegate: { senderId: payer.accountId, receiverId: usdc, transfer: { receiverId: payTo, amount: 1_000n } },
    });
    expect(decodePaymentResponseHeader(paid.headers.get('payment-response')!)).toEqual({ success: true, transaction: transaction.hash, network: near, payer: payer.accountId });
    // Moved once
    expect(rpc.balanceOf(usdc, payer.accountId)).toBe(buyerBefore - 1_000n);
    expect(rpc.balanceOf(usdc, payTo)).toBe(received + 1_000n);
    expect(ofPayer(payer)).toHaveLength(1);
    const row = await rowOf(requestId);
    expect(row).toMatchObject({ rail: 'x402', status: 'settled', network: near, asset: 'near-usdc', amount: 1_000n, atomicAmount: 1_000n, transactionHash: transaction.hash });
    expect(await legOf(row!.id)).toMatchObject({ network: base, status: 'settled', buyerCharged: true });
    expect(lines.find(line => line['name'] === 'facilitator' && line['msg'] === 'Verified a payment' && line['payer'] === payer.accountId)).toMatchObject({ result: 'valid', network: near });
  });

  it('refuses a payer\'s second payment while the first is in flight with a 402, recording and verifying nothing, and the first settles', async () => {
    const payer = newPayer();
    const [firstId, secondId] = [`near-first-${randomUUID()}`, `near-second-${randomUUID()}`];
    const first = await signedFor(payer, link('/v1/slow'));
    const pending = fetch(link('/v1/slow'), { headers: { 'payment-signature': first, 'x-request-id': firstId } });
    await expect.poll(() => gates.has(firstId)).toBe(true);
    // Signed while the first hasn't landed: the same delegate nonce
    const second = await signedFor(payer, link('/v1/slow'));
    const verifies = lines.filter(line => line['name'] === 'facilitator' && line['msg'] === 'Verified a payment').length;

    const refused = await fetch(link('/v1/slow'), { headers: { 'payment-signature': second, 'x-request-id': secondId } });
    gates.get(firstId)!();
    const answered = await pending;

    expect(await errorOf(refused)).toEqual([402, 'payment_invalid']);
    expect(lines.filter(line => line['requestId'] === secondId && line['msg'] === 'Paid call refused')).toEqual([
      expect.objectContaining({ level: 30, rail: 'x402', code: 'payment_invalid', reason: 'payer_busy' }),
    ]);
    expect(await rowOf(secondId)).toBeUndefined();
    expect(gates.has(secondId)).toBe(false);
    expect(lines.filter(line => line['name'] === 'facilitator' && line['msg'] === 'Verified a payment').length).toBe(verifies);
    expect(answered.status).toBe(200);
    expect(await rowOf(firstId)).toMatchObject({ status: 'settled' });
    expect(ofPayer(payer)).toHaveLength(1);
  });

  it('answers a 402 and records nothing when our facilitator refuses the recipient', async () => {
    const elsewhere = await proxyConfigFor(facilitatorUrl, notOurs);
    rpc.addAccount({ accountId: notOurs });
    const other = proxyFor(elsewhere, await x402For(elsewhere));
    const at = `http://127.0.0.1:${(await other.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
    try {
      const payer = newPayer();
      const requestId = `near-not-ours-${randomUUID()}`;
      const signature = await signedFor(payer, link('/v1/not-ours', at));
      const transactions = rpc.transactions.length;

      const refused = await fetch(link('/v1/not-ours', at), { headers: { 'payment-signature': signature, 'x-request-id': requestId } });

      expect(await errorOf(refused)).toEqual([402, 'payment_invalid']);
      expect(lineOf(requestId, 'Paid call refused')).toMatchObject({ reason: 'recipient_not_ours', facilitator: 'near' });
      expect(lines.find(line => line['name'] === 'facilitator' && line['msg'] === 'Refused to verify a payment that isn\'t to us' && line['payTo'] === notOurs))
        .toMatchObject({ reason: 'recipient_not_ours' });
      expect(await rowOf(requestId)).toBeUndefined();
      expect(events.some(event => event.startsWith('target:/v1/not-ours'))).toBe(false);
      expect(rpc.transactions.length).toBe(transactions);
    }
    finally {
      await other.close();
    }
  });

  it('answers the buyer when the node takes no transaction at settle, keeps the payment settling, and the follow-up settles it once the node is back', async () => {
    const payer = newPayer();
    const requestId = `near-node-down-${randomUUID()}`;
    const signature = await signedFor(payer, link('/v1/node-down'));
    const buyerBefore = rpc.balanceOf(usdc, payer.accountId);

    let paid: Response;
    try {
      paid = await fetch(link('/v1/node-down'), { headers: { 'payment-signature': signature, 'x-request-id': requestId } });
    }
    finally {
      rpc.unavailable(false);
    }

    // The relayer's transaction was signed and sent, without an answer: pending, and the buyer has the response
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ path: '/v1/node-down', paid: true });
    const receipt = decodePaymentResponseHeader(paid.headers.get('payment-response')!);
    expect(receipt).toMatchObject({ success: false, errorReason: 'settlement_pending', network: near, transaction: expect.any(String) });
    expect(await rowOf(requestId)).toMatchObject({ status: 'settling', needsReview: false, transactionHash: receipt.transaction, receipt: paid.headers.get('payment-response') });
    expect(lineOf(requestId, 'Paid call finished: its settlement is pending')).toMatchObject({ level: 40, network: near, transaction: receipt.transaction });

    // The relayer sends the same bytes again once the node is back, and they land
    await expect.poll(() => ofPayer(payer).length, { timeout: 10_000 }).toBe(1);
    expect(ofPayer(payer)[0]).toMatchObject({ hash: receipt.transaction, status: 'success' });

    expect(await followUp()).toEqual({ settled: 1, failed: 0, pending: 0, unknown: 0, skipped: 0 });
    const row = await rowOf(requestId);
    expect(row).toMatchObject({ status: 'settled', needsReview: false, transactionHash: receipt.transaction, receipt: paid.headers.get('payment-response') });
    expect(await legOf(row!.id)).toMatchObject({ status: 'settled', buyerCharged: true });
    expect(rpc.balanceOf(usdc, payer.accountId)).toBe(buyerBefore - 1_000n);
    expect(ofPayer(payer)).toHaveLength(1);
  }, 30_000);

  it('never writes a buyer\'s payment or the relayer\'s key to a line', () => {
    const logged = JSON.stringify(lines);

    expect(sent.length).toBeGreaterThan(3);
    for (const header of sent) {
      expect(logged).not.toContain(header);
      const signed = String((JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { payload: { signedDelegateAction: string } }).payload.signedDelegateAction);
      expect(logged).not.toContain(signed.slice(0, 48));
    }
    expect(logged).not.toContain(relayerKey.secretKey.slice('ed25519:'.length));
    expect(logged).not.toContain(facilitatorSecret);
  });
});
