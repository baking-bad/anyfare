import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';

import { decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { createClientNearSigner, decodeSignedDelegateB64, NEAR_RPC_URLS, parseFtTransferArgs } from '@x402/near';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, Secret, type MicroUsd } from '@anyfare/common';
import { RedisNotReadyError } from '@anyfare/db';
import { findAsset, loadPlatformConfig, publicNearRpcUrls, type PlatformConfig } from '@anyfare/core';
import type { NewSignature } from '@anyfare/db';
import { createFakeClock, createFakeIdGenerator, fixtureTime, generateNearKey, startFakeNearRpc, type FakeNearRpc } from '@anyfare/testing';

import { createNearPayer, nearLeaseMs, NearRpcError, NearStoreError, readNearAccessKey, type NearLease, type NearPayerStore } from '../src/near.js';
import { createSigner, PayerBusyError, SigningFailedError, SigningRefusedError, type SignerOptions, type SignRequest } from '../src/sign.js';
import type { SpendEntry, SpendLimits, SpendReservation } from '../src/spend.js';

const near = 'near:testnet';
const hotWallet = 'hot.anyfare.testnet';
const payTo = 'api.target.testnet';
const resource = 'https://api.target.test/v1/forecast';
const windows = { hour: 1_000, day: 41 };
// The sign's budget, the proxy's call timeout: each read attempt gets 750 ms, and a repeat only fits early
const budgetMs = 2_000;
const attemptMs = 750;

// $0.05 per call
const config: PlatformConfig = await loadPlatformConfig({
  env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ signer: { maxPerCall: '0.05' } })).toString('base64') },
});
const usdc = findAsset(config, 'near-usdc')!.address;
const clock = createFakeClock(fixtureTime(0, 12, 9, 30, 0, 0));
const key = generateNearKey();

/** The Signer's Redis, in memory: the payer's lease, the released quotes, the last nonces, what was asked of them, and what fails. */
const memoryStore = () => {
  const leases = new Map<string, string>();
  const releasedQuotes = new Set<string>();
  const nonces = new Map<string, bigint>();
  const taken: { readonly lease: NearLease; readonly lifetimeMs: number }[] = [];
  const released: NearLease[] = [];
  const failing = { takeLease: false, lastNonce: false, saveNonce: false };
  const store: NearPayerStore = {
    takeLease: async (lease, lifetimeMs) => {
      taken.push({ lease, lifetimeMs });
      if (failing.takeLease)
        throw new Error('the connection was reset');
      if (releasedQuotes.has(lease.quoteId))
        return 'released';
      if (leases.has(lease.accountId))
        return 'busy';
      leases.set(lease.accountId, lease.quoteId);

      return 'taken';
    },
    releaseLease: async lease => {
      released.push(lease);
      if (leases.get(lease.accountId) !== lease.quoteId) {
        releasedQuotes.add(lease.quoteId);
        return false;
      }
      leases.delete(lease.accountId);

      return true;
    },
    lastNonce: async (accountId, publicKey) => {
      if (failing.lastNonce)
        throw new Error('the connection was reset');

      return nonces.get(`${accountId}:${publicKey}`);
    },
    saveNonce: async (accountId, publicKey, nonce) => {
      if (failing.saveNonce)
        throw new Error('the connection was reset');
      nonces.set(`${accountId}:${publicKey}`, nonce);
    },
  };

  return { store, leases, releasedQuotes, nonces, taken, released, failing };
};

const nearOption = (amount: string, overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: near, amount, asset: usdc, payTo, maxTimeoutSeconds: 60, ...overrides,
});

const requirementOf = (option: Record<string, unknown>) => option as unknown as PaymentRequirements;

const closedPort = async (): Promise<number> => {
  const listener = createNetServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise(resolve => listener.close(resolve));

  return port;
};

let rpc: FakeNearRpc;
// Accepts connections and never answers
let silent: NetServer;
let silentUrl: string;
const silentSockets = new Set<Socket>();
let silentConnections = 0;

