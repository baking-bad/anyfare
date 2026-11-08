import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BlockedAddressError, ConnectionFailedError, createAddressPolicy, createLogger, OutboundHttp, OutboundTimeoutError, randomIdGenerator, Secret, systemClock,
  type MicroUsd, type Server,
} from '@anyfare/common';
import { findAsset, generateApiKey, hashApiKey, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import {
  createAccountRepository, createLedger, createPaymentKeyRepository, createRedisInvalidationBus, createRoutingRepository, ledgerAccountIds, payments,
  signatures, targetPayments, type Database,
} from '@anyfare/db';
import { createFacilitators, initializeX402, type X402Setup } from '@anyfare/payments';
import { createApp as createSigner } from '@anyfare/signer';
import {
  createFakeResolver, nearFacilitatorOff, createTestDatabase, createTestRedis, encodeBase58, facilitatorAnswers, startFakeFacilitator, startFakeUpstream, type FakeFacilitator,
  type FakeUpstream, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp, type ProxyDependencies, type ProxyServer } from '../../src/app.js';
import { settleMarginMs } from '../../src/routing/routes.js';
import { createSignerClient } from '../../src/routing/support.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const targetHosts = ['api.target.test', 'optout.target.test', 'blocked.target.test', 'other.anyfare.test'];
const targetPayTo = '0x3333333333333333333333333333333333333333';
// What the target says it settled our payment with: never what the buyer sees
const targetTransaction = `0x${'ab'.repeat(32)}`;
const generous = { requests: 100_000, windowSeconds: 60 };
// USDC on Base mainnet, as config/production.yaml names it
const mainnetUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// --- Buyers, balances, and the internal API ---

interface TestBuyer {
  readonly id: string;
  readonly keyId: string;
  // The payment key, in full: what the buyer sends
  readonly key: string;
}

/** A buyer account with a payment key and credits, written as the Platform API writes them. */
const createBuyer = async (db: Database, platform: PlatformConfig, credit: MicroUsd = 1_000_000n): Promise<TestBuyer> => {
  const id = `acc_${randomUUID()}`;
  const keyId = `key_${randomUUID()}`;
  const createdAt = systemClock.now();
  await createAccountRepository({ db }).create({ id, createdAt });
  const key = generateApiKey('payment', platform.keyPrefixes);
  await createPaymentKeyRepository({ db }).insert({
    id: keyId, accountId: id, keyHash: hashApiKey(key), label: undefined, createdAt, allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined,
    expiresAt: undefined,
  });
  await createLedger({ db, clock: systemClock, ids: randomIdGenerator }).credit({ accountId: id, amount: credit, reference: `credit-${id}` });

  return { id, keyId, key: key.expose() };
};

/** The internal API's `PUT /internal/v1/routed-endpoints`, recording each registration and answering 201. */
const startFakeInternalApi = async () => {
  const registrations: { readonly headers: IncomingHttpHeaders; readonly body: unknown }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'PUT' && request.url === '/internal/v1/routed-endpoints') {
        registrations.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
        response.writeHead(201, { 'content-type': 'application/json' }).end('{}');
      }
      else
        response.writeHead(404).end();
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

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let target: FakeUpstream;
let facilitator: FakeFacilitator;
let internalApi: Awaited<ReturnType<typeof startFakeInternalApi>>;
let http: OutboundHttp;
let proxy: ProxyServer;
let signer: Server;
let signerUrl: string;
let x402: X402Setup;
let proxyUrl: string;
let metricsUrl: string;
let usdc: string;
const signerWallet = privateKeyToAccount(generatePrivateKey());
// What the target was paid, per call
const paidRequests: { path: string; amount: string; to: string }[] = [];
// The order the facilitator and the target were called in
const events: string[] = [];
// The main proxy's lines
const lines: Record<string, unknown>[] = [];
// Paid retries the target holds until the test lets them answer, by request ID
const gates = new Map<string, () => void>();

/** The target's x402 options: a Gateway nanopayment, cheaper, and a plain USDC payment on Base. */
const options = (amount: string): PaymentRequirements[] => [
  { scheme: 'exact', network: base, amount: '100', asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'GatewayWalletBatched', version: '1' } },
  { scheme: 'exact', network: base, amount, asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } },
] as PaymentRequirements[];

const challenge = (url: string, amount: string, version = 2) => encodePaymentRequiredHeader({
  x402Version: version, error: 'Payment required', resource: { url, description: 'Pools', mimeType: 'application/json' }, accepts: options(amount),
} as never);

