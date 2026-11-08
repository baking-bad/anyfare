import { generateKeyPairSync } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo } from 'node:net';

import { createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret, type Server } from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { signatures } from '@anyfare/db';
import {
  associatedTokenAddress, createFakeClock, createTestDatabase, createTestRedis, decodeSolanaPayment, encodeBase58, fixtureTime, startFakeSolanaRpc,
  type FakeSolanaRpc, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp } from '../../src/app.js';
import { spendKeyPrefix } from '../../src/spend.js';
import { startSigner } from '../../src/start.js';

// The Signer pays x402 targets on Solana from its Solana hot wallet, with @x402/svm's client. The
// target's facilitator pays the transaction's fee: our wallet only signs the USDC transfer.

const secret = 'signer-secret-0123456789abcdef-0123456789';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const base = 'eip155:84532';
const resource = 'https://api.target.test/v1/slot';
// Made-up Solana addresses: the target's, and its facilitator's, which pays the transaction's fee
const payTo = encodeBase58(Uint8Array.from({ length: 32 }, () => 7));
const feePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 9));
// A key in the RPC's path, as some providers put it: no log line may hold it
const rpcKey = 'signer-solana-key-secret';
const clock = createFakeClock(fixtureTime(0, 10, 10, 15, 0, 0));

// $0.05 per call and $0.10 a day per network, so the tests reach them
const config: PlatformConfig = await loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({ signer: { maxPerCall: '0.05', maxPerNetworkPerDay: '0.1' } })).toString('base64'),
  },
});
let database: TestDatabase;
let redis: TestRedis;
let rpc: FakeSolanaRpc;
let server: Server;
let noSolana: Server;
let url: string;
let noSolanaUrl: string;
let wallet: KeyPairSigner;
const baseWallet = privateKeyToAccount(generatePrivateKey());
// The signed transactions the Signer answered: none may reach a log
const transactions: string[] = [];
const lines: Record<string, unknown>[] = [];
const capture = () => createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

/** A Solana secret key as its 64 bytes, the seed then the public key, made in the test. */
const solanaKeyBytes = (): Uint8Array => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

  return Uint8Array.from([...seed, ...raw]);
};

const closedPort = async (): Promise<number> => {
  const listener = createNetServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise(resolve => listener.close(resolve));

  return port;
};

beforeAll(async () => {
  [database, redis, rpc, wallet] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeSolanaRpc(), generateKeyPairSigner()]);
  const dependencies = { config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), clock };
  server = createApp({ ...dependencies, wallets: { base: baseWallet, solana: wallet }, solanaRpcUrl: Secret.from(`${rpc.url}/${rpcKey}`) });
  noSolana = createApp({ ...dependencies, wallets: { base: baseWallet } });
  const listen = { host: '127.0.0.1', port: 0, metricsPort: 0 };
  const [ports, noSolanaPorts] = await Promise.all([server.listen(listen), noSolana.listen(listen)]);
  url = `http://127.0.0.1:${ports.port}`;
  noSolanaUrl = `http://127.0.0.1:${noSolanaPorts.port}`;
});