beforeAll(async () => {
  rpc = await startFakeNearRpc();
  rpc.addAccount({ accountId: hotWallet, publicKey: key.publicKey });
  silent = createNetServer(socket => {
    silentConnections += 1;
    silentSockets.add(socket);
    socket.on('close', () => silentSockets.delete(socket));
  });
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
  silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await rpc?.close();
  for (const socket of silentSockets)
    socket.destroy();
  await new Promise(resolve => silent?.close(resolve));
});

beforeEach(() => {
  rpc.reset();
});

const payerWith = (store: Pick<NearPayerStore, 'lastNonce' | 'saveNonce'>, rpcUrl = rpc.url) =>
  createNearPayer({ wallet: { accountId: hotWallet, secretKey: Secret.from(key.secretKey), rpcUrl: Secret.from(rpcUrl) }, store, budgetMs });

describe('the NEAR hot wallet\'s client signer', () => {
  it('signs the same bytes as the x402 SDK\'s client signer for the same chain state', async () => {
    const twin = await startFakeNearRpc({ height: rpc.height });
    const nonce = rpc.nonceOf(hotWallet, key.publicKey)!;
    twin.addAccount({ accountId: hotWallet, publicKey: key.publicKey, nonce });
    const requirement = requirementOf(nearOption('10000'));
    try {
      const ours = await payerWith(memoryStore().store).createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirement });
      const sdk = await createClientNearSigner({ accountId: hotWallet, secretKey: key.secretKey, rpcUrls: { [near]: twin.url } })
        .createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirement });

      expect(ours).toBe(sdk);
      const { delegate, verifySignature } = decodeSignedDelegateB64(ours);
      expect(delegate).toMatchObject({ senderId: hotWallet, receiverId: usdc, publicKey: key.publicKey, nonce: nonce + 1n, maxBlockHeight: rpc.height + 60n, actionCount: 1 });
      expect(delegate.functionCall).toMatchObject({ methodName: 'ft_transfer', gas: 30_000_000_000_000n, deposit: 1n });
      expect(parseFtTransferArgs(delegate.functionCall!.args)).toEqual({ receiver_id: payTo, amount: '10000' });
      expect(verifySignature()).toBe(true);
    }
    finally {
      await twin.close();
    }
  });

  it('reads the key\'s nonce and the height at final, and remembers the nonce it signed', async () => {
    const { store, nonces } = memoryStore();

    await payerWith(store).createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirementOf(nearOption('1000')) });

    expect(rpc.calls).toEqual(expect.arrayContaining([
      { method: 'block', params: { finality: 'final' } },
      { method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: hotWallet, public_key: key.publicKey } },
    ]));
    expect(nonces.get(`${hotWallet}:${key.publicKey}`)).toBe(rpc.nonceOf(hotWallet, key.publicKey)! + 1n);
  });

  it('signs the last nonce it signed plus one while the chain still shows an older one, and the chain\'s plus one once it is higher', async () => {
    const { store, nonces } = memoryStore();
    const payer = payerWith(store);
    const chain = rpc.nonceOf(hotWallet, key.publicKey)!;
    const sign = async () => decodeSignedDelegateB64(await payer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirementOf(nearOption('1000')) })).delegate.nonce;

    expect(await sign()).toBe(chain + 1n);
    expect(await sign()).toBe(chain + 2n);
    nonces.set(`${hotWallet}:${key.publicKey}`, chain + 10n);
    expect(await sign()).toBe(chain + 11n);
    rpc.addAccount({ accountId: hotWallet, publicKey: key.publicKey, nonce: chain + 50n });
    expect(await sign()).toBe(chain + 51n);
  });

  it('maps the option\'s timeout to blocks as the SDK does: one a second', async () => {
    const payer = payerWith(memoryStore().store);

    for (const seconds of [1, 300]) {
      const signed = await payer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirementOf(nearOption('1000', { maxTimeoutSeconds: seconds })) });

      expect(decodeSignedDelegateB64(signed).delegate.maxBlockHeight).toBe(rpc.height + BigInt(seconds));
    }
  });

  it('repeats a read once when the RPC answers 503 at once, then fails with no URL in its message', async () => {
    const path = '/near-rpc-key-secret';
    const payer = payerWith(memoryStore().store, `${rpc.url}${path}`);
    rpc.unavailable(true);

    const failure = await payer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirementOf(nearOption('1000')) }).then(() => new Error('signed'), (error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(NearRpcError);
    expect(failure.message).toBe('The NEAR RPC answered HTTP 503');
    expect(rpc.calls.filter(call => call.method === 'block')).toHaveLength(2);
    expect(rpc.calls.filter(call => call.method === 'query')).toHaveLength(2);
  });

  it('fails within its budget on an RPC that never answers, with no repeat that couldn\'t end in time, and on one that refuses connections', async () => {
    const started = performance.now();
    const connections = silentConnections;
    const silentFailure = await payerWith(memoryStore().store, silentUrl)
      .createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirementOf(nearOption('1000')) })
      .then(() => new Error('signed'), (error: unknown) => error as Error);

    expect(silentFailure.message).toBe(`The NEAR RPC didn't answer within ${attemptMs} ms`);
    expect(performance.now() - started).toBeLessThan(budgetMs - 500);
    // One block read and one view_access_key read, both in parallel, neither repeated
    expect(silentConnections - connections).toBe(2);

    const refusedUrl = `http://127.0.0.1:${await closedPort()}/near-rpc-key-secret`;
    const refused = await payerWith(memoryStore().store, refusedUrl)
      .createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirementOf(nearOption('1000')) })
      .then(() => new Error('signed'), (error: unknown) => error as Error);

    expect(refused.message).toMatch(/^The NEAR RPC is unreachable/);
    expect(refused.message).not.toContain('near-rpc-key-secret');
    expect(refused.message).not.toContain('127.0.0.1');
  });

  it('fails without signing when its key isn\'t an access key of the account, and remembers no nonce', async () => {
    const { store, nonces } = memoryStore();
    const other = generateNearKey();
    const payer = createNearPayer({
      wallet: { accountId: hotWallet, secretKey: Secret.from(other.secretKey), rpcUrl: Secret.from(rpc.url) }, store, budgetMs,
    });

    await expect(payer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirementOf(nearOption('1000')) }))
      .rejects.toThrow(`The hot wallet's key isn't an access key of ${hotWallet}`);
    expect(nonces.size).toBe(0);
  });

  it('holds its key in no field, and refuses a key that isn\'t one without echoing it', () => {
    const payer = payerWith(memoryStore().store);
    const secretPart = key.secretKey.slice('ed25519:'.length);

    expect(payer.publicKey).toBe(key.publicKey);
    expect(JSON.stringify(payer)).not.toContain(secretPart);
    for (const invalid of ['ed25519:abc', 'not-a-key', key.secretKey.slice(0, 20)]) {
      const failure = (() => {
        try {
          createNearPayer({ wallet: { accountId: hotWallet, secretKey: Secret.from(invalid), rpcUrl: Secret.from(rpc.url) }, store: memoryStore().store, budgetMs });
        }
        catch (error) {
          return error as Error;
        }

        return undefined;
      })();

      expect(failure?.message).toBe('The NEAR key isn\'t ed25519: and a base58 key');
    }
  });

  it('holds a lease for the payment\'s window at the SDK\'s second a block, plus a minute', () => {
    expect(nearLeaseMs(1)).toBe(61_000);
    expect(nearLeaseMs(60)).toBe(120_000);
    expect(nearLeaseMs(300)).toBe(360_000);
  });

  it('says a failure of the store\'s nonce apart from the RPC\'s', async () => {
    const memory = memoryStore();
    memory.failing.lastNonce = true;

    const failure = await payerWith(memory.store).createSignedDelegateAction({ x402Version: 2, paymentRequirements: requirementOf(nearOption('1000')) })
      .then(() => new Error('signed'), (error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(NearStoreError);
    expect(failure.cause).toMatchObject({ message: 'the connection was reset' });
  });

  it('falls back to the x402 SDK\'s own public NEAR RPCs', () => {
    expect(publicNearRpcUrls).toEqual(NEAR_RPC_URLS);
  });
});

