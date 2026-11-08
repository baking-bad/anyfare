import { decodePaymentSignatureHeader } from '@x402/core/http';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret, type Server } from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createRedis, signatures } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, fixtureTime, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp } from '../../src/app.js';
import { spendKeyPrefix } from '../../src/spend.js';
import { startSigner } from '../../src/start.js';

const secret = 'signer-secret-0123456789abcdef-0123456789';
const base = 'eip155:84532';
const payTo = '0x2222222222222222222222222222222222222222';
const resource = 'https://api.target.test/v1/price';
const clock = createFakeClock(fixtureTime(0, 9, 10, 15, 0, 0));

// $0.05 per call, $0.06 an hour, $0.10 a day: small, so the tests reach them
const config: PlatformConfig = await loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({ signer: { maxPerCall: '0.05', maxPerNetworkPerHour: '0.06', maxPerNetworkPerDay: '0.1' } })).toString('base64'),
  },
});
let database: TestDatabase;
let redis: TestRedis;
let server: Server;
let noWallet: Server;
let url: string;
let metricsUrl: string;
let noWalletUrl: string;
const walletKey = generatePrivateKey();
const wallet = privateKeyToAccount(walletKey);
// Every line the Signer writes, debug included
const lines: Record<string, unknown>[] = [];
const capture = () => createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
const lastLine = (msg: string): Record<string, unknown> | undefined => lines.filter(line => line['msg'] === msg).at(-1);

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  const dependencies = { config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), clock };
  server = createApp({ ...dependencies, wallets: { base: wallet } });
  noWallet = createApp({ ...dependencies, wallets: {} });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [ports, noWalletPorts] = await Promise.all([server.listen(listen), noWallet.listen(listen)]);
  url = `http://127.0.0.1:${ports.port}`;
  metricsUrl = `http://127.0.0.1:${ports.metricsPort}/metrics`;
  noWalletUrl = `http://127.0.0.1:${noWalletPorts.port}`;
});

