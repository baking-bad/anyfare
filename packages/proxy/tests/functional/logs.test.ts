import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, systemClock, type MicroUsd, type Server } from '@anyfare/common';
import { findAsset, generateApiKey, hashApiKey, loadPlatformConfig, loadPlatformConfigDocument, type PlatformConfig } from '@anyfare/core';
import { createAccountRepository, createLedger, createPaymentKeyRepository, type Database } from '@anyfare/db';
import { createFacilitators, initializeX402 } from '@anyfare/payments';
import { createApp as createSigner } from '@anyfare/signer';
import {
  createFakeResolver, nearFacilitatorOff, createTestDatabase, createTestRedis, encodeBase58, facilitatorAnswers, startFakeFacilitator, startFakeUpstream, type FakeFacilitator,
  type FakeUpstream, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp, type ProxyServer } from '../../src/app.js';
import { createSignerClient } from '../../src/routing/support.js';
import { startProxy } from '../../src/start.js';

// A routed call's lines in the proxy and the Signer: what each says, under one request ID, and no secret

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const internalSecret = 'internal-secret-for-the-log-tests-0123456789';
const signerSecret = 'signer-secret-for-the-log-tests-0123456789';
const targetHosts = ['api.target.test', 'down.target.test', 'optout.target.test'];
const targetPayTo = '0x7777777777777777777777777777777777777777';
const generous = { requests: 100_000, windowSeconds: 60 };

/** A buyer account with a payment key and credits, written as the Platform API writes them. */
const createBuyer = async (db: Database, platform: PlatformConfig, credit: MicroUsd = 1_000_000n) => {
  const id = `acc_${randomUUID()}`;
  const createdAt = systemClock.now();
  await createAccountRepository({ db }).create({ id, createdAt });
  const key = generateApiKey('payment', platform.keyPrefixes);
  await createPaymentKeyRepository({ db }).insert({
    id: `key_${randomUUID()}`, accountId: id, keyHash: hashApiKey(key), label: undefined, createdAt, allowance: undefined, dailyBudget: 5_000_000n,
    maxPrice: undefined, expiresAt: undefined,
  });
  if (credit > 0n)
    await createLedger({ db, clock: systemClock, ids: randomIdGenerator }).credit({ accountId: id, amount: credit, reference: `credit-${id}` });

  return { id, key: key.expose() };
};

/** The internal API's `PUT /internal/v1/routed-endpoints`, recording the headers of each registration. */
const startFakeInternalApi = async () => {
  const registrations: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      registrations.push(request.headers);
      response.writeHead(201).end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    registrations,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};

