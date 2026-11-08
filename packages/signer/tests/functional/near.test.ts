import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { createClientNearSigner, decodeSignedDelegateB64, parseFtTransferArgs } from '@x402/near';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, Secret, type Server } from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createRedis, signatures } from '@anyfare/db';
import {
  createFakeClock, createTestDatabase, createTestRedis, fixtureTime, generateNearKey, startFakeNearRpc, type FakeNearRpc, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp } from '../../src/app.js';
import { nearKeyPrefix } from '../../src/near.js';
import { spendKeyPrefix } from '../../src/spend.js';
import { startSigner } from '../../src/start.js';

// The Signer pays x402 targets on NEAR from its NEAR hot wallet: a NEP-366 delegate action of one
// ft_transfer, which the target's facilitator relays and pays the gas of. One payment from the wallet
// is in flight at a time: it holds the payer's lease, under the proxy's quote ID, until the release.

const secret = 'signer-secret-0123456789abcdef-0123456789';
const near = 'near:testnet';
const base = 'eip155:84532';
// Made-up accounts: our hot wallet, and the target's
const hotWallet = 'hot.anyfare.testnet';
const payTo = 'api.target.testnet';
const resource = 'https://api.target.test/v1/forecast';
// A key in the RPC's path, as some providers put it: no log line or answer may hold it
const rpcKey = 'signer-near-rpc-key-secret';
const clock = createFakeClock(fixtureTime(0, 13, 10, 15, 0, 0));

// $0.05 per call, $0.06 an hour, and $0.10 a day per network, so the tests reach them
const config: PlatformConfig = await loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({ signer: { maxPerCall: '0.05', maxPerNetworkPerHour: '0.06', maxPerNetworkPerDay: '0.1' } })).toString('base64'),
  },
});
const usdc = findAsset(config, 'near-usdc')!.address;
const key = generateNearKey();
const keyBase58 = key.secretKey.slice('ed25519:'.length);
const baseWallet = privateKeyToAccount(generatePrivateKey());
let database: TestDatabase;
let redis: TestRedis;
let rpc: FakeNearRpc;
let server: Server;
let url: string;
// Every line the Signer writes, debug included, and every answer it gave
const lines: Record<string, unknown>[] = [];
const answers: unknown[] = [];
const capture = () => createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
const lastLine = (msg: string): Record<string, unknown> | undefined => lines.filter(line => line['msg'] === msg).at(-1);
const leaseKey = () => `${redis.prefix}${nearKeyPrefix}payer:${hotWallet}`;
const nonceKey = () => `${redis.prefix}${nearKeyPrefix}nonce:${hotWallet}:${key.publicKey}`;
const releasedKey = (quoteId: string) => `${redis.prefix}${nearKeyPrefix}released:${quoteId}`;

beforeAll(async () => {
  [database, redis, rpc] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeNearRpc()]);
  rpc.addAccount({ accountId: hotWallet, publicKey: key.publicKey });
  server = createApp({
    config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), clock,
    wallets: { base: baseWallet, near: { accountId: hotWallet, secretKey: Secret.from(key.secretKey), rpcUrl: Secret.from(`${rpc.url}/${rpcKey}`) } },
  });
  url = `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await Promise.all([server?.close(), rpc?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

beforeEach(() => {
  rpc.reset();
});

const nearOption = (amount: string, overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: near, amount, asset: usdc, payTo, maxTimeoutSeconds: 60, ...overrides,
});

const baseOption = (amount: string) => ({
  scheme: 'exact', network: base, amount, asset: findAsset(config, 'base-usdc')!.address, payTo: '0x2222222222222222222222222222222222222222', maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
});

// Each sign has its own quote ID, as the proxy's payment IDs are: `pay_` and a UUID
const sign = async (
  requirement: Record<string, unknown>, { quotedPrice = String(requirement['amount']), requestId = 'req-near', at = url, quoteId = `pay_${randomUUID()}` } = {},
) => {
  const response = await fetch(`${at}/internal/v1/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signer-secret': secret, 'x-request-id': requestId },
    body: JSON.stringify({ requestId, quoteId, x402Version: 2, requirement, resource: { url: resource }, url: resource, quotedPrice }),
  });
  const body = await response.json() as Record<string, any>;
  answers.push(body);

  return { status: response.status, body, quoteId };
};