afterAll(async () => {
  await Promise.all([server?.close(), noWallet?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const option = (amount: string, overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: base, amount, asset: findAsset(config, 'base-usdc')!.address, payTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' }, ...overrides,
});

// A null key: no x-signer-secret header
const post = async (body: unknown, { key = secret as string | null, at = url } = {}) => {
  const response = await fetch(`${at}/internal/v1/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...key === null ? {} : { 'x-signer-secret': key } },
    body: JSON.stringify(body),
  });

  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
};

const signBody = (amount: string, quotedPrice = amount, overrides: Record<string, unknown> = {}) => ({
  requestId: 'req-1', quoteId: `pay_${amount}_${Math.random()}`, x402Version: 2, requirement: option(amount, overrides), resource: { url: resource }, url: resource, quotedPrice,
});

const sign = async (amount: string, { quotedPrice = amount, overrides = {}, key = secret, at = url } = {} as { quotedPrice?: string; overrides?: Record<string, unknown>; key?: string; at?: string }) =>
  post(signBody(amount, quotedPrice, overrides), { key, at });

// The spend windows follow Redis's clock: a test starts a new hour, or a new day, by clearing their counters
const startNew = async (window: 'hour' | 'day'): Promise<void> => {
  for await (const keys of redis.client.scanIterator({ MATCH: `${redis.prefix}${spendKeyPrefix}*${window === 'hour' ? ':hour:*' : ''}`, COUNT: 100 })) {
    if (keys.length > 0)
      await redis.client.unlink(keys);
  }
};

// The day's counter of a network, in micro-USD
const spentToday = async (network: string): Promise<bigint> => {
  let total = 0n;
  for await (const keys of redis.client.scanIterator({ MATCH: `${redis.prefix}${spendKeyPrefix}${network}:day:*`, COUNT: 100 })) {
    for (const key of keys)
      total += BigInt(await redis.client.get(key) ?? '0');
  }

  return total;
};

const spentOnBase = async (): Promise<number> => {
  const match = /signer_spend_usd_total\{network="eip155:84532"\} (\S+)/.exec(await (await fetch(metricsUrl)).text());

  return match ? Number(match[1]) : 0;
};

describe('the Signer\'s shared secret', () => {
  it('refuses a request without the x-signer-secret header, or with a wrong one, with 401', async () => {
    for (const key of [null, '', 'wrong', `${secret}x`]) {
      const refused = await post(signBody('1000'), { key });

      expect(refused).toMatchObject({ status: 401, body: { error: { code: 'unauthorized', message: 'The Signer needs the x-signer-secret header' } } });
      expect(refused.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('refuses every request when the Signer has no secret', async () => {
    const open = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, secret: undefined, wallets: { base: wallet }, clock });
    const { port } = await open.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
    try {
      expect((await post(signBody('1000'), { at: `http://127.0.0.1:${port}` })).status).toBe(401);
    }
    finally {
      await open.close();
    }
  });

  it('answers readiness with Postgres and Redis', async () => {
    expect(await (await fetch(`${url}/_/ready`)).json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });
});

describe('the sign request\'s body', () => {
  const { quoteId: _quoteId, ...withoutQuote } = signBody('1000');
  const { url: _url, ...withoutUrl } = signBody('1000');
  const { quotedPrice: _quotedPrice, ...withoutPrice } = signBody('1000');
  const { requirement: _requirement, ...withoutRequirement } = signBody('1000');

  it.each([
    ['without quoteId', withoutQuote],
    ['without url', withoutUrl],
    ['without quotedPrice', withoutPrice],
    ['with quotedPrice as a number', { ...signBody('1000'), quotedPrice: 1000 }],
    ['with quotedPrice in USD', { ...signBody('1000'), quotedPrice: '0.001' }],
    ['with an unknown field', { ...signBody('1000'), amount: '1000' }],
    ['with another protocol', { ...signBody('1000'), protocol: 'lightning' }],
    ['with x402Version 1', { ...signBody('1000'), x402Version: 1 }],
    ['with x402Version 3', { ...signBody('1000'), x402Version: 3 }],
    ['with an empty challenge', { protocol: 'mpp', quoteId: 'pay_mpp', url: resource, quotedPrice: '1000', challenge: '' }],
  ])('answers 400 invalid_request %s', async (_name, body) => {
    expect(await post(body)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });

  it.each([
    ['an x402 payment without its requirement', withoutRequirement, 'An x402 payment needs x402Version and the requirement'],
    ['an MPP payment without its challenge', { protocol: 'mpp', quoteId: 'pay_mpp', url: resource, quotedPrice: '1000' }, 'An MPP payment needs the target\'s challenge'],
    ['a URL that isn\'t HTTPS', { ...signBody('1000'), url: 'http://api.target.test/v1/price' }, 'url must be an HTTPS URL'],
  ])('answers 400 for %s', async (_name, body, message) => {
    expect(await post(body)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request', message } } });
  });
});

describe('the Signer on Base', () => {
  it('signs an EIP-3009 authorization with the official client, within the quote, and records it', async () => {
    const before = await spentOnBase();

    const signed = await sign('10000');
    const { payload } = decodePaymentSignatureHeader(signed.body['header']) as unknown as { payload: { authorization: Record<string, string>; signature: string } };
    const now = Math.floor(Date.now() / 1_000);
    const [record] = await database.db.select().from(signatures).where(eq(signatures.id, signed.body['signatureId']));

    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ signatureId: expect.stringMatching(/^sig_/), network: base, asset: 'base-usdc', atomicAmount: '10000', amount: '10000', payTo });
    expect(payload.authorization).toMatchObject({ from: wallet.address, to: payTo, value: '10000', validAfter: '0' });
    // Valid for the option's 60 seconds from now
    expect(Number(payload.authorization['validBefore'])).toBeGreaterThanOrEqual(now + 58);
    expect(Number(payload.authorization['validBefore'])).toBeLessThanOrEqual(now + 61);
    expect(payload.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(record).toMatchObject({
      requestId: 'req-1', protocol: 'x402', network: base, asset: 'base-usdc', atomicAmount: 10_000n, amount: 10_000n, payTo, resource, createdAt: clock.now(),
    });
    expect(await spentOnBase() - before).toBeCloseTo(0.01, 9);
  });

  it('refuses in order: not exact, not in the registry, no wallet, an invalid amount, above the quote, above the per-call maximum', async () => {
    const refusal = async (result: Promise<{ status: number; body: Record<string, any> }>) => {
      const { status, body } = await result;

      return { status, message: body['error']?.['message'] as string | undefined, reason: lastLine('Refused to sign a routed payment')?.['reason'] };
    };

    expect(await refusal(sign('1000', { overrides: { scheme: 'upto', network: 'eip155:1' } })))
      .toEqual({ status: 422, message: 'Only exact x402 options can be signed', reason: 'not_exact' });
    expect(await refusal(sign('1000', { overrides: { asset: '0x3333333333333333333333333333333333333333' } })))
      .toEqual({ status: 422, message: 'The network and asset aren\'t in the registry', reason: 'not_in_registry' });
    expect(await refusal(sign('1000', { overrides: { network: 'eip155:1' } })))
      .toEqual({ status: 422, message: 'The network and asset aren\'t in the registry', reason: 'not_in_registry' });
    expect(await refusal(sign('nope', { quotedPrice: '1000', at: noWalletUrl })))
      .toEqual({ status: 422, message: 'The Signer holds no wallet on Base Sepolia', reason: 'no_wallet' });
    expect(await refusal(sign('nope', { quotedPrice: '1000' })))
      .toEqual({ status: 422, message: 'The option has no valid amount', reason: 'invalid_amount' });
    expect(await refusal(sign('0')))
      .toEqual({ status: 422, message: 'The option has no valid amount', reason: 'invalid_amount' });
    expect(await refusal(sign('60000', { quotedPrice: '59999' })))
      .toEqual({ status: 422, message: 'The amount is above the quoted price', reason: 'above_quote' });
    expect(await refusal(sign('60000')))
      .toEqual({ status: 422, message: 'The amount is above the per-call maximum', reason: 'above_max_per_call' });
  });

  it('stops at the spend limits per network: the hour first, then the day, and none of the refusals above counted', async () => {
    // $0.01 was signed above: $0.05 more fills the hour's $0.06
    expect((await sign('50000')).status).toBe(200);
    expect(await sign('1000')).toMatchObject({ status: 422, body: { error: { code: 'signing_refused', message: 'The hourly spend limit is reached' } } });
    await startNew('hour');
    expect((await sign('30000')).status).toBe(200);
    expect(await sign('20000')).toMatchObject({ status: 422, body: { error: { message: 'The daily spend limit is reached' } } });
  });

  it.each([
    ['maxTimeoutSeconds as the string "99"', { maxTimeoutSeconds: '99' }, 'invalid_timeout', 'The option\'s maxTimeoutSeconds isn\'t a whole number from 1 to 300'],
    ['maxTimeoutSeconds of 1e9', { maxTimeoutSeconds: 1e9 }, 'invalid_timeout', 'The option\'s maxTimeoutSeconds isn\'t a whole number from 1 to 300'],
    ['Permit2', { extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } }, 'transfer_method', 'The option asks for another transfer method than EIP-3009'],
    ['no EIP-712 domain', { extra: {} }, 'invalid_option', 'The option asks for what the Signer doesn\'t sign: another payment flow, no EIP-712 domain, or Solana fields it can\'t build'],
    ['a payTo that isn\'t an address', { payTo: '0x2222' }, 'invalid_pay_to', 'The option\'s payTo isn\'t an address on its network'],
  ])('refuses %s before the spend limits count it', async (_name, overrides, reason, message) => {
    await startNew('day');

    expect(await sign('1000', { overrides })).toMatchObject({ status: 422, body: { error: { code: 'signing_refused', message } } });
    expect(lastLine('Refused to sign a routed payment')).toMatchObject({ result: 'refused', reason });
    expect(await spentToday(base)).toBe(0n);
  });

  it('signs an authorization valid for maxTimeoutSeconds of 300 at most', async () => {
    await startNew('day');

    const signed = await sign('1000', { overrides: { maxTimeoutSeconds: 300 } });
    const { payload } = decodePaymentSignatureHeader(signed.body['header']) as unknown as { payload: { authorization: Record<string, string> } };

    expect(Number(payload.authorization['validBefore'])).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 300);
  });
});