beforeAll(async () => {
  [database, redis, target, facilitator, internalApi] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: targetHosts }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }), startFakeInternalApi(),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        // The website on a subdomain of its own, so another subdomain of the domain isn't ours
        urls: { website: 'https://www.anyfare.test', api: 'https://api.anyfare.test', pay: 'https://pay.anyfare.test' },
        // A 10% routing fee, so the split shows
        routingFeeBps: 1000,
        rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous },
        facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff],
        mpp: { enabled: false },
        signer: { maxPerCall: '0.5', maxPerNetworkPerDay: '100' },
      })).toString('base64'),
    },
  });
  usdc = findAsset(config, 'base-usdc')!.address;
  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    const url = `https://${request.servername}:${target.port}${path}`;
    if (path === '/.well-known/anyfare.json') {
      response.writeHead(request.servername === 'optout.target.test' ? 200 : 404, { 'content-type': 'application/json' }).end('{"routing":false}');
      return;
    }
    if (path === '/v1/free') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"free":true}');
      return;
    }
    if (path === '/v1/gateway-only') {
      const gatewayOnly = encodePaymentRequiredHeader({
        x402Version: 2, error: 'Payment required', resource: { url, description: 'Gateway only', mimeType: 'application/json' }, accepts: options('1000').slice(0, 1),
      } as never);
      response.writeHead(402, { 'payment-required': gatewayOnly }).end('{}');
      return;
    }
    // On Base mainnet, which the production config pays in
    if (path === '/v1/mainnet') {
      const mainnet = encodePaymentRequiredHeader({
        x402Version: 2, error: 'Payment required', resource: { url, description: 'Mainnet', mimeType: 'application/json' },
        accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: mainnetUsdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
      } as never);
      response.writeHead(402, { 'payment-required': mainnet }).end('{}');
      return;
    }
    // x402 version 1 only: its options in the body, or in a version 1 header
    if (path === '/v1/legacy-body') {
      response.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ x402Version: 1, error: 'Payment required', accepts: options('1000') }));
      return;
    }
    if (path === '/v1/legacy-header') {
      response.writeHead(402, { 'payment-required': challenge(url, '1000', 1) }).end('{}');
      return;
    }
    const header = request.headers['payment-signature'];
    if (typeof header !== 'string') {
      response.writeHead(402, { 'payment-required': challenge(url, path === '/v1/expensive' ? '600000' : '1000'), 'content-type': 'application/json' }).end('{}');
      return;
    }
    events.push(`target:${path}`);
    const payload = decodePaymentSignatureHeader(header) as unknown as { payload: { authorization: { to: string; value: string } } };
    paidRequests.push({ path, amount: payload.payload.authorization.value, to: payload.payload.authorization.to });
    if (path === '/v1/pricier') {
      response.writeHead(402, { 'payment-required': challenge(url, '5000') }).end('{}');
      return;
    }
    const settled = encodePaymentResponseHeader({ success: true, transaction: targetTransaction, network: base, payer: signerWallet.address } as never);
    // Asks for a payment again, though it says it settled ours
    if (path === '/v1/kept-402') {
      response.writeHead(402, { 'payment-required': challenge(url, '1000'), 'payment-response': settled }).end('{}');
      return;
    }
    // Answers once the test lets it, such as after the buyer has gone
    if (path === '/v1/slow-paid') {
      await new Promise<void>(resolve => gates.set(String(request.headers['x-request-id']), resolve));
      response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled }).end('{"slow":true}');
      return;
    }
    if (path === '/v1/no-content') {
      response.writeHead(204, { 'payment-response': settled }).end();
      return;
    }
    // Breaks off after the status and part of the body went out
    if (path === '/v1/breaks') {
      response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled });
      response.write('{"pools":[1,');
      setTimeout(() => response.destroy(), 50);
      return;
    }
    if (path === '/v1/broken') {
      response.writeHead(500, { 'payment-response': settled }).end('{"error":"boom"}');
      return;
    }
    if (path === '/v1/failing') {
      response.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"upstream of the target"}');
      return;
    }
    // 64 KiB, over the size the capped proxy waits for: streamed, or declared up front
    if (path === '/v1/huge-stream') {
      response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled });
      response.write(Buffer.alloc(32 * 1024, 'a'));
      response.end(Buffer.alloc(32 * 1024, 'b'));
      return;
    }
    if (path === '/v1/huge-declared') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(64 * 1024), 'payment-response': settled }).end(Buffer.alloc(64 * 1024, 'c'));
      return;
    }
    if (path === '/v1/missing') {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no such pool"}');
      return;
    }
    const self = `https://${request.servername}:${target.port}`;
    response.writeHead(200, {
      'content-type': 'application/json', 'payment-response': settled, location: `${self}/v1/pools/next`, link: `<${self}/v1/pools?page=2>; rel="next"`,
      'set-cookie': 'session=target', 'x-powered-by': 'target', 'cache-control': 'public, max-age=60',
      ...path === '/v1/traced' ? { 'x-request-id': 'target-request-7' } : {},
    }).end(JSON.stringify({ pools: [1, 2, 3], path }));
  });
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver(Object.fromEntries(targetHosts.map(host => [host, '127.0.0.1']))),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca,
    connectTimeoutMs: 5_000,
    totalTimeoutMs: 5_000,
  });
  signer = createSigner({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet } });
  signerUrl = `http://127.0.0.1:${(await signer.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
  x402 = await initializeX402({
    config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: systemClock }), timeoutMs: 5_000,
  });
  proxy = createApp({
    config, logger: createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }), postgres: database.postgres, redis, http, x402,
    signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
    internalApi: { url: internalApi.url, secret: Secret.from(internalSecret) },
  });
  const ports = await proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  proxyUrl = `http://127.0.0.1:${ports.port}`;
  metricsUrl = `http://127.0.0.1:${ports.metricsPort}/metrics`;
});

afterAll(async () => {
  await Promise.all([proxy?.close(), signer?.close()]);
  await Promise.all([http?.close(), target?.close(), facilitator?.close(), internalApi?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// The fake target listens on a port of its own: links name it, as /<host>:<port>/… allows
const at = (host: string): string => `${host}:${target.port}`;
const linkTo = (path: string, host = 'api.target.test'): string => `${proxyUrl}/${at(host)}${path}`;
const buyer = () => createBuyer(database.db, config);
const balance = async (accountId: string): Promise<bigint> => (await createLedger({ db: database.db, clock: systemClock, ids: randomIdGenerator }).balance(accountId)).available;
const platformBalances = async () => {
  const ids = [ledgerAccountIds.treasury('base-usdc'), ledgerAccountIds.routingFees, ledgerAccountIds.routingLosses] as const;
  const balances = await createLedger({ db: database.db, clock: systemClock, ids: randomIdGenerator }).balancesOf(ids);

  return { treasury: balances.get(ids[0]) ?? 0n, fees: balances.get(ids[1]) ?? 0n, losses: balances.get(ids[2]) ?? 0n };
};
const paymentOf = async (accountId: string) => (await database.db.select().from(payments).where(eq(payments.buyerAccountId, accountId)))[0];
const legOf = async (paymentId: string) => (await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, paymentId)))[0];
const errorOf = async (response: Response) => [response.status, (await response.json() as { error: { code: string } }).error.code];

/** An x402 payment of the 402's Base option, signed by a new buyer wallet with the official client. */
const payOnBase = async (link: string): Promise<string> => {
  const required = decodePaymentRequiredHeader((await fetch(link)).headers.get('payment-required')!);
  const client = new x402Client().register(base, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));

  return encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));
};

/** The same x402 payment, valid until `validBefore` instead. The fake facilitator doesn't check the signature. */
const validUntil = (header: string, validBefore: number): string => {
  const payload = decodePaymentSignatureHeader(header);
  const authorization = payload.payload['authorization'] as Record<string, unknown>;

  return encodePaymentSignatureHeader({ ...payload, payload: { ...payload.payload, authorization: { ...authorization, validBefore: String(validBefore) } } });
};

const lineOf = (requestId: string, msg: string) => lines.find(line => line['requestId'] === requestId && line['msg'] === msg);