const release = async (quoteId: string, { key: given = secret as string | null, at = url } = {}) => {
  const response = await fetch(`${at}/internal/v1/quotes/${quoteId}/release`, {
    method: 'POST', headers: given === null ? {} : { 'x-signer-secret': given },
  });
  const text = await response.text();
  answers.push(text);

  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) as Record<string, any> };
};

// The signed delegate action of a sign answer
const delegateOf = (header: string) => {
  const { payload } = decodePaymentSignatureHeader(header) as unknown as { payload: { signedDelegateAction: string } };

  return { signedDelegateAction: payload.signedDelegateAction, ...decodeSignedDelegateB64(payload.signedDelegateAction) };
};

// Signs, checks it passed, and frees the lease, as the proxy does once the payment is settled
const signAndRelease = async (requirement: Record<string, unknown>) => {
  const signed = await sign(requirement);
  expect(signed.status).toBe(200);
  expect((await release(signed.quoteId)).status).toBe(204);

  return signed;
};

/** A NEAR RPC in front of the fake that never answers the first `block` read, and passes every other call on. */
const startHangingRpc = async (target: string) => {
  const held = new Set<ServerResponse>();
  let blocks = 0;
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      if ((JSON.parse(body.toString('utf8')) as { method?: unknown }).method === 'block' && blocks++ === 0) {
        held.add(response);

        return;
      }
      void fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(
        async answer => response.writeHead(answer.status, { 'content-type': 'application/json' }).end(await answer.text()),
        () => response.writeHead(502).end(),
      );
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    blocks: () => blocks,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
};

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
    for (const item of keys)
      total += BigInt(await redis.client.get(item) ?? '0');
  }

  return total;
};

const recordsOf = (requestId: string) => database.db.select().from(signatures).where(eq(signatures.requestId, requestId));