/** A port nothing listens on: a target that is down. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));

  return port;
};

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let target: FakeUpstream;
let facilitator: FakeFacilitator;
let internalApi: Awaited<ReturnType<typeof startFakeInternalApi>>;
let http: OutboundHttp;
let signer: Server;
let proxy: ProxyServer;
let proxyUrl: string;
let downPort: number;
let usdc: string;
const signerKey = generatePrivateKey();
const signerWallet = privateKeyToAccount(signerKey);
// The PAYMENT-SIGNATURE values the target received: none may reach a log
const signedHeaders: string[] = [];
// Every line both apps write, debug included, each with its app's name
const lines: Record<string, unknown>[] = [];
const loggerFor = (name: string) => createLogger({ name, level: 'debug' }, {
  write: (line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  },
});

const option = (amount: string): PaymentRequirements => ({
  scheme: 'exact', network: base, amount, asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
} as PaymentRequirements);

beforeAll(async () => {
  [database, redis, target, facilitator, internalApi, downPort] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: targetHosts }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }), startFakeInternalApi(), closedPort(),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        routingFeeBps: 1000,
        rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous },
        facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff],
        mpp: { enabled: false },
        signer: { maxPerCall: '0.5', maxPerNetworkPerDay: '100' },
      })).toString('base64'),
    },
  });
  usdc = findAsset(config, 'base-usdc')!.address;
  let answered = 0;
  target.handle((request, response) => {
    const path = request.path.split('?')[0]!;
    if (path === '/.well-known/anyfare.json') {
      response.writeHead(request.servername === 'optout.target.test' ? 200 : 404, { 'content-type': 'application/json' }).end('{"routing":false}');
      return;
    }
    if (path === '/v1/free') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"free":true}');
      return;
    }
    const url = `https://${request.servername}:${target.port}${path}`;
    const amount = path === '/v1/expensive' ? '600000' : '1000';
    const header = request.headers['payment-signature'];
    if (typeof header !== 'string') {
      const accepts = path === '/v1/unpayable' ? [{ ...option(amount), network: 'eip155:1' }] : [option(amount)];
      response.writeHead(402, { 'payment-required': encodePaymentRequiredHeader({ x402Version: 2, resource: { url }, accepts } as never) }).end('{"body":"probe body secret"}');
      return;
    }
    signedHeaders.push(header);
    const settled = encodePaymentResponseHeader({ success: true, transaction: `0x${'cd'.repeat(32)}`, network: base, payer: signerWallet.address } as never);
    answered += 1;
    response.writeHead(path === '/v1/broken' ? 500 : 200, { 'content-type': 'application/json', 'payment-response': settled, 'x-request-id': `target-${answered}` })
      .end('{"body":"target body secret"}');
  });
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver(Object.fromEntries(targetHosts.map(host => [host, '127.0.0.1']))),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca,
    connectTimeoutMs: 5_000,
    totalTimeoutMs: 5_000,
  });
  signer = createSigner({ config, logger: loggerFor('signer'), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet } });
  const signerUrl = `http://127.0.0.1:${(await signer.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
  const x402 = await initializeX402({
    config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: systemClock }), timeoutMs: 5_000,
  });
  proxy = createApp({
    config, logger: loggerFor('proxy'), postgres: database.postgres, redis, http, x402,
    signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
    internalApi: { url: internalApi.url, secret: Secret.from(internalSecret) },
  });
  proxyUrl = `http://127.0.0.1:${(await proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await Promise.all([proxy?.close(), signer?.close()]);
  await Promise.all([http?.close(), target?.close(), facilitator?.close(), internalApi?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const linkTo = (path: string, host = 'api.target.test', port = target.port): string => `${proxyUrl}/${host}:${port}${path}`;
const call = (path: string, requestId: string, headers: Record<string, string> = {}, host?: string, port?: number) =>
  fetch(linkTo(path, host, port), { headers: { ...headers, 'x-request-id': requestId } });
const linesOf = (app: string, requestId: string) => lines.filter(line => line['name'] === app && line['requestId'] === requestId);
const lineOf = (requestId: string, msg: string, app = 'proxy') => linesOf(app, requestId).find(line => line['msg'] === msg);
const buyer = () => createBuyer(database.db, config);

/** An x402 payment of the link's 402, on Base, signed with the official client. */
const x402Signature = async (path: string): Promise<string> => {
  const required = decodePaymentRequiredHeader((await fetch(linkTo(path))).headers.get('payment-required')!);
  const client = new x402Client().register(base, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));

  return encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(item => item.network === base) }));
};