/** Another proxy, on the same database, target, and Signer, with some dependencies of its own. */
const withProxy = async (overrides: Partial<ProxyDependencies>, work: (url: string) => Promise<void>): Promise<void> => {
  const other = createApp({
    config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, http, x402,
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

describe('a routed call paid with a payment key', () => {
  it('holds the quote, pays the target its price through the Signer, captures, and answers with the target\'s body and our receipt', async () => {
    const paying = await buyer();
    const before = await platformBalances();

    const response = await fetch(linkTo('/v1/pools?limit=10'), { headers: { authorization: `Bearer ${paying.key}`, 'x-api-key': 'buyer-own-key' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pools: [1, 2, 3], path: '/v1/pools' });
    expect(response.headers.get('anyfare-receipt')).toMatch(/^id="pay_[^"]+", amount="0\.0011", currency="USD"$/);
    // The plain option, not the cheaper Gateway one, at the target's price, to its address
    expect(paidRequests.at(-1)).toEqual({ path: '/v1/pools', amount: '1000', to: targetPayTo });
    expect(await balance(paying.id)).toBe(1_000_000n - 1_100n);
    // Credits capture once the answer is out
    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('captured');
    const after = await platformBalances();
    expect(after.treasury - before.treasury).toBe(1_000n);
    expect(after.fees - before.fees).toBe(100n);
    const row = await paymentOf(paying.id);
    expect(row).toMatchObject({ rail: 'credits', status: 'captured', amount: 1_100n, fee: 100n, targetHost: at('api.target.test'), targetPath: '/v1/pools' });
    const leg = await legOf(row!.id);
    expect(leg).toMatchObject({
      protocol: 'x402', network: base, asset: 'base-usdc', amount: 1_000n, payTo: targetPayTo, status: 'settled', transactionHash: targetTransaction, buyerCharged: true,
    });
    // The Signer recorded what it signed
    const [signature] = await database.db.select().from(signatures).where(eq(signatures.id, leg!.signatureId));
    expect(signature).toMatchObject({ network: base, asset: 'base-usdc', atomicAmount: 1_000n, payTo: targetPayTo, quoteId: row!.id });
  });

  it('sends the target the allowlist, the buyer\'s own X- headers, and our payment, never the buyer\'s credential or a condition', async () => {
    const paying = await buyer();
    const requestId = 'routed-headers-1';
    const conditions = {
      'if-none-match': '"v1"', 'if-modified-since': 'Sun, 08 Nov 2026 10:00:00 GMT', 'if-match': '"v1"', 'if-range': '"v1"',
      'if-unmodified-since': 'Sun, 08 Nov 2026 10:00:00 GMT',
    };

    await fetch(linkTo('/v1/headers'), {
      headers: {
        authorization: `Bearer ${paying.key}`, 'x-api-key': 'buyer-own-key', cookie: 'session=buyer', accept: 'application/json', range: 'bytes=0-99',
        'x-request-id': requestId, ...conditions,
      },
    });

    const [probe, retry] = target.requests.filter(request => request.path === '/v1/headers');
    for (const sent of [probe!, retry!]) {
      expect(sent.headers).toMatchObject({ accept: 'application/json', range: 'bytes=0-99', 'x-api-key': 'buyer-own-key', 'x-request-id': requestId });
      expect(sent.headers['authorization']).toBeUndefined();
      expect(sent.headers['cookie']).toBeUndefined();
      for (const name of Object.keys(conditions))
        expect(sent.headers[name]).toBeUndefined();
    }
    expect(probe!.headers['payment-signature']).toBeUndefined();
    expect(decodePaymentSignatureHeader(retry!.headers['payment-signature'] as string)).toMatchObject({ x402Version: 2, accepted: { amount: '1000', payTo: targetPayTo } });
  });

  it('points the target\'s links at the routing link, and passes neither its payment headers nor its cookies', async () => {
    const paying = await buyer();

    const response = await fetch(linkTo('/v1/pools'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.headers.get('location')).toBe(`${config.urls.pay}/${at('api.target.test')}/v1/pools/next`);
    expect(response.headers.get('link')).toBe(`<${config.urls.pay}/${at('api.target.test')}/v1/pools?page=2>; rel="next"`);
    for (const name of ['payment-response', 'payment-required', 'www-authenticate', 'payment-receipt', 'set-cookie', 'x-powered-by'])
      expect(response.headers.get(name)).toBeNull();
  });

  it('registers each paid endpoint once, through the internal API, under the call\'s request ID', async () => {
    const paying = await buyer();
    await fetch(linkTo('/v1/registered'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'register-1' } });
    await fetch(linkTo('/v1/registered'), { headers: { authorization: `Bearer ${paying.key}`, 'x-request-id': 'register-2' } });

    await expect.poll(() => internalApi.registrations.filter(item => (item.body as { path: string }).path === '/v1/registered').length).toBe(1);
    const [registration] = internalApi.registrations.filter(item => (item.body as { path: string }).path === '/v1/registered');
    expect(registration!.body).toEqual({ host: at('api.target.test'), path: '/v1/registered', quote: '0.0011' });
    expect(registration!.headers).toMatchObject({ 'x-internal-secret': internalSecret, 'x-internal-caller': 'proxy', 'x-request-id': 'register-1' });
  });

  it('refuses a revoked key at once after its key event, though the key cache held it', async () => {
    const paying = await buyer();
    await proxy.subscribed;
    expect((await fetch(linkTo('/v1/pools'), { headers: { authorization: `Bearer ${paying.key}` } })).status).toBe(200);

    await createPaymentKeyRepository({ db: database.db }).revoke({ id: paying.keyId, accountId: paying.id, revokedAt: systemClock.now() });
    const bus = createRedisInvalidationBus({ redis, logger: createLogger({ level: 'silent' }) });
    await bus.publish({ kind: 'key', id: paying.keyId });
    await bus.close();

    await expect.poll(async () => (await fetch(linkTo('/v1/pools'), { headers: { authorization: `Bearer ${paying.key}` } })).status).toBe(401);
  });
});

describe('a routed call paid with x402', () => {
  it('answers a call without a credential with the combined 402 at the quote: credits and x402 on Base and Solana', async () => {
    const unpaid = await fetch(linkTo('/v1/pools'));
    const body = await unpaid.json() as { credits: { price: string; signup: { url: string } } };
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);

    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get('cache-control')).toBe('no-store');
    expect(body.credits).toMatchObject({ price: '0.0011', signup: { url: `${config.urls.api}/v1/accounts` } });
    expect(required.resource).toMatchObject({ url: `${config.urls.pay}/${at('api.target.test')}/v1/pools`, description: `${at('api.target.test')}/v1/pools, through Anyfare` });
    expect(required.accepts.map(option => [option.network, option.amount])).toEqual([[base, '1100'], [solana, '1100']]);
    expect(required.extensions).toBeUndefined();
  });

  it('verifies the buyer\'s payment, pays the target, settles before answering, and answers with our PAYMENT-RESPONSE', async () => {
    const link = linkTo('/v1/x402-paid');
    const signature = await payOnBase(link);
    const requestId = `routed-x402-${randomUUID()}`;
    facilitator.handle('/verify', request => {
      events.push('verify');

      return facilitatorAnswers.valid(request);
    });
    facilitator.handle('/settle', request => {
      events.push('settle');

      return facilitatorAnswers.settled(request);
    });
    events.length = 0;
    let paid: Response;
    try {
      paid = await fetch(link, { headers: { 'payment-signature': signature, 'x-request-id': requestId } });
    }
    finally {
      facilitator.reset();
    }

    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ pools: [1, 2, 3], path: '/v1/x402-paid' });
    expect(events).toEqual(['verify', 'target:/v1/x402-paid', 'settle']);
    const receipt = decodePaymentResponseHeader(paid.headers.get('payment-response')!);
    expect(receipt).toMatchObject({ success: true, network: base });
    expect(receipt.transaction).not.toBe(targetTransaction);
    const [row] = await database.db.select().from(payments).where(eq(payments.requestId, requestId));
    expect(row).toMatchObject({ rail: 'x402', status: 'settled', amount: 1_100n, fee: 100n, network: base, asset: 'base-usdc' });
    expect(await legOf(row!.id)).toMatchObject({ status: 'settled', amount: 1_000n, buyerCharged: true });
  });

  it('offers x402 on NEAR mainnet with config/production.yaml: our payTo there and the USDC contract, beside Base and Solana', async () => {
    const mainnets = ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'near:mainnet'];
    // Made-up receiving addresses and hot wallets, as the deployment adds them
    const payTo: Readonly<Record<string, string>> = {
      'base-usdc': '0x5555555555555555555555555555555555555555', 'solana-usdc': encodeBase58(Uint8Array.from({ length: 32 }, () => 5)),
      'tempo-usdce': '0x6666666666666666666666666666666666666666', 'near-usdc': 'pay.anyfare.test.near',
    };
    const fake = await startFakeFacilitator({ networks: mainnets, feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) });
    try {
      const loaded = await loadPlatformConfig({
        env: {
          CONFIG_PATH: 'config/production.yaml',
          CONFIG: Buffer.from(JSON.stringify({
            facilitators: [
              { name: 'cdp', url: fake.url, networks: mainnets.slice(0, 2) },
              { name: 'near', url: fake.url, networks: ['near:mainnet'], auth: { type: 'api-key', apiKey: 'FACILITATOR_SECRET' } },
            ],
            signer: { wallets: { base: '0x7777777777777777777777777777777777777777', tempo: '0x7777777777777777777777777777777777777777', solana: payTo['solana-usdc'] } },
          })).toString('base64'),
        },
      });
      const production: PlatformConfig = { ...loaded, assets: loaded.assets.map(asset => ({ ...asset, payTo: payTo[asset.name] })) };
      const productionX402 = await initializeX402({
        config: production, timeoutMs: 5_000,
        facilitators: createFacilitators({ config: production, cdpApiKey: () => { throw new Error('No CDP auth'); }, facilitatorApiKey: () => Secret.from(internalSecret), clock: systemClock }),
      });

      await withProxy({ config: production, x402: productionX402 }, async url => {
        const unpaid = await fetch(`${url}/${at('api.target.test')}/v1/mainnet`);
        const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);

        expect(unpaid.status).toBe(402);
        expect(required.resource.url).toBe(`https://pay.anyfare.agents.bakingbad.dev/${at('api.target.test')}/v1/mainnet`);
        expect(required.accepts.map(option => [option.network, option.payTo])).toEqual([
          ['eip155:8453', payTo['base-usdc']], ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payTo['solana-usdc']], ['near:mainnet', 'pay.anyfare.test.near'],
        ]);
        expect(required.accepts.find(option => option.network === 'near:mainnet')).toEqual({
          scheme: 'exact', network: 'near:mainnet', amount: '1000', asset: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', payTo: 'pay.anyfare.test.near',
          maxTimeoutSeconds: 300, extra: {},
        });
      });
      expect(fake.requests.filter(request => request.path === '/supported').length).toBeGreaterThan(0);
    }
    finally {
      await fake.close();
    }
  });

  it('refuses the same signed payment twice: one payment pays for one call', async () => {
    const link = linkTo('/v1/x402-once');
    const signature = await payOnBase(link);

    expect((await fetch(link, { headers: { 'payment-signature': signature } })).status).toBe(200);
    expect(await errorOf(await fetch(link, { headers: { 'payment-signature': signature } }))).toEqual([402, 'payment_invalid']);
  });

  it('refuses two credentials at once with 400 multiple_payment_methods', async () => {
    const paying = await buyer();
    const signature = await payOnBase(linkTo('/v1/pools'));

    expect(await errorOf(await fetch(linkTo('/v1/pools'), { headers: { authorization: `Bearer ${paying.key}`, 'payment-signature': signature } })))
      .toEqual([400, 'multiple_payment_methods']);
  });
});