describe('the Signer without its stores', () => {
  it('answers 503 redis_not_ready while Redis is down, and signs nothing', async () => {
    // Port 1 refuses connections, so the client keeps reconnecting
    const down = createRedis({ url: Secret.from('redis://127.0.0.1:1'), logger: createLogger({ level: 'silent' }) });
    const app = createApp({ config, logger: capture(), postgres: database.postgres, redis: down, secret: Secret.from(secret), wallets: { base: wallet }, clock });
    const { port } = await app.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
    try {
      const at = `http://127.0.0.1:${port}`;

      expect(await sign('1000', { at })).toMatchObject({ status: 503, body: { error: { code: 'redis_not_ready', message: 'Redis is not connected' } } });
      expect((await fetch(`${at}/_/ready`)).status).toBe(503);
    }
    finally {
      await app.close();
      await down.close();
    }
  });

  it('returns no payment when its signature can\'t be recorded, keeps the reservation, and logs the error', async () => {
    await startNew('day');
    const app = createApp({
      config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), wallets: { base: wallet }, clock,
      signatures: { recordSignature: async () => { throw new Error('the signatures table is unavailable'); } },
    });
    const { port } = await app.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
    try {
      const unrecorded = await sign('10000', { at: `http://127.0.0.1:${port}` });

      expect(unrecorded).toMatchObject({ status: 500, body: { error: { code: 'internal_error' } } });
      expect(unrecorded.body).not.toHaveProperty('header');
    }
    finally {
      await app.close();
    }
    // Nothing was paid, but the limits count it: more than was signed, never less
    expect(await spentToday(base)).toBe(10_000n);
    expect(lastLine('Request failed')).toMatchObject({ level: 50, error: { message: 'the signatures table is unavailable' } });
  });
});