describe('a routed call\'s lines', () => {
  it('logs the quote, the target leg, and the buyer\'s payment, with their durations, under one request ID in the proxy and the Signer', async () => {
    const paying = await buyer();
    const requestId = 'routed-lines-1';

    const response = await call('/v1/pools?limit=10', requestId, { authorization: `Bearer ${paying.key}` });

    expect(response.status).toBe(200);
    expect(lineOf(requestId, 'Routing quote')).toMatchObject({
      level: 30, host: `api.target.test:${target.port}`, path: '/v1/pools', targetStatus: 402, protocol: 'x402', network: base, asset: 'base-usdc', x402Version: 2,
      price: '0.001', fee: '0.0001', quote: '0.0011', cached: false, durationMs: expect.any(Number),
    });
    expect(lineOf(requestId, 'Routed call answered')).toMatchObject({
      level: 30, paymentId: expect.stringMatching(/^pay_/), host: `api.target.test:${target.port}`, path: '/v1/pools', protocol: 'x402', network: base,
      price: '0.001', quote: '0.0011', signatureId: expect.stringMatching(/^sig_/), payTo: targetPayTo, targetStatus: 200, targetRequestId: expect.stringMatching(/^target-\d+$/),
      targetLeg: 'settled', receipt: true, attempt: 2, durationMs: expect.any(Number), timeoutMs: config.timeouts.requestMs,
    });
    await expect.poll(() => lineOf(requestId, 'Paid call finished')).toMatchObject({
      level: 30, paymentId: lineOf(requestId, 'Routed call answered')!['paymentId'], rail: 'credits', amount: '0.0011', host: `api.target.test:${target.port}`,
      path: '/v1/pools', decision: 'billable', paymentStatus: 'captured', upstreamStatus: 200, upstreamRequestId: expect.stringMatching(/^target-\d+$/),
      verifyMs: expect.any(Number), upstreamMs: expect.any(Number), settleMs: expect.any(Number),
    });
    expect(lineOf(requestId, 'Request completed')).toMatchObject({ level: 30, method: 'GET', route: '/*', status: 200, durationMs: expect.any(Number) });
    // The Signer's lines under the same ID: what it signed, and its request line
    expect(lineOf(requestId, 'Signed a routed payment', 'signer')).toMatchObject({
      level: 30, quoteId: lineOf(requestId, 'Routed call answered')!['paymentId'], protocol: 'x402', network: base, asset: 'base-usdc', amount: '0.001',
      atomicAmount: '1000', payTo: targetPayTo, result: 'signed',
    });
    expect(lineOf(requestId, 'Request completed', 'signer')).toMatchObject({ route: '/internal/v1/sign', status: 200 });
    // The target and the internal API get the same ID
    expect(target.requests.filter(request => request.path.startsWith('/v1/pools')).map(request => request.headers['x-request-id'])).toEqual([requestId, requestId]);
    await expect.poll(() => internalApi.registrations.map(headers => headers['x-request-id'])).toContain(requestId);
  });

  it('takes a repeat call\'s quote from the cache, at debug', async () => {
    const paying = await buyer();

    await call('/v1/pools?limit=10', 'routed-lines-2', { authorization: `Bearer ${paying.key}` });

    expect(lineOf('routed-lines-2', 'Routing quote')).toMatchObject({ level: 20, cached: true });
  });

  it('logs an x402 buyer\'s call with its network, asset, and our settlement\'s transaction', async () => {
    const signature = await x402Signature('/v1/x402-lines');

    const response = await call('/v1/x402-lines', 'routed-x402', { 'payment-signature': signature });

    expect(response.status).toBe(200);
    expect(lineOf('routed-x402', 'Paid call finished')).toMatchObject({
      level: 30, rail: 'x402', network: base, asset: 'base-usdc', amount: '0.0011', decision: 'billable', paymentStatus: 'settled',
      transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/), upstreamStatus: 200,
    });
  });
});