describe('the startup check\'s view of the key', () => {
  // Answers every call with nearcore's UNKNOWN_ACCOUNT error, as a node does for an account it doesn't know
  const startUnknownAccountNode = async () => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          jsonrpc: '2.0', id: 'anyfare-signer',
          error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: hotWallet } }, code: -32000, message: 'Server error', data: 'unknown' },
        }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise(resolve => server.close(resolve)) };
  };

  it('reads a full-access key, a function-call key, a key the account doesn\'t have, and an account the node doesn\'t know', async () => {
    const limited = generateNearKey();
    const missing = generateNearKey();
    rpc.addAccount({
      accountId: hotWallet, publicKey: limited.publicKey, permission: { FunctionCall: { allowance: null, receiver_id: usdc, method_names: ['ft_transfer'] } },
    });
    const view = (publicKey: string, rpcUrl = rpc.url) => readNearAccessKey({ rpcUrl: Secret.from(rpcUrl), accountId: hotWallet, publicKey, budgetMs });
    const unknown = await startUnknownAccountNode();
    try {
      expect(await view(key.publicKey)).toEqual({ kind: 'key', nonce: rpc.nonceOf(hotWallet, key.publicKey), permission: 'FullAccess' });
      expect(await view(limited.publicKey)).toMatchObject({ kind: 'key', permission: 'FunctionCall' });
      expect(await view(missing.publicKey)).toEqual({ kind: 'no_key' });
      expect(await view(key.publicKey, unknown.url)).toEqual({ kind: 'no_account' });
    }
    finally {
      await unknown.close();
    }
  });
});