describe('routing refusals', () => {
  it('refuses our hosts, blocklisted hosts, hosts that opted out, and IP addresses before any payment', async () => {
    await createRoutingRepository({ db: database.db, clock: systemClock }).block({ host: 'blocked.target.test', reason: 'abuse' });
    const before = target.requests.length;

    expect(await errorOf(await fetch(`${proxyUrl}/${new URL(config.urls.pay).host}/v1/x`))).toEqual([400, 'host_not_allowed']);
    expect(await errorOf(await fetch(`${proxyUrl}/a.pay.anyfare.test/v1/x`))).toEqual([400, 'host_not_allowed']);
    expect(await errorOf(await fetch(`${proxyUrl}/api.anyfare.test/v1/x`))).toEqual([400, 'host_not_allowed']);
    expect(await errorOf(await fetch(linkTo('/v1/pools', 'blocked.target.test')))).toEqual([400, 'host_not_allowed']);
    expect(await errorOf(await fetch(linkTo('/v1/pools', 'optout.target.test')))).toEqual([400, 'host_not_allowed']);
    expect(await errorOf(await fetch(`${proxyUrl}/10.0.0.1/v1/pools`))).toEqual([400, 'invalid_target']);
    expect(await errorOf(await fetch(`${proxyUrl}/`))).toEqual([400, 'invalid_target']);
    // The opt-out file is the only request, and the blocklisted host gets none
    expect(target.requests.slice(before).map(request => [request.servername, request.path])).toEqual([['optout.target.test', '/.well-known/anyfare.json']]);
  });

  it('routes another subdomain of our domain: only our exact hosts and their subdomains are ours', async () => {
    expect((await fetch(linkTo('/v1/pools', 'other.anyfare.test'))).status).toBe(402);
    expect(await errorOf(await fetch(`${proxyUrl}/www.anyfare.test/v1/x`))).toEqual([400, 'host_not_allowed']);
  });

  it('answers a target without a 402 with not_payable, and one we can\'t pay, x402 version 1 included, with unsupported_payment', async () => {
    expect(await errorOf(await fetch(linkTo('/v1/free')))).toEqual([400, 'not_payable']);
    expect(await errorOf(await fetch(linkTo('/v1/gateway-only')))).toEqual([502, 'unsupported_payment']);
    expect(await errorOf(await fetch(linkTo('/v1/legacy-body')))).toEqual([502, 'unsupported_payment']);
    expect(await errorOf(await fetch(linkTo('/v1/legacy-header')))).toEqual([502, 'unsupported_payment']);
  });

  it('refuses a target that asks more on the paid retry with 502 quote_exceeded, and charges nothing', async () => {
    const paying = await buyer();

    const response = await fetch(linkTo('/v1/pricier'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(await errorOf(response)).toEqual([502, 'quote_exceeded']);
    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(await legOf((await paymentOf(paying.id))!.id)).toMatchObject({ status: 'failed' });
    // What was signed is the quoted price, never the higher one
    expect(paidRequests.filter(item => item.path === '/v1/pricier').map(item => item.amount)).toEqual(['1000']);
  });

  it('answers 503 when the Signer refuses, such as above its per-call maximum, and charges nothing', async () => {
    const paying = await buyer();

    expect(await errorOf(await fetch(linkTo('/v1/expensive'), { headers: { authorization: `Bearer ${paying.key}` } }))).toEqual([503, 'upstream_unavailable']);

    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(paidRequests.some(item => item.path === '/v1/expensive')).toBe(false);
  });

  it('pays no target while the Signer is down: 503, and the buyer isn\'t charged', async () => {
    const paying = await buyer();
    const switchedOff = createApp({
      config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, http,
      signer: createSignerClient({ url: 'http://127.0.0.1:9', secret: Secret.from(signerSecret), timeoutMs: 1_000 }),
    });
    const { port } = await switchedOff.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/${at('api.target.test')}/v1/signer-down`, { headers: { authorization: `Bearer ${paying.key}` } });

      expect(await errorOf(response)).toEqual([503, 'upstream_unavailable']);
      await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('released');
      expect(await balance(paying.id)).toBe(1_000_000n);
      expect(paidRequests.some(item => item.path === '/v1/signer-down')).toBe(false);
    }
    finally {
      await switchedOff.close();
    }
  });
});

describe('a target that fails after it was paid', () => {
  it('charges nothing for a target\'s 5xx, and answers an opaque 503', async () => {
    const paying = await buyer();
    const before = await platformBalances();

    const response = await fetch(linkTo('/v1/failing'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(await errorOf(response)).toEqual([503, 'upstream_unavailable']);
    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect(await legOf((await paymentOf(paying.id))!.id)).toMatchObject({ status: 'failed', lossBooked: false });
    expect((await platformBalances()).losses).toBe(before.losses);
  });

  it('passes a target\'s 4xx through without charging', async () => {
    const paying = await buyer();

    const response = await fetch(linkTo('/v1/missing'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such pool' });
    expect(response.headers.get('anyfare-receipt')).toBeNull();
    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
  });

  it('books a routing loss when a paid retry asks for a payment again but says it settled ours', async () => {
    const paying = await buyer();
    const before = await platformBalances();

    const response = await fetch(linkTo('/v1/kept-402'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(await errorOf(response)).toEqual([503, 'upstream_unavailable']);
    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('released');
    expect(await legOf((await paymentOf(paying.id))!.id)).toMatchObject({ status: 'settled', lossBooked: true, transactionHash: targetTransaction });
    expect((await platformBalances()).losses - before.losses).toBe(-1_000n);
  });

  it('books a routing loss when the target kept our payment for a failed call', async () => {
    const paying = await buyer();
    const before = await platformBalances();

    const response = await fetch(linkTo('/v1/broken'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(await errorOf(response)).toEqual([503, 'upstream_unavailable']);
    expect(await balance(paying.id)).toBe(1_000_000n);
    const row = await paymentOf(paying.id);
    expect(row).toMatchObject({ status: 'released' });
    expect(await legOf(row!.id)).toMatchObject({ status: 'settled', lossBooked: true, transactionHash: targetTransaction });
    expect((await platformBalances()).losses - before.losses).toBe(-1_000n);
  });
});

describe('a paid answer over the size limit', () => {
  // 16 KiB: the target's 64 KiB answers are over it
  const withCappedProxy = (work: (url: string) => Promise<void>) =>
    withProxy({ config: { ...config, sizeLimits: { ...config.sizeLimits, bufferedResponseBytes: 16 * 1024 } } }, work);

  it('cancels an x402 buyer\'s payment when the target\'s paid answer is too large to buffer, and books the routing loss', async () => {
    await withCappedProxy(async url => {
      const link = `${url}/${at('api.target.test')}/v1/huge-stream`;
      const signature = await payOnBase(link);
      const requestId = `routed-huge-${randomUUID()}`;
      const before = await platformBalances();

      const response = await fetch(link, { headers: { 'payment-signature': signature, 'x-request-id': requestId } });

      expect(await errorOf(response)).toEqual([502, 'response_too_large']);
      const [row] = await database.db.select().from(payments).where(eq(payments.requestId, requestId));
      expect(row).toMatchObject({ rail: 'x402', status: 'cancelled' });
      expect(await legOf(row!.id)).toMatchObject({ status: 'settled', lossBooked: true });
      expect((await platformBalances()).losses - before.losses).toBe(-1_000n);
    });
  });

  it('treats a 2xx that declares a body over the limit like one too large to buffer: not charged, the loss booked, 502', async () => {
    const paying = await buyer();
    const before = await platformBalances();

    await withCappedProxy(async url => {
      const response = await fetch(`${url}/${at('api.target.test')}/v1/huge-declared`, { headers: { authorization: `Bearer ${paying.key}` } });

      expect(await errorOf(response)).toEqual([502, 'response_too_large']);
      await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('released');
      expect(await legOf((await paymentOf(paying.id))!.id)).toMatchObject({ status: 'settled', lossBooked: true });
    });
    expect(await balance(paying.id)).toBe(1_000_000n);
    expect((await platformBalances()).losses - before.losses).toBe(-1_000n);
  });

  it('streams a credits buyer\'s answer under the limit, and still captures one that breaks off midway: the decision was billable', async () => {
    const paying = await buyer();

    const response = await fetch(linkTo('/v1/breaks'), { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('captured');
    expect(await balance(paying.id)).toBe(1_000_000n - 1_100n);
  });
});

describe('the per-IP limits', () => {
  // A Redis of its own for each test, so the caches are cold and the counters start at 0
  const withOwnRedis = async (limits: Partial<PlatformConfig['rateLimits']>, work: (url: string) => Promise<void>): Promise<void> => {
    const own = await createTestRedis();
    try {
      await withProxy({ config: { ...config, rateLimits: { ...config.rateLimits, ...limits } }, redis: own }, work);
    }
    finally {
      await own.cleanup();
    }
  };

  it('counts a paying buyer\'s probes, never against the unpaid limit', async () => {
    const paying = await buyer();

    await withOwnRedis({ unpaidIp: { requests: 2, windowSeconds: 60 } }, async url => {
      for (let call = 1; call <= 5; call++) {
        const response = await fetch(`${url}/${at('api.target.test')}/v1/paying?call=${call}`, { headers: { authorization: `Bearer ${paying.key}` } });

        expect(response.status).toBe(200);
      }
    });
    await expect.poll(async () => (await database.db.select().from(payments).where(eq(payments.buyerAccountId, paying.id))).length).toBe(5);
  });

  it('refuses the 601st probe from one IP in a minute before any request leaves, whatever the target answered or the credential; a cached quote costs nothing', async () => {
    const paying = await buyer();
    expect(config.rateLimits.probeIp).toEqual({ requests: 600, windowSeconds: 60 });

    await withOwnRedis({}, async url => {
      const link = (path: string) => `${url}/${at('api.target.test')}${path}`;
      expect((await fetch(link('/v1/probed'))).status).toBe(402);
      // Targets that don't answer 402 count too
      for (let batch = 0; batch < 599; batch += 50) {
        const calls = Array.from({ length: Math.min(50, 599 - batch) }, (_, index) => fetch(link(`/v1/free?call=${batch + index}`)));
        expect(new Set((await Promise.all(calls)).map(response => response.status))).toEqual(new Set([400]));
      }
      const sent = target.requests.length;

      const refused = await fetch(link('/v1/free?call=601'), { headers: { authorization: 'Bearer junk' } });

      expect(await errorOf(refused)).toEqual([429, 'rate_limited']);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(target.requests.length).toBe(sent);
      // The quote is cached: a paid call on it isn't counted
      expect((await fetch(link('/v1/probed'), { headers: { authorization: `Bearer ${paying.key}` } })).status).toBe(200);
    });
  });
});

describe('a buyer who leaves during the target call', () => {
  // Starts the call, waits until the target holds the paid retry, then hangs up and lets the target answer
  const leaveDuring = async (link: string, headers: Record<string, string>, requestId: string): Promise<void> => {
    const controller = new AbortController();
    const pending = fetch(link, { headers: { ...headers, 'x-request-id': requestId }, signal: controller.signal }).catch(() => undefined);
    await expect.poll(() => gates.has(requestId)).toBe(true);
    controller.abort();
    await pending;
    // The proxy hears the connection close
    await sleep(100);
    gates.get(requestId)!();
  };

  it('charges a credits buyer nothing, and books the loss: the target kept our payment', async () => {
    const paying = await buyer();
    const before = await platformBalances();

    await leaveDuring(linkTo('/v1/slow-paid'), { authorization: `Bearer ${paying.key}` }, `gone-credits-${randomUUID()}`);

    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('released');
    expect(await balance(paying.id)).toBe(1_000_000n);
    await expect.poll(async () => (await legOf((await paymentOf(paying.id))!.id))?.lossBooked).toBe(true);
    expect(await legOf((await paymentOf(paying.id))!.id)).toMatchObject({ status: 'settled' });
    expect((await platformBalances()).losses - before.losses).toBe(-1_000n);
  });

  it('never settles an x402 buyer who left: cancelled, and the loss booked', async () => {
    const requestId = `gone-x402-${randomUUID()}`;
    const signature = await payOnBase(linkTo('/v1/slow-paid'));
    const settles = facilitator.requests.filter(request => request.path === '/settle').length;

    await leaveDuring(linkTo('/v1/slow-paid'), { 'payment-signature': signature }, requestId);

    await expect.poll(async () => (await database.db.select().from(payments).where(eq(payments.requestId, requestId)))[0]?.status).toBe('cancelled');
    const [row] = await database.db.select().from(payments).where(eq(payments.requestId, requestId));
    await expect.poll(async () => (await legOf(row!.id))?.lossBooked).toBe(true);
    expect(facilitator.requests.filter(request => request.path === '/settle').length).toBe(settles);
    expect(lineOf(requestId, 'The buyer left before the answer: not charged')).toMatchObject({ targetStatus: 200, targetLeg: 'settled' });
  });
});

describe('a target leg that can\'t be recorded', () => {
  it.each([
    ['a target\'s 5xx', '/v1/failing', 503, 'released'],
    ['a refused paid retry', '/v1/pricier', 502, 'released'],
    ['a 2xx', '/v1/pools', 200, 'captured'],
  ])('still finishes the buyer\'s payment after %s', async (_case, path, status, paymentStatus) => {
    const real = createRoutingRepository({ db: database.db, clock: systemClock });
    let failures = 1;
    const flaky = {
      ...real,
      updateTargetPayment: async (...args: Parameters<typeof real.updateTargetPayment>) => {
        if (failures-- > 0)
          throw new Error('Connection terminated unexpectedly');

        return real.updateTargetPayment(...args);
      },
    };
    const paying = await buyer();

    await withProxy({ routingRepository: flaky }, async url => {
      const response = await fetch(`${url}/${at('api.target.test')}${path}`, { headers: { authorization: `Bearer ${paying.key}` } });

      expect(response.status).toBe(status);
      await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe(paymentStatus);
    });
    expect(failures).toBe(0);
  });
});

describe('the paid retry\'s failures', () => {
  let nextError: () => Error;
  // The target's real answers, except the paid retry, which fails as `nextError` says
  const failingRetry: Pick<OutboundHttp, 'request'> = {
    request: async request => {
      if (request.headers !== undefined && 'payment-signature' in request.headers)
        throw nextError();

      return http.request(request);
    },
  };

  it.each([
    ['a blocked address: nothing was sent', () => new BlockedAddressError('api.target.test', '10.0.0.1', 'a private address'), 'failed'],
    ['a refused connection: nothing was sent', () => new ConnectionFailedError('api.target.test', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }), 'failed'],
    ['a connect timeout: nothing was sent', () => new OutboundTimeoutError('api.target.test', 'connect', 5_000), 'failed'],
    ['a timeout after the send', () => new OutboundTimeoutError('api.target.test', 'total', 30_000), 'unknown'],
    ['a reset after the send', () => new ConnectionFailedError('api.target.test', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }), 'unknown'],
    ['a certificate refused in the handshake: nothing was sent', () => new ConnectionFailedError('api.target.test', { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) }), 'failed'],
    ['a bad TLS record after the send', () => new ConnectionFailedError('api.target.test', {
      cause: Object.assign(new Error('decryption failed or bad record mac'), { code: 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC' }),
    }), 'unknown'],
  ])('records the leg after %s, and charges nothing', async (_case, error, targetLeg) => {
    nextError = error;
    const paying = await buyer();

    await withProxy({ http: failingRetry }, async url => {
      const response = await fetch(`${url}/${at('api.target.test')}/v1/retry-fails`, { headers: { authorization: `Bearer ${paying.key}` } });

      expect(await errorOf(response)).toEqual([503, 'upstream_unavailable']);
    });
    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('released');
    expect(await legOf((await paymentOf(paying.id))!.id)).toMatchObject({ status: targetLeg });
  });
});

describe('an x402 buyer\'s deadline', () => {
  it('keeps the target call under the payment\'s validBefore, less the time its settle needs', async () => {
    const requestId = `x402-deadline-${randomUUID()}`;
    const validBefore = Math.floor(systemClock.now().getTime() / 1_000) + 20;
    const signature = validUntil(await payOnBase(linkTo('/v1/x402-deadline')), validBefore);

    const paid = await fetch(linkTo('/v1/x402-deadline'), { headers: { 'payment-signature': signature, 'x-request-id': requestId } });

    expect(paid.status).toBe(200);
    const timeoutMs = lineOf(requestId, 'Routed call answered')!['timeoutMs'] as number;
    expect(timeoutMs).toBeLessThanOrEqual(validBefore * 1_000 - systemClock.now().getTime() - settleMarginMs + 1_000);
    expect(timeoutMs).toBeLessThan(config.timeouts.requestMs);
    expect(timeoutMs).toBeGreaterThan(0);
  });

  it('refuses a payment that expires in 10 seconds before the target is paid: its settle could fail after the answer', async () => {
    const before = paidRequests.length;
    const signature = validUntil(await payOnBase(linkTo('/v1/x402-short')), Math.floor(systemClock.now().getTime() / 1_000) + 10);

    const refused = await fetch(linkTo('/v1/x402-short'), { headers: { 'payment-signature': signature } });

    expect(await errorOf(refused)).toEqual([402, 'payment_invalid']);
    expect(paidRequests.length).toBe(before);
  });
});

describe('paid answers', () => {
  it('are private to their buyer, credits and x402 alike: the target\'s public gives way, its max-age stays', async () => {
    const paying = await buyer();
    const viaKey = await fetch(linkTo('/v1/private-key'), { headers: { authorization: `Bearer ${paying.key}` } });
    const signature = await payOnBase(linkTo('/v1/private-x402'));
    const viaX402 = await fetch(linkTo('/v1/private-x402'), { headers: { 'payment-signature': signature } });

    expect([viaKey.status, viaX402.status]).toEqual([200, 200]);
    expect(viaKey.headers.get('cache-control')).toBe('max-age=60, private');
    expect(viaX402.headers.get('cache-control')).toBe('max-age=60, private');
  });

  it('bill a HEAD and a 204 like any 2xx, credits and x402 alike', async () => {
    const paying = await buyer();

    const head = await fetch(linkTo('/v1/head'), { method: 'HEAD', headers: { authorization: `Bearer ${paying.key}` } });
    const empty = await fetch(linkTo('/v1/no-content'), { headers: { authorization: `Bearer ${paying.key}` } });
    const requestId = `no-content-x402-${randomUUID()}`;
    const signature = await payOnBase(linkTo('/v1/no-content'));
    const emptyX402 = await fetch(linkTo('/v1/no-content'), { headers: { 'payment-signature': signature, 'x-request-id': requestId } });

    expect([head.status, empty.status, emptyX402.status]).toEqual([200, 204, 204]);
    expect(await head.text()).toBe('');
    expect(head.headers.get('anyfare-receipt')).toContain('amount="0.0011"');
    expect(emptyX402.headers.get('payment-response')).not.toBeNull();
    await expect.poll(async () => (await database.db.select().from(payments).where(eq(payments.buyerAccountId, paying.id))).map(row => row.status))
      .toEqual(['captured', 'captured']);
    expect(await balance(paying.id)).toBe(1_000_000n - 2_200n);
    expect((await database.db.select().from(payments).where(eq(payments.requestId, requestId)))[0]).toMatchObject({ rail: 'x402', status: 'settled' });
  });

  it('never reach an x402 buyer whose settlement fails after the target was paid: the leg stays for the routing loss job', async () => {
    const link = linkTo('/v1/drained');
    const signature = await payOnBase(link);
    const requestId = `drained-${randomUUID()}`;
    facilitator.handle('/settle', facilitatorAnswers.failed('insufficient_funds'));
    let response: Response;
    try {
      response = await fetch(link, { headers: { 'payment-signature': signature, 'x-request-id': requestId } });
    }
    finally {
      facilitator.reset();
    }

    expect(await errorOf(response)).toEqual([502, 'settlement_failed']);
    const [row] = await database.db.select().from(payments).where(eq(payments.requestId, requestId));
    expect(row).toMatchObject({ rail: 'x402', status: 'failed' });
    expect(await legOf(row!.id)).toMatchObject({ status: 'settled', lossBooked: false, buyerCharged: false });
    expect(lineOf(requestId, 'A routed buyer\'s settlement failed after the target was paid')).toMatchObject({ level: 40, rail: 'x402' });
  });
});

describe('TRACE', () => {
  it('isn\'t routed: it would echo our payment header', async () => {
    const before = target.requests.length;
    const { port } = new URL(proxyUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const traced = httpRequest({ host: '127.0.0.1', port, method: 'TRACE', path: `/${at('api.target.test')}/v1/pools` }, answer => {
        answer.resume();
        resolve(answer.statusCode ?? 0);
      });
      traced.on('error', reject);
      traced.end();
    });

    expect(status).toBe(404);
    expect(target.requests.length).toBe(before);
  });
});

describe('GET /_/check', () => {
  it('quotes a link without paying, and says why one isn\'t payable', async () => {
    const paidBefore = paidRequests.length;

    const answer = await (await fetch(`${proxyUrl}/_/check?url=${encodeURIComponent(`https://${at('api.target.test')}/v1/pools?limit=5`)}`)).json();
    const bare = await (await fetch(`${proxyUrl}/_/check?url=${encodeURIComponent(`${at('api.target.test')}/v1/pools`)}`)).json();
    const refused = await (await fetch(`${proxyUrl}/_/check?url=${at('optout.target.test')}/v1/pools`)).json();
    const free = await (await fetch(`${proxyUrl}/_/check?url=${at('api.target.test')}/v1/free`)).json();
    const nothing = await (await fetch(`${proxyUrl}/_/check`)).json();

    expect(answer).toEqual({
      payable: true,
      target: `https://${at('api.target.test')}/v1/pools?limit=5`,
      price: { amount: '0.001', currency: 'USD', asset: 'base-usdc', network: base },
      quote: { amount: '0.0011', fee: '0.0001', currency: 'USD' },
      link: `${config.urls.pay}/${at('api.target.test')}/v1/pools?limit=5`,
    });
    expect(bare).toMatchObject({ payable: true, link: `${config.urls.pay}/${at('api.target.test')}/v1/pools` });
    expect(refused).toMatchObject({ payable: false, reason: 'host_not_allowed' });
    expect(free).toMatchObject({ payable: false, reason: 'not_payable' });
    expect(nothing).toMatchObject({ payable: false, reason: 'invalid_target' });
    expect(paidRequests.length).toBe(paidBefore);
  });
});