describe('the Signer on NEAR', () => {
  it('signs one ft_transfer of the option\'s amount to its payTo, as the SDK\'s client signer does for the same state, and records it', async () => {
    const before = { height: rpc.height, nonce: rpc.nonceOf(hotWallet, key.publicKey)! };
    const requirement = nearOption('10000');

    const signed = await sign(requirement, { requestId: 'req-near-first' });

    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ signatureId: expect.stringMatching(/^sig_/), network: near, asset: 'near-usdc', atomicAmount: '10000', amount: '10000', payTo });
    const { signedDelegateAction, delegate, verifySignature } = delegateOf(signed.body['header']);
    expect(delegate).toMatchObject({ senderId: hotWallet, receiverId: usdc, publicKey: key.publicKey, actionCount: 1 });
    expect(delegate.functionCall).toMatchObject({ methodName: 'ft_transfer', deposit: 1n });
    expect(parseFtTransferArgs(delegate.functionCall!.args)).toEqual({ receiver_id: payTo, amount: '10000' });
    // The final height it read, plus the option's 60 seconds at a block a second
    expect(delegate.maxBlockHeight).toBe(rpc.height + 60n);
    expect(delegate.nonce).toBe(before.nonce + 1n);
    expect(verifySignature()).toBe(true);
    // The SDK's client signer, over a node in the same state, signs the same bytes: ed25519 is deterministic
    const twin = await startFakeNearRpc({ height: before.height });
    try {
      twin.addAccount({ accountId: hotWallet, publicKey: key.publicKey, nonce: before.nonce });
      const sdk = await createClientNearSigner({ accountId: hotWallet, secretKey: key.secretKey, rpcUrls: { [near]: twin.url } })
        .createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirement as unknown as PaymentRequirements });

      expect(signedDelegateAction).toBe(sdk);
    }
    finally {
      await twin.close();
    }
    const [record] = await database.db.select().from(signatures).where(eq(signatures.id, signed.body['signatureId']));
    expect(record).toMatchObject({
      requestId: 'req-near-first', protocol: 'x402', network: near, asset: 'near-usdc', atomicAmount: 10_000n, amount: 10_000n, payTo, resource, createdAt: clock.now(),
    });
    // The payment holds the payer's lease, and the nonce it signed is remembered
    expect(await redis.client.get(leaseKey())).toBe(signed.quoteId);
    expect(await redis.client.get(nonceKey())).toBe((before.nonce + 1n).toString());
    expect(lastLine('Signed a routed payment')).toMatchObject({ protocol: 'x402', network: near, asset: 'near-usdc', payTo, signatureId: signed.body['signatureId'] });

    expect((await release(signed.quoteId)).status).toBe(204);
  });

  it('signs the last nonce plus one after a release while the chain\'s is unchanged, and the chain\'s plus one once it is higher', async () => {
    const first = delegateOf((await signAndRelease(nearOption('1000'))).body['header']).delegate.nonce;
    const second = delegateOf((await signAndRelease(nearOption('1000'))).body['header']).delegate.nonce;

    expect(second).toBe(first + 1n);
    rpc.addAccount({ accountId: hotWallet, publicKey: key.publicKey, nonce: second + 100n });
    expect(delegateOf((await signAndRelease(nearOption('1000'))).body['header']).delegate.nonce).toBe(second + 101n);
  });

  it('counts NEAR\'s limits: per call, per hour, and per day', async () => {
    await startNew('day');
    expect(await sign(nearOption('60000'))).toMatchObject({ status: 422, body: { error: { code: 'signing_refused', message: 'The amount is above the per-call maximum' } } });

    await signAndRelease(nearOption('50000'));
    expect(await sign(nearOption('20000'))).toMatchObject({ status: 422, body: { error: { message: 'The hourly spend limit is reached' } } });
    expect(await redis.client.get(leaseKey())).toBeNull();
    await startNew('hour');
    await signAndRelease(nearOption('40000'));
    expect(await sign(nearOption('20000'))).toMatchObject({ status: 422, body: { error: { message: 'The daily spend limit is reached' } } });
    expect(await redis.client.get(leaseKey())).toBeNull();
    expect(lastLine('The Signer refused a payment: a spend limit is reached')).toMatchObject({ network: near, refusal: 'daily_limit', spent: '0.09', limit: '0.1' });
    expect(await spentToday(near)).toBe(90_000n);
  });

  it('answers a second NEAR sign while the lease is held with 409 payer_busy: nothing reserved, nothing recorded', async () => {
    await startNew('day');
    const first = await sign(nearOption('10000'));
    expect(first.status).toBe(200);

    const busy = await sign(nearOption('10000'), { requestId: 'req-near-busy' });

    expect(busy).toMatchObject({ status: 409, body: { error: { code: 'payer_busy', message: 'A NEAR payment from the hot wallet is in flight: retry in a moment' } } });
    expect(await spentToday(near)).toBe(10_000n);
    expect(await recordsOf('req-near-busy')).toEqual([]);
    expect(lines.find(line => line['requestId'] === 'req-near-busy' && line['msg'] === 'Refused to sign a routed payment')).toMatchObject({
      level: 30, result: 'busy', reason: 'payer_busy', network: near, payTo,
    });
    expect(await redis.client.get(leaseKey())).toBe(first.quoteId);

    expect((await release(first.quoteId)).status).toBe(204);
  });

  it('frees the lease on the release by its quote ID only, idempotently, and a quote that held nothing, as a Base payment, is a no-op', async () => {
    const held = await sign(nearOption('1000'));
    const baseSigned = await sign(baseOption('1000'));
    expect(baseSigned.status).toBe(200);

    expect(await release(`pay_${randomUUID()}`)).toEqual({ status: 204, body: undefined });
    expect(await release(baseSigned.quoteId)).toEqual({ status: 204, body: undefined });
    expect(await redis.client.get(leaseKey())).toBe(held.quoteId);
    expect((await sign(nearOption('1000'))).status).toBe(409);

    expect(await release(held.quoteId)).toEqual({ status: 204, body: undefined });
    expect(await redis.client.get(leaseKey())).toBeNull();
    expect(await release(held.quoteId)).toEqual({ status: 204, body: undefined });
    expect(lines.filter(line => line['msg'] === 'Released a quote\'s NEAR lease' && line['quoteId'] === held.quoteId).map(line => line['released']))
      .toEqual([true, false]);
    expect(lastLine('Released a quote\'s NEAR lease')).toMatchObject({ level: 20 });

    await signAndRelease(nearOption('1000'));
  });

  it('refuses with quote_released a sign whose quote was released before it took the lease: nothing reserved, recorded, read, or held', async () => {
    await startNew('day');
    const quoteId = `pay_${randomUUID()}`;
    const calls = rpc.calls.length;

    expect(await release(quoteId)).toEqual({ status: 204, body: undefined });
    const markedMs = await redis.client.pTTL(releasedKey(quoteId));
    const refused = await sign(nearOption('1000'), { quoteId, requestId: 'req-near-released' });

    expect(refused).toMatchObject({ status: 422, body: { error: { code: 'signing_refused', message: 'The proxy released this quote before it was signed' } } });
    expect(lines.find(line => line['requestId'] === 'req-near-released' && line['msg'] === 'Refused to sign a routed payment')).toMatchObject({
      level: 30, result: 'refused', reason: 'quote_released', quoteId,
    });
    // Remembered for 10 minutes by Redis's clock: longer than any lease
    expect(markedMs).toBeGreaterThan(599_000);
    expect(markedMs).toBeLessThanOrEqual(600_000);
    expect(await spentToday(near)).toBe(0n);
    expect(await recordsOf('req-near-released')).toEqual([]);
    expect(await redis.client.get(leaseKey())).toBeNull();
    expect(rpc.calls.length).toBe(calls);
    // Any other quote signs at once
    await signAndRelease(nearOption('1000'));
  });

  it('marks no quote released when its release freed the lease it held, and signs in the usual order', async () => {
    const signed = await sign(nearOption('1000'));
    expect(signed.status).toBe(200);
    expect(await redis.client.get(leaseKey())).toBe(signed.quoteId);

    expect(await release(signed.quoteId)).toEqual({ status: 204, body: undefined });

    expect(await redis.client.get(leaseKey())).toBeNull();
    expect(await redis.client.exists(releasedKey(signed.quoteId))).toBe(0);
    expect(lines.filter(line => line['msg'] === 'Released a quote\'s NEAR lease' && line['quoteId'] === signed.quoteId).map(line => line['released'])).toEqual([true]);
  });

  it('answers a release with the shared secret only, and 400 for a quote ID with a character it can\'t hold', async () => {
    expect(await release('pay_any', { key: null })).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } });
    expect(await release('pay_any', { key: 'wrong' })).toMatchObject({ status: 401 });
    for (const invalid of ['pay_a.b', 'pay_a%20b', 'pay%3A1', 'pay%2F1'])
      expect(await release(invalid)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });

  it('holds the lease for the payment\'s window at a second a block plus a minute, and then it expires on its own', async () => {
    const short = await sign(nearOption('1000', { maxTimeoutSeconds: 1 }));
    const shortTtl = await redis.client.pTTL(leaseKey());
    await release(short.quoteId);
    const long = await sign(nearOption('1000', { maxTimeoutSeconds: 300 }));
    const longTtl = await redis.client.pTTL(leaseKey());

    expect(shortTtl).toBeGreaterThan(59_000);
    expect(shortTtl).toBeLessThanOrEqual(61_000);
    expect(longTtl).toBeGreaterThan(358_000);
    expect(longTtl).toBeLessThanOrEqual(360_000);
    // The nonce is remembered for a day
    expect(await redis.client.ttl(nonceKey())).toBeGreaterThan(86_000);

    // Its lifetime passed: the key is gone, and the next payment passes without a release
    await redis.client.pExpire(leaseKey(), 50);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await redis.client.get(leaseKey())).toBeNull();
    expect(long.status).toBe(200);
    await signAndRelease(nearOption('1000'));
  });

  it.each([
    ['an option paying our hot wallet', { payTo: hotWallet }, 'invalid_pay_to'],
    ['an option paying the registry asset\'s payTo', { payTo: 'pay.anyfare.testnet' }, 'invalid_pay_to'],
    ['another token', { asset: 'usdt.fakes.testnet' }, 'not_in_registry'],
    ['the mainnet contract on testnet', { asset: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' }, 'not_in_registry'],
    ['maxTimeoutSeconds of 301', { maxTimeoutSeconds: 301 }, 'invalid_timeout'],
    ['a non-empty extra', { extra: { memo: 'pay' } }, 'invalid_option'],
  ])('refuses %s with no reservation and no lease left behind', async (_name, overrides, reason) => {
    await startNew('day');
    const before = rpc.calls.length;

    expect(await sign(nearOption('1000', overrides))).toMatchObject({ status: 422, body: { error: { code: 'signing_refused' } } });
    expect(lastLine('Refused to sign a routed payment')).toMatchObject({ result: 'refused', reason });
    expect(await spentToday(near)).toBe(0n);
    expect(await redis.client.get(leaseKey())).toBeNull();
    expect(rpc.calls.length).toBe(before);
  });

  it('answers 502 signing_failed when the NEAR RPC is down: the reservation goes back, the lease is released, and the line holds no URL', async () => {
    await startNew('day');
    rpc.unavailable(true);

    const failed = await sign(nearOption('10000'), { requestId: 'req-near-down' });

    expect(failed).toMatchObject({ status: 502, body: { error: { code: 'signing_failed', message: 'The Signer couldn\'t build the NEAR payment: the NEAR RPC failed' } } });
    const line = lines.find(item => item['requestId'] === 'req-near-down' && item['msg'] === 'Failed to sign a routed payment');
    expect(line).toMatchObject({ level: 40, protocol: 'x402', network: near, result: 'failed', reason: 'The NEAR RPC answered HTTP 503' });
    const requestLines = JSON.stringify(lines.filter(item => item['requestId'] === 'req-near-down'));
    expect(requestLines).not.toContain(rpcKey);
    expect(requestLines).not.toContain(rpc.url);
    expect(await spentToday(near)).toBe(0n);
    expect(await redis.client.get(leaseKey())).toBeNull();
    expect(await recordsOf('req-near-down')).toEqual([]);
    rpc.unavailable(false);
    await signAndRelease(nearOption('1000'));
  });

  it('ends a sign whose first block read hangs within the proxy\'s call timeout: 502, the reservation back, the lease freed', async () => {
    await startNew('day');
    const hanging = await startHangingRpc(rpc.url);
    const app = createApp({
      config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), clock,
      wallets: { near: { accountId: hotWallet, secretKey: Secret.from(key.secretKey), rpcUrl: Secret.from(hanging.url) } },
    });
    const at = `http://127.0.0.1:${(await app.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
    try {
      const started = performance.now();

      const failed = await sign(nearOption('10000'), { at, requestId: 'req-near-hanging' });

      expect(performance.now() - started).toBeLessThan(config.timeouts.connectMs);
      expect(failed).toMatchObject({ status: 502, body: { error: { code: 'signing_failed' } } });
      // Half the budget less 250 ms, and no repeat: it couldn't end within the budget less 500 ms
      expect(lines.find(line => line['requestId'] === 'req-near-hanging' && line['msg'] === 'Failed to sign a routed payment'))
        .toMatchObject({ reason: `The NEAR RPC didn't answer within ${Math.floor(config.timeouts.connectMs / 2) - 250} ms` });
      expect(hanging.blocks()).toBe(1);
      expect(await spentToday(near)).toBe(0n);
      expect(await redis.client.get(leaseKey())).toBeNull();
      expect(await recordsOf('req-near-hanging')).toEqual([]);
    }
    finally {
      await app.close();
      await hanging.close();
    }
  });

  it('never puts the key, the RPC\'s key, or a signed delegate action in a log line or an error answer', () => {
    const logged = JSON.stringify(lines);
    const answered = JSON.stringify(answers.filter(answer => typeof answer !== 'object' || answer === null || !('header' in answer)));

    expect(answers.length).toBeGreaterThan(10);
    for (const value of [key.secretKey, keyBase58, rpcKey]) {
      expect(logged).not.toContain(value);
      expect(JSON.stringify(answers)).not.toContain(value);
    }
    const signed = answers.filter((answer): answer is Record<string, string> => typeof answer === 'object' && answer !== null && 'header' in answer);
    for (const answer of signed) {
      expect(logged).not.toContain(answer['header']);
      if (answer['network'] === near)
        expect(logged).not.toContain(delegateOf(answer['header']!).signedDelegateAction);
    }
    expect(answered).not.toContain(rpc.url);
  });
});