afterAll(async () => {
  await Promise.all([server?.close(), noSolana?.close(), rpc?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const solanaOption = (amount: string, overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: solana, amount, asset: findAsset(config, 'solana-usdc')!.address, payTo, maxTimeoutSeconds: 60, extra: { feePayer }, ...overrides,
});

const baseOption = (amount: string) => ({
  scheme: 'exact', network: base, amount, asset: findAsset(config, 'base-usdc')!.address, payTo: '0x2222222222222222222222222222222222222222', maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
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

const sign = async (requirement: Record<string, unknown>, { quotedPrice = String(requirement['amount']), at = url, requestId = 'req-solana' } = {}) => {
  const response = await fetch(`${at}/internal/v1/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signer-secret': secret, 'x-request-id': requestId },
    body: JSON.stringify({ requestId, quoteId: `pay_${Math.random()}`, x402Version: 2, requirement, resource: { url: resource }, url: resource, quotedPrice }),
  });
  const body = await response.json() as Record<string, any>;
  if (typeof body['header'] === 'string')
    transactions.push((decodePaymentSignatureHeader(body['header']) as unknown as { payload: { transaction: string } }).payload.transaction);

  return { status: response.status, body };
};

describe('the Signer on Solana', () => {
  it('signs a USDC transfer with @x402/svm\'s client: the target\'s facilitator pays the fee, our wallet only signs, and the signature is recorded', async () => {
    const mint = findAsset(config, 'solana-usdc')!.address;

    const signed = await sign(solanaOption('10000'));

    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ network: solana, asset: 'solana-usdc', atomicAmount: '10000', amount: '10000', payTo });
    const payment = decodeSolanaPayment(transactions.at(-1)!);
    expect(payment.feePayer).toBe(feePayer);
    expect(payment.signedBy).toEqual([wallet.address]);
    expect(payment.unsignedBy).toEqual([feePayer]);
    expect(payment.transfer).toEqual({
      source: await associatedTokenAddress(wallet.address, mint), mint, destination: await associatedTokenAddress(payTo, mint), authority: wallet.address, amount: 10_000n, decimals: 6,
    });
    // The SDK read the mint and a recent blockhash through SOLANA_RPC_URL, with its key in the path
    expect(rpc.calls).toEqual(expect.arrayContaining(['getAccountInfo', 'getLatestBlockhash']));
    const [record] = await database.db.select().from(signatures).where(eq(signatures.id, signed.body['signatureId']));
    expect(record).toMatchObject({ requestId: 'req-solana', protocol: 'x402', network: solana, asset: 'solana-usdc', atomicAmount: 10_000n, amount: 10_000n, payTo, resource });
  });

  it.each([
    ['only version 0', [0], 0],
    ['versions 0 and 1', [0, 1], 1],
    ['only version 1', [1], 1],
    ['none, which means version 0', undefined, 0],
  ])('builds the transaction version the option advertises: %s', async (_name, transactionVersions, version) => {
    const extra = transactionVersions === undefined ? { feePayer } : { feePayer, transactionVersions };

    const signed = await sign(solanaOption('1000', { extra }));

    expect(signed.status).toBe(200);
    const payment = decodeSolanaPayment(transactions.at(-1)!);
    expect(payment.version).toBe(version);
    expect(payment).toMatchObject({ feePayer, signedBy: [wallet.address], transfer: { authority: wallet.address, amount: 1_000n } });
  });

  it('refuses an option without a fee payer, or whose fee payer is our wallet, before the spend limits count it', async () => {
    expect(await sign(solanaOption('1000', { extra: {} }))).toMatchObject({
      status: 422, body: { error: { code: 'signing_refused', message: 'The Solana option names no fee payer: the Signer never pays a transaction\'s fee' } },
    });
    expect(await sign(solanaOption('1000', { extra: { feePayer: wallet.address } }))).toMatchObject({
      status: 422, body: { error: { message: 'The Solana option names our wallet as its fee payer' } },
    });
    expect(lines.filter(line => line['msg'] === 'Refused to sign a routed payment').map(line => line['reason'])).toEqual(expect.arrayContaining(['no_fee_payer', 'fee_payer_is_us']));

    // A new day's $0.10: three refused $0.05 options would pass it if the limits had counted them
    await startNewDay();
    for (const extra of [{}, { feePayer: wallet.address }, {}])
      expect((await sign(solanaOption('50000', { extra }))).status).toBe(422);
    expect((await sign(solanaOption('50000'))).status).toBe(200);
    expect((await sign(solanaOption('50000'))).status).toBe(200);
  });

  it('refuses outside the registry, above the quote, and above the per-call maximum', async () => {
    expect(await sign(solanaOption('1000', { asset: 'So11111111111111111111111111111111111111112' }))).toMatchObject({
      status: 422, body: { error: { message: 'The network and asset aren\'t in the registry' } },
    });
    expect(await sign(solanaOption('20000'), { quotedPrice: '19999' })).toMatchObject({ status: 422, body: { error: { message: 'The amount is above the quoted price' } } });
    expect(await sign(solanaOption('60000'))).toMatchObject({ status: 422, body: { error: { message: 'The amount is above the per-call maximum' } } });
  });

  it('counts Solana\'s daily limit apart from Base\'s', async () => {
    // A new day: the $0.10 signed on Solana above was on another day
    await startNewDay();
    expect((await sign(solanaOption('50000'))).status).toBe(200);
    expect((await sign(solanaOption('50000'))).status).toBe(200);
    expect(await sign(solanaOption('1000'))).toMatchObject({ status: 422, body: { error: { message: 'The daily spend limit is reached' } } });

    expect((await sign(baseOption('50000'))).status).toBe(200);
  });

  it('refuses every Solana option without a Solana wallet (no_wallet)', async () => {
    expect(await sign(solanaOption('1000'), { at: noSolanaUrl })).toMatchObject({ status: 422, body: { error: { message: 'The Signer holds no wallet on Solana Devnet' } } });
    expect(lines.filter(line => line['msg'] === 'Refused to sign a routed payment').map(line => line['reason'])).toContain('no_wallet');
  });

  it('answers 502 signing_failed when the Solana RPC fails, with its short reason and never the RPC\'s key', async () => {
    await startNewDay();
    const port = await closedPort();
    const down = createApp({
      config, logger: capture(), postgres: database.postgres, redis, secret: Secret.from(secret), clock, wallets: { solana: await generateKeyPairSigner() },
      solanaRpcUrl: Secret.from(`http://127.0.0.1:${port}/${rpcKey}`),
    });
    const downUrl = `http://127.0.0.1:${(await down.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
    try {
      expect(await sign(solanaOption('1000'), { at: downUrl, requestId: 'req-solana-down' })).toMatchObject({
        status: 502, body: { error: { code: 'signing_failed', message: 'The Signer couldn\'t build the Solana Devnet payment: the Solana Devnet RPC failed' } },
      });
    }
    finally {
      await down.close();
    }
    const failed = lines.find(line => line['requestId'] === 'req-solana-down' && line['msg'] === 'Failed to sign a routed payment');
    expect(failed).toMatchObject({ level: 40, protocol: 'x402', network: solana, result: 'failed', reason: expect.any(String) });
    expect(String(failed!['reason']).length).toBeLessThanOrEqual(200);
    expect(failed!['reason']).not.toMatch(/https?:\/\//);
    // Nothing was signed, so nothing was recorded, and the reservation went back
    expect(await database.db.select().from(signatures).where(eq(signatures.requestId, 'req-solana-down'))).toEqual([]);
    expect(await spentToday(solana)).toBe(0n);
  });

  it.each([
    ['transaction version 2', { extra: { feePayer, transactionVersions: [2] } }, 'invalid_option'],
    ['the mint in another case', { asset: findAsset(config, 'solana-usdc')!.address.toLowerCase() }, 'not_in_registry'],
    ['a payTo that isn\'t a Solana address', { payTo: '0x2222222222222222222222222222222222222222' }, 'invalid_pay_to'],
    ['a fee payer that isn\'t an address', { extra: { feePayer: 'not-an-address' } }, 'invalid_option'],
  ])('refuses %s before the spend limits count it', async (_name, overrides, reason) => {
    await startNewDay();
    const before = rpc.calls.length;

    expect(await sign(solanaOption('1000', overrides))).toMatchObject({ status: 422, body: { error: { code: 'signing_refused' } } });
    expect(lines.filter(line => line['msg'] === 'Refused to sign a routed payment').at(-1)).toMatchObject({ reason });
    expect(await spentToday(solana)).toBe(0n);
    expect(rpc.calls.length).toBe(before);
  });

  it('never logs the RPC\'s key, a signed transaction, or the wallet\'s key', () => {
    const logged = JSON.stringify(lines);

    expect(transactions.length).toBeGreaterThan(2);
    for (const transaction of transactions)
      expect(logged).not.toContain(transaction);
    expect(logged).not.toContain(rpcKey);
  });
});

describe('the Signer\'s startup with a Solana wallet', () => {
  const envWith = (key: string, extra: Record<string, string> = {}) => ({
    CONFIG_PATH: 'config/example.yaml', SIGNER_SECRET: secret, SIGNER_SOLANA_KEY: key, DATABASE_URL: database.url.expose(), REDIS_URL: redis.url.expose(),
    HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0', SOLANA_RPC_URL: `https://solana.rpc.test/${rpcKey}`, ...extra,
  });

  it('takes SIGNER_SOLANA_KEY in base58 and as a JSON array, with the same address, and logs it and the RPC\'s host, never the key', async () => {
    const bytes = solanaKeyBytes();
    const address = (await createKeyPairSignerFromBytes(Uint8Array.from(bytes))).address;
    const base58 = encodeBase58(bytes);
    const array = JSON.stringify([...bytes]);
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });

    for (const key of [base58, array]) {
      const app = await startSigner({ env: envWith(key), logger });
      await app.close();
    }

    expect(startLines.filter(line => line['msg'] === 'Started')).toEqual([
      expect.objectContaining({ wallets: { base: null, tempo: null, solana: address }, solanaRpc: 'solana.rpc.test' }),
      expect.objectContaining({ wallets: { base: null, tempo: null, solana: address }, solanaRpc: 'solana.rpc.test' }),
    ]);
    const logged = JSON.stringify(startLines);
    for (const value of [base58, array, rpcKey])
      expect(logged).not.toContain(value);
  });

  it('starts when the key\'s address is signer.wallets.solana, and warns without SOLANA_RPC_URL', async () => {
    const bytes = solanaKeyBytes();
    const address = (await createKeyPairSignerFromBytes(Uint8Array.from(bytes))).address;
    const startLines: Record<string, unknown>[] = [];
    const logger = createLogger({}, { write: (line: string) => startLines.push(JSON.parse(line) as Record<string, unknown>) });
    const withWallet = { CONFIG: Buffer.from(JSON.stringify({ signer: { wallets: { solana: address } } })).toString('base64'), SOLANA_RPC_URL: '' };

    const app = await startSigner({ env: envWith(encodeBase58(bytes), withWallet), logger });
    await app.close();

    expect(startLines.find(line => line['msg'] === 'Started')).toMatchObject({ wallets: { solana: address }, solanaRpc: 'api.devnet.solana.com' });
    expect(startLines.find(line => line['level'] === 40)).toMatchObject({ host: 'api.devnet.solana.com', msg: expect.stringMatching(/^SOLANA_RPC_URL is not set/) });
  });

  it('won\'t start when the key\'s address isn\'t signer.wallets.solana, or the key isn\'t a 64-byte Solana key, without echoing it', async () => {
    const bytes = solanaKeyBytes();
    const base58 = encodeBase58(bytes);
    const other = (await generateKeyPairSigner()).address;
    const logger = createLogger({ level: 'silent' });
    const withWallet = { CONFIG: Buffer.from(JSON.stringify({ signer: { wallets: { solana: other } } })).toString('base64') };

    await expect(startSigner({ env: envWith(base58, withWallet), logger })).rejects.toThrow(/^SIGNER_SOLANA_KEY's address, \w+, isn't signer\.wallets\.solana, \w+$/);
    for (const invalid of [base58.slice(0, 40), '[1,2,3]', 'not-base58-0OIl', `[${[...bytes.slice(0, 32), ...bytes.slice(0, 32)].join(',')}]`]) {
      const failure = await startSigner({ env: envWith(invalid), logger }).then(() => undefined, (error: unknown) => error as Error);

      expect(failure?.message).toMatch(/^SIGNER_SOLANA_KEY (must be a 64-byte Solana secret key|is not a valid Solana key pair)/);
      expect(failure?.message).not.toContain(invalid);
    }
  });
});
