import { eq } from 'drizzle-orm';
import { Challenge, Credential } from 'mppx';
import { decodeFunctionData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Abis, Transaction } from 'viem/tempo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatUsd, createLogger, Secret, type Server } from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { signatures } from '@anyfare/db';
import {
  createFakeClock, createTestDatabase, createTestRedis, moderatoChainId, startFakeTempoRpc, type FakeTempoRpc, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp } from '../../src/app.js';
import { spendKeyPrefix } from '../../src/spend.js';
import { startSigner } from '../../src/start.js';
import { maxFeeOf } from '../../src/tempo.js';

// The Signer pays MPP targets on Tempo, in pull mode, from SIGNER_TEMPO_KEY
const secret = 'signer-secret-0123456789abcdef-0123456789';
const base = 'eip155:84532';
const tempo = 'eip155:42431';
const resource = 'https://api.target.test/v1/price';
const recipient = '0x5555555555555555555555555555555555555555';
const baseRecipient = '0x2222222222222222222222222222222222222222';
// mppx's client checks a challenge's expiry against the real clock, so the Signer's runs near it
const clock = createFakeClock(new Date());

// $0.05 a call, $0.06 a day per network, no hourly limit: small, so the tests reach them
const config: PlatformConfig = await loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({ signer: { maxPerCall: '0.05', maxPerNetworkPerDay: '0.06' } })).toString('base64'),
  },
});
let database: TestDatabase;
let redis: TestRedis;
let rpc: FakeTempoRpc;
// Both wallets, and Base's only
let both: Server;
let baseOnly: Server;
let url: string;
let metricsUrl: string;
let baseOnlyUrl: string;
const walletKey = generatePrivateKey();
const wallet = privateKeyToAccount(walletKey);
const lines: Record<string, unknown>[] = [];
const capture = () => createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
const lastLine = (msg: string): Record<string, unknown> | undefined => lines.filter(line => line['msg'] === msg).at(-1);
// Every credential the Signer answered: none may reach a log
const credentials: string[] = [];

beforeAll(async () => {
  [database, redis, rpc] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeTempoRpc()]);
  const dependencies = { config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), tempoRpcUrl: rpc.url, clock };
  // One key for both chains, as the operator may give it: the address is the same on each
  both = createApp({ ...dependencies, wallets: { base: wallet, tempo: wallet } });
  baseOnly = createApp({ ...dependencies, wallets: { base: wallet } });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [bothPorts, basePorts] = await Promise.all([both.listen(listen), baseOnly.listen(listen)]);
  url = `http://127.0.0.1:${bothPorts.port}`;
  metricsUrl = `http://127.0.0.1:${bothPorts.metricsPort}/metrics`;
  baseOnlyUrl = `http://127.0.0.1:${basePorts.port}`;
});