describe('the Signer\'s lines', () => {
  const signAs = async (requestId: string, amount: string, quotedPrice = amount) => {
    const response = await fetch(`${url}/internal/v1/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signer-secret': secret, 'x-request-id': requestId },
      body: JSON.stringify({ requestId, quoteId: `pay_${requestId}`, x402Version: 2, requirement: option(amount), resource: { url: resource }, url: resource, quotedPrice }),
    });

    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const linesOf = (requestId: string) => lines.filter(line => line['requestId'] === requestId);

  it('logs each sign request at info with its request ID, quote, network, asset, amount, payTo, and result, never the signature', async () => {
    // A new day: fresh spend windows
    await startNew('day');

    const signed = await signAs('sign-log-1', '10000');
    const refused = await signAs('sign-log-2', '20000', '19999');

    expect(signed.status).toBe(200);
    expect(linesOf('sign-log-1').find(line => line['msg'] === 'Signed a routed payment')).toMatchObject({
      level: 30, quoteId: 'pay_sign-log-1', protocol: 'x402', network: base, asset: 'base-usdc', amount: '0.01', atomicAmount: '10000', payTo,
      signatureId: signed.body['signatureId'], result: 'signed', durationMs: expect.any(Number),
    });
    expect(linesOf('sign-log-1').find(line => line['msg'] === 'Signed a routed payment')).not.toHaveProperty('maxFee');
    expect(refused.status).toBe(422);
    expect(linesOf('sign-log-2').find(line => line['msg'] === 'Refused to sign a routed payment')).toMatchObject({
      level: 30, quoteId: 'pay_sign-log-2', protocol: 'x402', network: base, atomicAmount: '20000', payTo, quotedPrice: '0.019999', result: 'refused',
      reason: 'above_quote', message: 'The amount is above the quoted price',
    });
    expect(JSON.stringify(lines)).not.toContain(signed.body['header']);
  });

  it('logs a spend limit\'s refusal with the window\'s total against its limit, and alerts', async () => {
    await startNew('day');
    expect((await signAs('spend-log-1', '50000')).status).toBe(200);

    expect((await signAs('spend-log-2', '20000')).status).toBe(422);

    expect(linesOf('spend-log-2').find(line => line['msg'] === 'The Signer refused a payment: a spend limit is reached')).toMatchObject({
      level: 50, network: base, refusal: 'hourly_limit', amount: '0.02', window: 'hour', spent: '0.05', limit: '0.06', alert: true,
    });
    expect(linesOf('spend-log-2').find(line => line['msg'] === 'Refused to sign a routed payment')).toMatchObject({
      level: 30, result: 'refused', reason: 'hourly_limit', window: 'hour', spent: '0.05', limit: '0.06',
    });
  });

  it('logs the day\'s total against the daily limit when the day refuses', async () => {
    await startNew('day');
    expect((await signAs('day-log-1', '50000')).status).toBe(200);
    await startNew('hour');
    expect((await signAs('day-log-2', '40000')).status).toBe(200);
    await startNew('hour');

    expect((await signAs('day-log-3', '20000')).status).toBe(422);

    expect(linesOf('day-log-3').find(line => line['msg'] === 'The Signer refused a payment: a spend limit is reached')).toMatchObject({
      level: 50, network: base, refusal: 'daily_limit', amount: '0.02', window: 'day', spent: '0.09', limit: '0.1', alert: true,
    });
  });

  it('never logs the shared secret, the wallet\'s key, or a signed payment', async () => {
    await startNew('day');
    const signed = await signAs('secrets-1', '1000');
    await fetch(`${url}/internal/v1/sign`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signer-secret': 'wrong-secret-value' }, body: '{}' });

    const logged = JSON.stringify(lines);
    for (const value of [secret, walletKey, walletKey.slice(2), signed.body['header'], 'wrong-secret-value'])
      expect(logged).not.toContain(value);
  });
});

describe('the Signer\'s startup', () => {
  const envOf = (extra: Record<string, string> = {}) => ({
    CONFIG_PATH: 'config/example.yaml', SIGNER_SECRET: secret, SIGNER_BASE_KEY: walletKey, DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose(),
    HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0', ...extra,
  });

  it('logs one line with the commit, its wallet\'s address, and its limits, at LOG_LEVEL, never the key or the secret', async () => {
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });
    const env = envOf({ LOG_LEVEL: 'warn', GIT_SHA: '0123456789abcdef0123456789abcdef01234567' });

    const app = await startSigner({ env: { ...env, LOG_LEVEL: 'info' }, logger });
    await app.close();
    const quiet = await startSigner({ env, logger });
    await quiet.close();

    expect(startLines.filter(line => line['msg'] === 'Started')).toEqual([expect.objectContaining({
      level: 30, app: 'signer', commit: '0123456789abcdef0123456789abcdef01234567', logLevel: 'info', environment: 'staging',
      wallets: { base: wallet.address, tempo: null, solana: null }, solanaRpc: null,
      limits: { maxPerCall: '1', maxPerNetworkPerHour: null, maxPerNetworkPerDay: '100' }, ports: { port: expect.any(Number), metricsPort: expect.any(Number) },
    })]);
    expect(logger.level).toBe('warn');
    const logged = JSON.stringify(startLines);
    for (const value of [secret, walletKey, walletKey.slice(2), database.url.expose(), redis.url.expose()])
      expect(logged).not.toContain(value);
  });

  it('warns when it has no wallet', async () => {
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });

    const app = await startSigner({ env: envOf({ SIGNER_BASE_KEY: '' }), logger });
    await app.close();

    expect(startLines.find(line => line['level'] === 40)).toMatchObject({ msg: expect.stringMatching(/^The Signer has no wallet/) });
    expect(startLines.find(line => line['msg'] === 'Started')).toMatchObject({ wallets: { base: null, tempo: null, solana: null } });
  });

  it('won\'t start without SIGNER_SECRET, or with one shorter than 32 characters, or with a Base key that isn\'t one', async () => {
    const logger = createLogger({ level: 'silent' });

    await expect(startSigner({ env: envOf({ SIGNER_SECRET: '' }), logger })).rejects.toThrow('Secret SIGNER_SECRET is not set');
    await expect(startSigner({ env: envOf({ SIGNER_SECRET: 'a'.repeat(31) }), logger })).rejects.toThrow('SIGNER_SECRET must be at least 32 characters');
    await expect(startSigner({ env: envOf({ SIGNER_BASE_KEY: walletKey.slice(2) }), logger })).rejects.toThrow('SIGNER_BASE_KEY must be 0x and 64 hex characters');
  });
});