describe('a routed call that fails logs the stage and the reason', () => {
  it('a host refused, a target without a 402, and one we can\'t pay: at info, with the code and the reason', async () => {
    await call('/v1/pools', 'probe-optout', {}, 'optout.target.test');
    await call('/v1/free', 'probe-free');
    await call('/v1/unpayable', 'probe-unpayable');
    await fetch(`${proxyUrl}/pay.anyfare.test/v1/x`, { headers: { 'x-request-id': 'probe-own' } });

    expect(lineOf('probe-optout', 'The host opted out of routing')).toMatchObject({ level: 30, host: `optout.target.test:${target.port}` });
    expect(lineOf('probe-optout', 'Routing refused the host')).toMatchObject({ level: 30, code: 'host_not_allowed', reason: 'opted_out', host: `optout.target.test:${target.port}` });
    expect(lineOf('probe-own', 'Routing refused the host')).toMatchObject({ level: 30, code: 'host_not_allowed', reason: 'own_host' });
    expect(lineOf('probe-free', 'The routed target didn\'t ask for a payment')).toMatchObject({ level: 30, code: 'not_payable', targetStatus: 200 });
    expect(lineOf('probe-unpayable', 'The routed target offers no payment we make')).toMatchObject({
      level: 30, code: 'unsupported_payment', targetStatus: 402, offered: ['exact eip155:1'], reasons: ['not_in_registry'],
    });
    expect(lineOf('probe-unpayable', 'Request completed')).toMatchObject({ level: 30, status: 502, code: 'unsupported_payment' });
  });

  it('a target that is down: the transport\'s code, the host, method, and path without its query; nobody charged', async () => {
    const paying = await buyer();

    const response = await call('/v1/status?token=query-secret', 'probe-down', { authorization: `Bearer ${paying.key}` }, 'down.target.test', downPort);

    expect(response.status).toBe(503);
    expect(lineOf('probe-down', 'The routed target couldn\'t be reached')).toMatchObject({
      level: 40, host: `down.target.test:${downPort}`, method: 'GET', path: '/v1/status', code: 'ECONNREFUSED', attempt: 1, durationMs: expect.any(Number),
      error: { code: 'connection_failed' },
    });
    expect(JSON.stringify(linesOf('proxy', 'probe-down'))).not.toContain('query-secret');
  });

  it('the Signer\'s refusal: its code and reason in the proxy, and why in the Signer, under one ID; the buyer\'s hold released', async () => {
    const paying = await buyer();

    const response = await call('/v1/expensive', 'signer-refusal', { authorization: `Bearer ${paying.key}` });

    expect(response.status).toBe(503);
    expect(lineOf('signer-refusal', 'The Signer didn\'t sign a routed payment')).toMatchObject({
      level: 40, paymentId: expect.stringMatching(/^pay_/), price: '0.6', quote: '0.66', code: 'signing_refused', reason: 'The amount is above the per-call maximum',
      signer: { method: 'POST', path: '/internal/v1/sign', status: 422, code: 'signing_refused', durationMs: expect.any(Number) },
    });
    expect(lineOf('signer-refusal', 'Refused to sign a routed payment', 'signer')).toMatchObject({
      level: 30, result: 'refused', reason: 'above_max_per_call', network: base, atomicAmount: '600000', payTo: targetPayTo, quotedPrice: '0.6',
    });
    await expect.poll(() => lineOf('signer-refusal', 'Paid call finished')).toMatchObject({ rail: 'credits', decision: 'not_billable', paymentStatus: 'released', upstreamStatus: null });
  });

  it('a payment the facilitator refused: the buyer\'s fault, at info, with the facilitator\'s reason', async () => {
    const signature = await x402Signature('/v1/x402-refused');
    facilitator.handle('/verify', facilitatorAnswers.invalid('invalid_exact_evm_signature'));
    let response: Response;
    try {
      response = await call('/v1/x402-refused', 'x402-refused', { 'payment-signature': signature });
    }
    finally {
      facilitator.reset();
    }

    expect(response.status).toBe(402);
    expect(lineOf('x402-refused', 'Paid call refused')).toMatchObject({
      level: 30, rail: 'x402', code: 'payment_invalid', reason: 'invalid_exact_evm_signature', facilitator: 'cdp', host: `api.target.test:${target.port}`,
    });
  });

  it('a hold the balance refuses: at info, with its code', async () => {
    const broke = await createBuyer(database.db, config, 0n);

    const response = await call('/v1/pools', 'broke', { authorization: `Bearer ${broke.key}` });

    expect(response.status).toBe(402);
    expect(lineOf('broke', 'Paid call refused')).toMatchObject({ level: 30, rail: 'credits', code: 'insufficient_balance' });
  });

  it('a target that kept our payment for a failed call: the routing loss, at warn', async () => {
    const paying = await buyer();

    await call('/v1/broken', 'routing-loss', { authorization: `Bearer ${paying.key}` });

    expect(lineOf('routing-loss', 'Routed call answered')).toMatchObject({ level: 30, targetStatus: 500, targetLeg: 'settled', receipt: true });
    expect(lineOf('routing-loss', 'A target kept a routed payment for a failed call: booked as a routing loss')).toMatchObject({
      level: 40, paymentId: expect.stringMatching(/^pay_/), status: 500, protocol: 'x402', network: base, amount: '0.001', asset: 'base-usdc',
    });
  });
});