describe('the NEAR lease without its stores or its wallet', () => {
  it('answers 503 redis_not_ready to a NEAR sign and a release while Redis is down, and reads nothing from the chain', async () => {
    // Port 1 refuses connections, so the client keeps reconnecting
    const down = createRedis({ url: Secret.from('redis://127.0.0.1:1'), logger: createLogger({ level: 'silent' }) });
    const app = createApp({
      config, logger: capture(), postgres: database.postgres, redis: down, secret: Secret.from(secret), clock,
      wallets: { near: { accountId: hotWallet, secretKey: Secret.from(key.secretKey), rpcUrl: Secret.from(rpc.url) } },
    });
    const at = `http://127.0.0.1:${(await app.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
    try {
      expect(await sign(nearOption('1000'), { at, requestId: 'req-near-redis-down' })).toMatchObject({ status: 503, body: { error: { code: 'redis_not_ready' } } });
      expect(await release('pay_any', { at })).toMatchObject({ status: 503, body: { error: { code: 'redis_not_ready' } } });
    }
    finally {
      await app.close();
      await down.close();
    }
    expect(rpc.calls).toEqual([]);
    expect(await recordsOf('req-near-redis-down')).toEqual([]);
  });

  it('answers 204 to a release without a NEAR wallet, and does nothing', async () => {
    const app = createApp({ config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), clock, wallets: { base: baseWallet } });
    const at = `http://127.0.0.1:${(await app.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
    try {
      expect(await release('pay_any', { at })).toEqual({ status: 204, body: undefined });
      expect(lastLine('Released a quote\'s NEAR lease')).toMatchObject({ quoteId: 'pay_any', released: false });
    }
    finally {
      await app.close();
    }
  });
});