afterAll(async () => {
  await Promise.all([both?.close(), baseOnly?.close()]);
  await rpc?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

let counter = 0;

/** A target's Tempo charge, as `mppx`'s server writes it, expiring in five minutes. */
const charge = (amount: string, details: Record<string, unknown> = {}, request: Record<string, unknown> = {}, expiresInMs = 5 * 60_000): string => {
  counter += 1;

  return Challenge.serialize(Challenge.from({
    id: `challenge-${counter}`, realm: 'api.target.test', method: 'tempo', intent: 'charge', expires: new Date(clock.now().getTime() + expiresInMs).toISOString(),
    request: {
      amount, currency: findAsset(config, 'tempo-pathusd')!.address, recipient, methodDetails: { chainId: moderatoChainId, supportedModes: ['pull'], ...details }, ...request,
    },
  } as never));
};

/** A Tempo charge whose expiry has the right shape, but no date: month 13. */
const undatedCharge = (amount: string): string => {
  const challenge = charge(amount).replace(/expires="[^"]+"/, 'expires="2026-13-01T00:00:00.000Z"');
  if (!challenge.includes('2026-13-01'))
    throw new Error('The challenge has no expiry to change');

  return challenge;
};

const sign = async (body: Record<string, unknown>, at = url) => {
  const response = await fetch(`${at}/internal/v1/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signer-secret': secret, 'x-request-id': String(body['requestId'] ?? 'req-tempo') },
    body: JSON.stringify({ requestId: 'req-tempo', quoteId: `pay_${crypto.randomUUID()}`, url: resource, ...body }),
  });
  const answer = await response.json() as Record<string, any>;
  if (typeof answer['header'] === 'string')
    credentials.push(answer['header']);

  return { status: response.status, body: answer };
};

const signMpp = async (challenge: string, quotedPrice: string, at = url, requestId = 'req-tempo') => sign({ protocol: 'mpp', challenge, quotedPrice, requestId }, at);

const signBase = async (amount: string) => sign({
  protocol: 'x402', x402Version: 2, quotedPrice: amount, resource: { url: resource },
  requirement: { scheme: 'exact', network: base, amount, asset: findAsset(config, 'base-usdc')!.address, payTo: baseRecipient, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } },
});

// The spend windows follow Redis's clock: a test starts a new day by clearing their counters
const startNewDay = async (): Promise<void> => {
  for await (const keys of redis.client.scanIterator({ MATCH: `${redis.prefix}${spendKeyPrefix}*`, COUNT: 100 })) {
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

const feesOnTempo = async (): Promise<number> => {
  const match = /signer_fees_usd_total\{network="eip155:42431"\} (\S+)/.exec(await (await fetch(metricsUrl)).text());

  return match ? Number(match[1]) : 0;
};

describe('the Signer pays MPP targets on Tempo', () => {
  it('signs a Tempo charge in pull mode with mppx\'s client, on mpp.network\'s chain, within the quote, and records it', async () => {
    const signed = await signMpp(charge('1500'), '1500', url, 'req-tempo-1');
    const credential = Credential.deserialize<{ signature: Hex; type: string }>(signed.body['header']);
    const transaction = Transaction.deserialize(credential.payload.signature) as {
      chainId?: number; calls?: readonly { to: string; data: Hex }[]; validBefore?: number; gas?: bigint; maxFeePerGas?: bigint;
    };
    const [call] = transaction.calls ?? [];
    const transfer = decodeFunctionData({ abi: Abis.tip20, data: call!.data });
    const [record] = await database.db.select().from(signatures).where(eq(signatures.id, signed.body['signatureId']));

    expect(signed.status).toBe(200);
    expect(signed.body['header']).toMatch(/^Payment /);
    // Pull mode: a signed transaction the target broadcasts, never the hash of one we sent
    expect(credential.payload.type).toBe('transaction');
    expect(credential.challenge.id).toBe(`challenge-${counter}`);
    expect(transaction.chainId).toBe(moderatoChainId);
    expect(call!.to.toLowerCase()).toBe(findAsset(config, 'tempo-pathusd')!.address.toLowerCase());
    expect(transfer.args.slice(0, 2)).toEqual([recipient, 1_500n]);
    expect(transaction.validBefore! * 1_000).toBeLessThanOrEqual(Date.now() + 26_000);
    // The Signer never broadcasts: the target does
    expect(rpc.calls.map(item => item.method)).not.toContain('eth_sendRawTransactionSync');
    expect(rpc.calls.map(item => item.method)).not.toContain('eth_sendRawTransaction');
    expect(signed.body).toMatchObject({ network: tempo, asset: 'tempo-pathusd', atomicAmount: '1500', amount: '1500', payTo: recipient });
    expect(record).toMatchObject({ requestId: 'req-tempo-1', protocol: 'mpp', network: tempo, asset: 'tempo-pathusd', atomicAmount: 1_500n, amount: 1_500n, payTo: recipient, resource });
    // The protocol, network, amount, and the most our transaction pays in fees: its gas limit at its maximum fee per gas
    const maxFee = maxFeeOf(signed.body['header']);
    expect(maxFee).toBe(((transaction.gas! * transaction.maxFeePerGas!) + 10n ** 12n - 1n) / 10n ** 12n);
    expect(maxFee).toBeGreaterThan(0n);
    const line = lines.find(item => item['requestId'] === 'req-tempo-1' && item['msg'] === 'Signed a routed payment');
    expect(line).toMatchObject({ protocol: 'mpp', network: tempo, asset: 'tempo-pathusd', amount: '0.0015', payTo: recipient, maxFee: expect.stringMatching(/^0\.\d+$/), result: 'signed' });
    expect(Number(line!['maxFee'])).toBeCloseTo(Number(maxFee) / 1_000_000, 9);
    expect(await feesOnTempo()).toBeCloseTo(Number(maxFee) / 1_000_000, 9);
    expect(await (await fetch(metricsUrl)).text()).toMatch(/signer_spend_usd_total\{network="eip155:42431"\} 0\.0015/);
  });

  it('counts no fee when the target sponsors it', async () => {
    const before = await feesOnTempo();

    const signed = await signMpp(charge('1000', { feePayer: true }), '1000', url, 'req-tempo-sponsored');

    expect(signed.status).toBe(200);
    expect(lines.find(line => line['requestId'] === 'req-tempo-sponsored' && line['msg'] === 'Signed a routed payment')).toMatchObject({ maxFee: '0' });
    expect(await feesOnTempo()).toBe(before);
  });

  it.each([
    ['push mode only', () => charge('1000', { supportedModes: ['push'] }), 'push_only'],
    ['splits', () => charge('1000', { splits: [{ amount: '100', recipient: baseRecipient }] }), 'splits'],
    ['a currency outside the registry', () => charge('1000', {}, { currency: '0x20c0000000000000000000000000000000000001' }), 'unsupported_currency'],
    ['another chain than mpp.network', () => charge('1000', { chainId: 4_217 }), 'wrong_chain'],
    ['a challenge that isn\'t one', () => 'Payment nonsense', 'not_tempo_charge'],
    ['a machine-token route', () => charge('1000', { machineTokenEnabled: true }), 'machine_token'],
    ['an expiry that isn\'t a date', () => undatedCharge('1000'), 'expired'],
    ['an amount that isn\'t one', () => charge('1.5'), 'invalid_amount'],
    ['an expired challenge', () => charge('1000', {}, {}, -60_000), 'expired'],
  ])('refuses %s, signing nothing and counting nothing', async (_name, challenge, reason) => {
    await startNewDay();
    const before = rpc.calls.length;

    expect(await signMpp(challenge(), '1000')).toMatchObject({ status: 422, body: { error: { code: 'signing_refused' } } });
    expect(lastLine('Refused to sign a routed payment')).toMatchObject({ protocol: 'mpp', result: 'refused', reason });
    expect(rpc.calls.length).toBe(before);
    expect(await spentToday(tempo)).toBe(0n);
  });

  it('refuses above the quote and above the per-call maximum', async () => {
    expect(await signMpp(charge('2000'), '1999')).toMatchObject({ status: 422, body: { error: { message: 'The amount is above the quoted price' } } });
    expect(await signMpp(charge('60000'), '60000')).toMatchObject({ status: 422, body: { error: { message: 'The amount is above the per-call maximum' } } });
  });

  it('refuses every Tempo target without SIGNER_TEMPO_KEY: no_wallet', async () => {
    expect(await signMpp(charge('1000'), '1000', baseOnlyUrl)).toMatchObject({ status: 422, body: { error: { message: 'The Signer holds no wallet on Tempo Moderato' } } });
    expect(lastLine('Refused to sign a routed payment')).toMatchObject({ protocol: 'mpp', network: tempo, reason: 'no_wallet' });
  });

  it('counts Tempo\'s daily limit apart from Base\'s, with the fees our wallet pays', async () => {
    // A new day: the Tempo charges signed above were on another day
    await startNewDay();
    expect((await signBase('50000')).status).toBe(200);
    expect(await signBase('20000')).toMatchObject({ status: 422, body: { error: { message: 'The daily spend limit is reached' } } });

    const signed = await signMpp(charge('50000'), '50000');
    expect(signed.status).toBe(200);
    const fee = maxFeeOf(signed.body['header']);
    expect(fee).toBeGreaterThan(0n);
    // The charge and the most its transaction pays in fees
    expect(await spentToday(tempo)).toBe(50_000n + fee);
    // $0.01 more would just fit the day's $0.06 without the fee
    expect(await signMpp(charge('10000'), '10000')).toMatchObject({ status: 422, body: { error: { message: 'The daily spend limit is reached' } } });
    expect(lastLine('The Signer refused a payment: a spend limit is reached')).toMatchObject({
      level: 50, network: tempo, refusal: 'daily_limit', window: 'day', spent: formatUsd(50_000n + fee), limit: '0.06', alert: true,
    });
  });

  it('adds no fee to the limits when the target sponsors it', async () => {
    await startNewDay();

    expect((await signMpp(charge('10000', { feePayer: true }), '10000')).status).toBe(200);

    expect(await spentToday(tempo)).toBe(10_000n);
  });

  it('answers 502 signing_failed when the Tempo RPC fails, logs its short reason, and records and counts nothing', async () => {
    await startNewDay();
    rpc.unavailable(true);
    try {
      expect(await signMpp(charge('1000'), '1000', url, 'req-tempo-down')).toMatchObject({
        status: 502, body: { error: { code: 'signing_failed', message: 'The Signer couldn\'t build the Tempo payment: the Tempo RPC failed' } },
      });
    }
    finally {
      rpc.unavailable(false);
    }
    const failed = lines.find(line => line['requestId'] === 'req-tempo-down' && line['msg'] === 'Failed to sign a routed payment');
    expect(failed).toMatchObject({ level: 40, protocol: 'mpp', network: tempo, result: 'failed', reason: expect.any(String) });
    expect(String(failed!['reason']).length).toBeLessThanOrEqual(200);
    expect(failed!['reason']).not.toContain(rpc.url);
    expect(await database.db.select().from(signatures).where(eq(signatures.requestId, 'req-tempo-down'))).toEqual([]);
    // The reservation went back
    expect(await spentToday(tempo)).toBe(0n);
  });

  it('never logs the Tempo key, a signed transaction, or a credential', () => {
    const logged = JSON.stringify(lines);

    // x402's PAYMENT-SIGNATURE values, and MPP's credentials with their signed transactions
    expect(credentials.filter(credential => credential.startsWith('Payment ')).length).toBeGreaterThan(1);
    for (const credential of credentials) {
      expect(logged).not.toContain(credential);
      if (!credential.startsWith('Payment '))
        continue;
      expect(logged).not.toContain(credential.slice('Payment '.length));
      expect(logged).not.toContain(Credential.deserialize<{ signature: string }>(credential).payload.signature);
    }
    expect(logged).not.toContain(walletKey);
    expect(logged).not.toContain(walletKey.slice(2));
  });
});

describe('the Signer\'s startup with a Tempo wallet', () => {
  it('logs both wallets\' addresses, never their keys', async () => {
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });
    const baseKey = generatePrivateKey();
    const tempoKey = generatePrivateKey();
    const env = {
      CONFIG_PATH: 'config/example.yaml', SIGNER_SECRET: secret, SIGNER_BASE_KEY: baseKey, SIGNER_TEMPO_KEY: tempoKey, DATABASE_URL: database.url.expose(),
      REDIS_URL: redis.url.expose(), HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0',
    };

    const app = await startSigner({ env, logger });
    await app.close();

    expect(startLines.find(line => line['msg'] === 'Started')).toMatchObject({
      wallets: { base: privateKeyToAccount(baseKey).address, tempo: privateKeyToAccount(tempoKey).address, solana: null },
    });
    for (const key of [baseKey, tempoKey])
      expect(JSON.stringify(startLines)).not.toContain(key.slice(2));
    await expect(startSigner({ env: { ...env, SIGNER_TEMPO_KEY: '0x12' }, logger })).rejects.toThrow('SIGNER_TEMPO_KEY must be 0x and 64 hex characters');
  });
});