describe('the proxy\'s lines carry no secret', () => {
  it('logs routed calls without a key, a signed payment, a shared secret, the wallet\'s key, a body, a query, or a buyer\'s own header', async () => {
    const paying = await buyer();
    const signature = await x402Signature('/v1/secret-lines');
    const before = lines.length;

    await call('/v1/secret-lines?api_key=buyer-query-secret', 'secrets-1', { authorization: `Bearer ${paying.key}`, 'x-api-key': 'buyer-own-key', cookie: 'session=cookie-secret' });
    await call('/v1/secret-lines', 'secrets-2', { 'payment-signature': signature });
    await call('/v1/secret-lines', 'secrets-3');
    await expect.poll(() => lines.slice(before).filter(line => line['msg'] === 'Paid call finished').length).toBeGreaterThanOrEqual(2);

    expect(signedHeaders.length).toBeGreaterThan(3);
    const logged = JSON.stringify(lines);
    for (const secret of [
      paying.key, signature, signerSecret, internalSecret, signerKey, signerKey.slice(2), 'buyer-query-secret', 'buyer-own-key', 'cookie-secret',
      'target body secret', 'probe body secret', 'Bearer ', ...signedHeaders,
    ])
      expect(logged).not.toContain(secret);
    expect(logged).not.toMatch(/af_test_[0-9A-Za-z]{20,}|afm_test_[0-9A-Za-z]{20,}/);
  });
});

describe('the startup line', () => {
  const startEnv = async (overrides: Record<string, unknown>, env: Record<string, string> = {}) => {
    const document = await loadPlatformConfigDocument({ env: { CONFIG_PATH: 'config/example.yaml' } });
    const merged = { ...document, facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff], ...overrides };

    return {
      CONFIG: Buffer.from(JSON.stringify(merged)).toString('base64'),
      DATABASE_URL: database.url.expose(),
      REDIS_URL: redis.url.expose(),
      HOST: '127.0.0.1',
      PORT: '0',
      METRICS_PORT: '0',
      ...env,
    };
  };

  it('logs once what the proxy runs with, at LOG_LEVEL, and warns that MPP isn\'t offered without a recipient, never naming a secret', async () => {
    const document = await loadPlatformConfigDocument({ env: { CONFIG_PATH: 'config/example.yaml' } });
    const { recipient: _recipient, ...withoutRecipient } = document.mpp;
    const assets = document.assets.map(({ payTo, ...asset }) => asset.network === document.mpp.network ? asset : { ...asset, payTo });
    const env = await startEnv({ mpp: withoutRecipient, assets }, {
      GIT_SHA: 'f7b6ffb', LOG_LEVEL: 'debug', SIGNER_URL: 'http://signer.internal:8083', SIGNER_SECRET: signerSecret,
    });
    const startup: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startup.push(JSON.parse(line) as Record<string, unknown>) });

    const app = await startProxy({ env, logger });
    await app.close();

    expect(logger.level).toBe('debug');
    expect(startup.filter(line => line['msg'] === 'Started')).toEqual([expect.objectContaining({
      level: 30,
      app: 'proxy',
      commit: 'f7b6ffb',
      logLevel: 'debug',
      environment: 'staging',
      urls: config.urls,
      rails: { credits: true, x402: [{ facilitator: 'cdp', networks: [base, solana] }], mpp: false },
      serving: { x402: true, mpp: false },
      routing: { signer: true, internalApi: false },
      ports: { port: expect.any(Number), metricsPort: expect.any(Number) },
    })]);
    expect(startup.find(line => line['msg'] === 'MPP isn\'t offered to buyers: mpp.enabled is false or mpp.recipient is not set')).toMatchObject({ level: 40, reason: 'no_recipient' });
    const logged = JSON.stringify(startup);
    for (const secret of [signerSecret, database.url.expose(), redis.url.expose()])
      expect(logged).not.toContain(secret);
  });

  it('needs MPP_SECRET_KEY only when MPP is offered', async () => {
    const quiet = { LOG_LEVEL: 'silent' };
    await expect(startProxy({ env: await startEnv({}, quiet), logger: createLogger() })).rejects.toThrow(/MPP_SECRET_KEY/);
    await expect(startProxy({ env: await startEnv({}, { ...quiet, MPP_SECRET_KEY: 'too-short' }), logger: createLogger() }))
      .rejects.toThrow('MPP_SECRET_KEY must be at least 32 bytes');

    const off = await startProxy({ env: await startEnv({ mpp: { network: 'eip155:42431', enabled: false } }, quiet), logger: createLogger() });
    await off.close();
  });
});