describe('the Signer\'s startup with a NEAR wallet', () => {
  const envWith = (extra: Record<string, string> = {}) => ({
    CONFIG_PATH: 'config/example.yaml', SIGNER_SECRET: secret, SIGNER_NEAR_ACCOUNT: hotWallet, SIGNER_NEAR_KEY: key.secretKey,
    DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose(), HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0',
    NEAR_RPC_URLS: `near:testnet=${rpc.url}/${rpcKey}`, ...extra,
  });
  const startLines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });
  const failureOf = async (env: Record<string, string>): Promise<Error | undefined> =>
    startSigner({ env, logger: createLogger({ level: 'silent' }) }).then(async app => {
      await app.close();

      return undefined;
    }, (error: unknown) => error as Error);

  it('checks the key at startup and logs the account and the RPC\'s host, never the key or the URL\'s path', async () => {
    const app = await startSigner({ env: envWith(), logger });
    await app.close();

    expect(rpc.calls).toEqual([{ method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: hotWallet, public_key: key.publicKey } }]);
    expect(startLines.find(line => line['msg'] === 'Started')).toMatchObject({
      wallets: { base: null, tempo: null, solana: null, near: hotWallet }, nearRpc: new URL(rpc.url).host,
    });
    const logged = JSON.stringify(startLines);
    for (const value of [key.secretKey, keyBase58, rpcKey])
      expect(logged).not.toContain(value);
  });

  it('warns and starts when the NEAR RPC is down', async () => {
    rpc.unavailable(true);
    const before = startLines.length;

    const app = await startSigner({ env: envWith(), logger });
    await app.close();

    const started = startLines.slice(before);
    expect(started.find(line => line['level'] === 40)).toMatchObject({
      host: new URL(rpc.url).host, msg: 'The NEAR RPC didn\'t answer at startup: NEAR payments will be tried, and fail while it is down',
    });
    expect(started.find(line => line['msg'] === 'Started')).toMatchObject({ wallets: { near: hotWallet } });
    expect(JSON.stringify(started)).not.toContain(rpcKey);
  });

  it('won\'t start with a key that isn\'t the account\'s, a function-call key, or an account the node doesn\'t know', async () => {
    const limited = generateNearKey();
    rpc.addAccount({
      accountId: hotWallet, publicKey: limited.publicKey, permission: { FunctionCall: { allowance: null, receiver_id: usdc, method_names: ['ft_transfer'] } },
    });

    expect((await failureOf(envWith({ SIGNER_NEAR_KEY: generateNearKey().secretKey })))?.message)
      .toBe(`SIGNER_NEAR_KEY isn't an access key of ${hotWallet} on near:testnet`);
    expect((await failureOf(envWith({ SIGNER_NEAR_KEY: limited.secretKey })))?.message).toBe(`SIGNER_NEAR_KEY isn't a full-access key of ${hotWallet} on near:testnet`);
    expect((await failureOf(envWith({ SIGNER_NEAR_ACCOUNT: 'nobody.anyfare.testnet' })))?.message)
      .toMatch(/^(SIGNER_NEAR_KEY isn't an access key of nobody\.anyfare\.testnet|SIGNER_NEAR_ACCOUNT, nobody\.anyfare\.testnet, doesn't exist) on near:testnet$/);
  });

  it('won\'t start with an account that isn\'t signer.wallets.near, only one of the two variables, or a key that isn\'t one, without echoing it', async () => {
    const named = Buffer.from(JSON.stringify({ signer: { wallets: { near: 'pay.anyfare.testnet' } } })).toString('base64');

    expect((await failureOf(envWith({ CONFIG: named })))?.message).toBe(`SIGNER_NEAR_ACCOUNT, ${hotWallet}, isn't signer.wallets.near, pay.anyfare.testnet`);
    expect((await failureOf(envWith({ SIGNER_NEAR_KEY: '' })))?.message).toBe('SIGNER_NEAR_ACCOUNT and SIGNER_NEAR_KEY must be set together, or not at all');
    expect((await failureOf(envWith({ SIGNER_NEAR_ACCOUNT: '' })))?.message).toBe('SIGNER_NEAR_ACCOUNT and SIGNER_NEAR_KEY must be set together, or not at all');
    for (const invalid of [keyBase58, `ed25519:${keyBase58.slice(0, 10)}`, `ed25519:0OIl${keyBase58.slice(4)}`]) {
      const failure = await failureOf(envWith({ SIGNER_NEAR_KEY: invalid }));

      expect(failure?.message).toBe('SIGNER_NEAR_KEY must be ed25519: and a base58 key');
      expect(failure?.message).not.toContain(invalid);
    }
  });
});