describe('GET /_/key', () => {
  it('answers a payment key\'s limits and what\'s left of them', async () => {
    const paying = await buyer();
    await fetch(linkTo('/v1/pools'), { headers: { authorization: `Bearer ${paying.key}` } });
    await expect.poll(async () => (await paymentOf(paying.id))?.status).toBe('captured');

    const response = await fetch(`${proxyUrl}/_/key`, { headers: { authorization: `Bearer ${paying.key}` } });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      id: paying.keyId, label: null, allowance: null, dailyBudget: '5', maxPrice: null, expiresAt: null, createdAt: expect.any(String),
      spent: { today: '0.0011', total: '0.0011' },
      remaining: { allowance: null, dailyBudget: '4.9989', balance: '0.9989' },
    });
  });

  it('answers 401 without a payment key, with a master key, and with an unknown one, naming the Bearer scheme', async () => {
    const master = generateApiKey('master', config.keyPrefixes).expose();
    const unknown = generateApiKey('payment', config.keyPrefixes).expose();

    for (const [headers, code] of [[{}, 'unauthorized'], [{ authorization: `Bearer ${master}` }, 'wrong_key_type'], [{ authorization: `Bearer ${unknown}` }, 'invalid_key']] as const) {
      const response = await fetch(`${proxyUrl}/_/key`, { headers });

      expect(await errorOf(response)).toEqual([401, code]);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
  });
});