describe('the Signer\'s NEAR payments, in order', () => {
  const recorded: NewSignature[] = [];
  const reservations: { readonly network: string; readonly amount: MicroUsd }[] = [];
  const releases: SpendEntry[] = [];
  let nextReservation: Omit<SpendReservation, 'windows'> | undefined;
  let recordFails = false;
  const spend: SpendLimits = {
    reserve: async input => {
      reservations.push(input);

      return { ...nextReservation ?? { refusal: undefined, hour: input.amount, day: input.amount }, windows };
    },
    release: async entry => {
      releases.push(entry);
    },
    add: async () => undefined,
  };
  const logger = createLogger({ level: 'silent' });
  let memory: ReturnType<typeof memoryStore>;

  const signerWith = (options: Partial<SignerOptions> = {}) => createSigner({
    config, wallets: { near: { accountId: hotWallet, secretKey: Secret.from(key.secretKey), rpcUrl: Secret.from(rpc.url) } }, spend, nearStore: memory.store,
    signatures: {
      recordSignature: async signature => {
        if (recordFails)
          throw new Error('the database is down');
        recorded.push(signature);
      },
    },
    clock, ids: createFakeIdGenerator(), logger, ...options,
  });

  const x402 = (requirement: Record<string, unknown>, quotedPrice = String(requirement['amount']), quoteId = 'pay_near_unit'): SignRequest => ({
    protocol: 'x402', requestId: 'req-near-unit', quoteId, url: resource, quotedPrice: BigInt(quotedPrice),
    x402Version: 2, requirement: requirement as unknown as PaymentRequirements, resource: { url: resource },
  });

  const failureOf = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

  beforeEach(() => {
    memory = memoryStore();
    nextReservation = undefined;
    recordFails = false;
  });

  it('takes the lease under the proxy\'s quote ID, for the payment\'s window, then reserves, signs, and records', async () => {
    const before = reservations.length;

    const signed = await signerWith().sign(x402(nearOption('10000')));

    expect(memory.taken).toEqual([{ lease: { accountId: hotWallet, quoteId: 'pay_near_unit' }, lifetimeMs: 120_000 }]);
    expect(memory.leases.get(hotWallet)).toBe('pay_near_unit');
    expect(signed.signatureId).toMatch(/^sig_/);
    expect(reservations.slice(before)).toEqual([{ network: near, amount: 10_000n }]);
    expect(recorded.at(-1)).toMatchObject({ id: signed.signatureId, network: near, asset: 'near-usdc', atomicAmount: 10_000n, amount: 10_000n, payTo });
    const { payload } = decodePaymentSignatureHeader(signed.header) as unknown as { payload: { signedDelegateAction: string } };
    expect(decodeSignedDelegateB64(payload.signedDelegateAction).delegate).toMatchObject({ senderId: hotWallet, receiverId: usdc });
  });

  it('refuses a second payment while the lease is held, with no reservation and no record', async () => {
    const signer = signerWith();
    await signer.sign(x402(nearOption('1000')));
    const before = { reservations: reservations.length, recorded: recorded.length };

    const failure = await failureOf(signer.sign(x402(nearOption('1000'), '1000', 'pay_near_second')));

    expect(failure).toBeInstanceOf(PayerBusyError);
    expect(failure).toMatchObject({ code: 'payer_busy', message: 'A NEAR payment from the hot wallet is in flight: retry in a moment' });
    expect(reservations.length).toBe(before.reservations);
    expect(recorded.length).toBe(before.recorded);
  });

  it('releases the lease when its quote asks, and only then', async () => {
    const signer = signerWith();
    await signer.sign(x402(nearOption('1000'), '1000', 'pay_near_held'));

    expect(await signer.release('pay_near_another')).toBe(false);
    expect(memory.leases.get(hotWallet)).toBe('pay_near_held');
    expect(await signer.release('pay_near_held')).toBe(true);
    expect(await signer.release('pay_near_held')).toBe(false);
    expect((await signer.sign(x402(nearOption('1000'), '1000', 'pay_near_next'))).network).toBe(near);
  });

  it('refuses a quote the proxy released before it was signed (quote_released): no lease, no reservation, no read, no record', async () => {
    const signer = signerWith();
    const before = { reservations: reservations.length, recorded: recorded.length, calls: rpc.calls.length };

    expect(await signer.release('pay_near_abandoned')).toBe(false);
    const failure = await failureOf(signer.sign(x402(nearOption('1000'), '1000', 'pay_near_abandoned')));

    expect(failure).toBeInstanceOf(SigningRefusedError);
    expect(failure).toMatchObject({ code: 'signing_refused', reason: 'quote_released', message: 'The proxy released this quote before it was signed' });
    expect(memory.taken).toEqual([{ lease: { accountId: hotWallet, quoteId: 'pay_near_abandoned' }, lifetimeMs: 120_000 }]);
    expect(memory.leases.size).toBe(0);
    expect(reservations.length).toBe(before.reservations);
    expect(recorded.length).toBe(before.recorded);
    expect(rpc.calls.length).toBe(before.calls);
    // Another quote still signs
    expect((await signer.sign(x402(nearOption('1000'), '1000', 'pay_near_after'))).network).toBe(near);
  });

  it('releases nothing without a NEAR wallet', async () => {
    expect(await signerWith({ wallets: {} }).release('pay_any')).toBe(false);
  });

  it('releases the lease when a spend limit refuses', async () => {
    nextReservation = { refusal: 'daily_limit', hour: 95_000n, day: 95_000n };

    expect(await failureOf(signerWith().sign(x402(nearOption('10000'))))).toMatchObject({ reason: 'daily_limit' });
    expect(memory.leases.size).toBe(0);
  });

  it('gives the reservation back and releases the lease when the RPC fails: 502 signing_failed', async () => {
    const before = releases.length;
    rpc.unavailable(true);

    const failure = await failureOf(signerWith().sign(x402(nearOption('10000'))));

    expect(failure).toBeInstanceOf(SigningFailedError);
    expect(failure).toMatchObject({ code: 'signing_failed', message: 'The Signer couldn\'t build the NEAR payment: the NEAR RPC failed', reason: 'The NEAR RPC answered HTTP 503' });
    expect(releases.slice(before)).toEqual([{ network: near, amount: 10_000n, windows }]);
    expect(memory.leases.size).toBe(0);
  });

  it('releases the lease and keeps the reservation when the signature can\'t be recorded', async () => {
    const before = releases.length;
    recordFails = true;

    await expect(signerWith().sign(x402(nearOption('10000')))).rejects.toThrow('the database is down');

    expect(releases.length).toBe(before);
    expect(memory.leases.size).toBe(0);
  });

  it('takes no reservation when taking the lease fails, frees it in case Redis set it, and throws the first error', async () => {
    const before = reservations.length;
    memory.failing.takeLease = true;

    await expect(signerWith().sign(x402(nearOption('1000')))).rejects.toThrow('the connection was reset');
    expect(reservations.length).toBe(before);
    expect(memory.released).toEqual([{ accountId: hotWallet, quoteId: 'pay_near_unit' }]);
  });

  it.each(['lastNonce', 'saveNonce'] as const)('answers Redis down when %s fails: the reservation goes back and the lease is freed', async failing => {
    const before = { releases: releases.length, recorded: recorded.length };
    memory.failing[failing] = true;

    const failure = await failureOf(signerWith().sign(x402(nearOption('10000'))));

    expect(failure).toBeInstanceOf(RedisNotReadyError);
    expect(failure).toMatchObject({ code: 'redis_not_ready' });
    expect(releases.slice(before.releases)).toEqual([{ network: near, amount: 10_000n, windows }]);
    expect(recorded.length).toBe(before.recorded);
    expect(memory.leases.size).toBe(0);
  });

  it.each([
    ['an option paying the hot wallet', nearOption('1000', { payTo: hotWallet }), '1000', 'invalid_pay_to'],
    ['an option paying the registry asset\'s payTo', nearOption('1000', { payTo: 'pay.anyfare.testnet' }), '1000', 'invalid_pay_to'],
    ['our own account before an invalid amount', nearOption('nope', { payTo: hotWallet }), '1000', 'invalid_pay_to'],
    ['another token', nearOption('1000', { asset: 'usdt.fakes.testnet' }), '1000', 'not_in_registry'],
    ['the mainnet contract on testnet', nearOption('1000', { asset: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' }), '1000', 'not_in_registry'],
    ['maxTimeoutSeconds of 301', nearOption('1000', { maxTimeoutSeconds: 301 }), '1000', 'invalid_timeout'],
    ['a non-empty extra', nearOption('1000', { extra: { memo: 'pay' } }), '1000', 'invalid_option'],
    ['a payTo that isn\'t an account ID', nearOption('1000', { payTo: 'Not An Account' }), '1000', 'invalid_pay_to'],
    ['above the quote', nearOption('20000'), '19999', 'above_quote'],
    ['above the per-call maximum', nearOption('60000'), '60000', 'above_max_per_call'],
  ])('refuses %s before the lease and the limits', async (_name, requirement, quotedPrice, reason) => {
    const before = reservations.length;
    const calls = rpc.calls.length;

    const failure = await failureOf(signerWith().sign(x402(requirement, quotedPrice)));

    expect(failure).toBeInstanceOf(SigningRefusedError);
    expect(failure).toMatchObject({ reason });
    expect(memory.taken).toEqual([]);
    expect(reservations.length).toBe(before);
    expect(rpc.calls.length).toBe(calls);
  });

  it('refuses a NEAR option without a NEAR wallet (no_wallet)', async () => {
    expect(await failureOf(signerWith({ wallets: {} }).sign(x402(nearOption('1000'))))).toMatchObject({ reason: 'no_wallet', message: 'The Signer holds no wallet on NEAR testnet' });
  });

  it('needs a store for the lease with a NEAR wallet', () => {
    expect(() => createSigner({
      config, wallets: { near: { accountId: hotWallet, secretKey: Secret.from(key.secretKey), rpcUrl: Secret.from(rpc.url) } }, spend,
      signatures: { recordSignature: async () => undefined }, clock, ids: createFakeIdGenerator(), logger,
    })).toThrow('A NEAR wallet needs a store for its lease and nonces');
  });
});