describe('the pay host\'s own answers', () => {
  it('sets the CORS and security headers on every answer, and answers a preflight without reaching the target', async () => {
    const before = target.requests.length;
    const preflight = await fetch(linkTo('/v1/pools'), {
      method: 'OPTIONS', headers: { origin: 'https://agent.example', 'access-control-request-method': 'POST' },
    });
    const unpaid = await fetch(linkTo('/v1/pools'));

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Authorization, PAYMENT-SIGNATURE, X-PAYMENT, Content-Type');
    for (const response of [preflight, unpaid]) {
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-expose-headers'))
        .toBe('PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate, Payment-Receipt, Anyfare-Receipt, x-request-id');
      expect(response.headers.get('content-security-policy')).toBe('sandbox');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect(target.requests.length - before).toBeLessThanOrEqual(1);
  });

  it('keeps its own paths: robots.txt, and 404 for the rest of them', async () => {
    const robots = await fetch(`${proxyUrl}/robots.txt`);

    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
    expect(await errorOf(await fetch(`${proxyUrl}/_/unknown`))).toEqual([404, 'not_found']);
    expect(await errorOf(await fetch(`${proxyUrl}/favicon.ico`))).toEqual([404, 'not_found']);
    expect(await errorOf(await fetch(`${proxyUrl}/.well-known/anyfare.json`))).toEqual([404, 'not_found']);
    expect(await (await fetch(`${proxyUrl}/_/ready`)).json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok', 'facilitator:cdp': 'ok' } });
  });

  it('counts routed calls by outcome and target calls by status, with no host in any label', async () => {
    const metrics = await (await fetch(metricsUrl)).text();

    for (const outcome of ['quoted', 'paid', 'refused_host', 'not_payable', 'unsupported', 'signer_refused', 'target_refused', 'loss'])
      expect(metrics).toMatch(new RegExp(`proxy_routing_total\\{outcome="${outcome}"\\} [1-9]`));
    expect(metrics).toMatch(/proxy_upstream_request_duration_seconds_count\{status="402"\} [1-9]/);
    expect(metrics).toMatch(/proxy_payments_total\{rail="credits",outcome="captured"\} [1-9]/);
    expect(metrics).toMatch(/proxy_key_cache_lookups_total\{result="hit"\} [1-9]/);
    expect(metrics).not.toContain('target.test');
  });
});
