import { randomUUID } from 'node:crypto';

import { generateKeyPairSigner } from '@solana/kit';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, Secret, type Server } from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import type { Postgres } from '@anyfare/db';
import {
  createTestRedis, defaultOneClickTokens, generateNearKey, startFakeNearRpc, startFakeOneClick, type FakeNearRpc, type FakeOneClick, type FakeOneClickAnswer,
  type FakeOneClickToken, type TestRedis,
} from '@anyfare/testing';
import { createOneClickClient } from '@anyfare/topups';

import { createApp, type SignerDependencies } from '../../src/app.js';
import { createRedisNearPayerStore } from '../../src/near.js';
import { refillIdKeyPrefix, refillSpendKeyPrefix } from '../../src/refillStore.js';
import { spendKeyPrefix } from '../../src/spend.js';

// The Signer refills its hot wallets on Base and Solana from its NEAR hot wallet: it asks the fake 1Click
// for a quote, checks it, and pays it on the fake NEAR node in one transaction, with real Redis for the
// replay records, the day's counters and the payer's lease.

const secret = 'signer-secret-0123456789abcdef-0123456789';
// Made-up accounts and keys: the NEAR hot wallet, and the Base and Solana wallets that receive refills
const hotWallet = 'hot.anyfare.testnet';
const key = generateNearKey();
const baseWallet = privateKeyToAccount(generatePrivateKey());
const solanaWallet = await generateKeyPairSigner();
// A key in the RPC's path, as some providers put it: no log line or answer may hold it
const rpcKey = 'signer-near-rpc-key-secret';
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

// Rebalancing on, with the example's limits but $15 a day per asset, so two refills reach it. A second a
// read and a send, and lookups for a second and a half after a send without an answer.
const configWith = (rebalancing: Record<string, unknown> = {}): Promise<PlatformConfig> => loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: base64({
      timeouts: { connectMs: 1_000, settleMs: 1_500 },
      signer: { wallets: { base: baseWallet.address, solana: solanaWallet.address, near: hotWallet } },
      rebalancing: { enabled: true, mostPerAssetPerDay: '15', ...rebalancing },
    }),
  },
});
const config = await configWith();
const usdc = findAsset(config, 'near-usdc')!.address;
// 1Click lists no testnet tokens: example.yaml's USDC on Base Sepolia and Solana Devnet under made-up asset IDs
const testnetToken = (assetId: string, blockchain: string, asset: string): FakeOneClickToken => ({
  assetId, decimals: 6, blockchain, symbol: 'USDC', price: 0.99948, priceUpdatedAt: '2026-11-11T09:00:00.000Z', contractAddress: findAsset(config, asset)!.address,
});
const tokens = [
  ...defaultOneClickTokens, testnetToken('nep141:base-sepolia-usdc.fakes.near', 'base', 'base-usdc'), testnetToken('nep141:sol-devnet-usdc.fakes.near', 'sol', 'solana-usdc'),
];
// The hot wallet's USDC on NEAR at the start of each test: $100
const funded = 100_000_000n;

// Refills touch Redis only: the signatures table is never read
const postgres: Postgres = { db: undefined as never, ping: async () => undefined, tryAdvisoryLock: async () => undefined, close: async () => undefined };

let redis: TestRedis;
let rpc: FakeNearRpc;
let oneClick: FakeOneClick;
let server: Server;
const servers: Server[] = [];
// Every line any Signer here writes, debug included, and every answer it gave
const lines: Record<string, unknown>[] = [];
const texts: string[] = [];
const capture = () => createLogger({ level: 'debug' }, {
  write: (line: string) => {
    texts.push(line);
    lines.push(JSON.parse(line) as Record<string, unknown>);
  },
});
const lastLine = (msg: string): Record<string, unknown> | undefined => lines.filter(line => line['msg'] === msg).at(-1);

const nearWallet = () => ({ accountId: hotWallet, secretKey: Secret.from(key.secretKey), rpcUrl: Secret.from(`${rpc.url}/${rpcKey}`) });

const appWith = (changes: Partial<SignerDependencies> = {}): Server => {
  const app = createApp({
    config, logger: capture(), postgres, redis, secret: Secret.from(secret), signatures: { recordSignature: async () => undefined },
    wallets: { base: baseWallet, solana: solanaWallet, near: nearWallet() },
    oneClick: createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 }),
    refillPollMs: 100,
    ...changes,
  });
  servers.push(app);

  return app;
};

beforeAll(async () => {
  [redis, rpc, oneClick] = await Promise.all([createTestRedis(), startFakeNearRpc(), startFakeOneClick({ tokens })]);
  rpc.addAccount({ accountId: hotWallet, publicKey: key.publicKey });
  rpc.addToken({ contractId: usdc, balances: { [hotWallet]: funded } });
  server = appWith();
});

afterAll(async () => {
  await Promise.all(servers.map(item => item.close()));
  await Promise.all([rpc?.close(), oneClick?.close()]);
  await redis?.cleanup();
});

// Each test starts a new day for the counters, with the hot wallet funded and the fakes at their defaults
beforeEach(async () => {
  rpc.reset();
  oneClick.reset();
  rpc.setBalance(usdc, hotWallet, funded);
  for await (const keys of redis.client.scanIterator({ MATCH: `${redis.prefix}${refillSpendKeyPrefix}*`, COUNT: 100 })) {
    if (keys.length > 0)
      await redis.client.unlink(keys);
  }
});

const ask = async (body: Record<string, unknown>, on = server) => {
  const response = await on.app.inject({
    method: 'POST', url: '/internal/v1/refills', headers: { 'content-type': 'application/json', 'x-signer-secret': secret }, payload: JSON.stringify(body),
  });
  texts.push(response.body);

  return { status: response.statusCode, body: response.json() as Record<string, any> };
};

// A refill of the amount in micro-USD, under a new ID unless one is given
const refill = async (amount: string, { refillId = `ref-${randomUUID()}`, asset = 'base-usdc', on = server } = {}) =>
  ({ ...await ask({ refillId, asset, amount }, on), refillId });

// The day's refills of an asset, in micro-USD
const spentToday = async (asset: string): Promise<bigint> => {
  let total = 0n;
  for await (const keys of redis.client.scanIterator({ MATCH: `${redis.prefix}${refillSpendKeyPrefix}${asset}:day:*`, COUNT: 100 })) {
    for (const item of keys)
      total += BigInt(await redis.client.get(item) ?? '0');
  }

  return total;
};

const recordOf = (refillId: string) => redis.client.get(`${redis.prefix}${refillIdKeyPrefix}${refillId}`);
const sends = () => rpc.calls.filter(call => call.method === 'send_tx').length;
const quotes = () => oneClick.requests.filter(request => request.path === '/v0/quote').length;

// 1Click's default quote, changed
const changeQuote = (change: (body: Record<string, any>) => Record<string, any>) => {
  oneClick.handle('/v0/quote', (_request, next): FakeOneClickAnswer => {
    const answer = next();

    return { ...answer, body: change(answer.body as Record<string, any>) };
  });
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 5_000)
      throw new Error('The condition never held');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

describe('a refill through 1Click', () => {
  it('asks 1Click to deliver exactly the amount to our Base wallet, pays amountIn in one transaction that registers the deposit address, and answers it again for its ID', async () => {
    const before = { transactions: rpc.directTransactions.length, quotes: quotes() };

    const first = await refill('5000000');

    expect(first.status).toBe(200);
    const { body } = first;
    // The least amountIn whose value, less 1 basis point, covers $5
    expect(body).toEqual({
      refillId: first.refillId, asset: 'base-usdc', amount: '5000000', depositAddress: expect.stringMatching(/^[0-9a-f]{64}$/), amountIn: '5000501',
      amountOut: '5000000', quoteDeadline: expect.any(String), correlationId: expect.any(String), transactionHash: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
      quote: oneClick.quotes().at(-1),
    });
    // The quote: exactly $5 of USDC on Base Sepolia to our Base wallet, paid with USDC on NEAR, refunds to the hot wallet
    const sent = oneClick.requests.filter(request => request.path === '/v0/quote').at(-1)!.body as Record<string, unknown>;
    expect(sent).toEqual({
      dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: 50, originAsset: `nep141:${usdc}`, depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:base-sepolia-usdc.fakes.near', amount: '5000000', refundTo: hotWallet, refundType: 'ORIGIN_CHAIN', recipient: baseWallet.address,
      recipientType: 'DESTINATION_CHAIN', deadline: expect.any(String), depositMode: 'SIMPLE',
    });
    // 30 minutes from now
    expect(Date.parse(String(sent['deadline'])) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(Date.parse(String(sent['deadline'])) - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    // The answer carries that deadline, not the quote's own, when the deposit address goes inactive
    expect(body['quoteDeadline']).toBe(sent['deadline']);
    expect(body['quoteDeadline']).not.toBe(oneClick.quotes().at(-1)!.quote.deadline);
    // One transaction to the token: storage_deposit for the new address at the token's minimum, then ft_transfer of amountIn with 1 yoctoNEAR
    expect(rpc.directTransactions).toHaveLength(before.transactions + 1);
    const transaction = rpc.directTransactions.at(-1)!;
    expect(transaction).toMatchObject({ hash: body['transactionHash'], signerId: hotWallet, publicKey: key.publicKey, receiverId: usdc, status: 'success' });
    expect(transaction.calls).toEqual([
      { methodName: 'storage_deposit', args: { account_id: body['depositAddress'], registration_only: true }, gas: 30_000_000_000_000n, deposit: 1_250_000_000_000_000_000_000n },
      { methodName: 'ft_transfer', args: { receiver_id: body['depositAddress'], amount: '5000501' }, gas: 30_000_000_000_000n, deposit: 1n },
    ]);
    expect(rpc.balanceOf(usdc, hotWallet)).toBe(funded - 5_000_501n);
    expect(rpc.balanceOf(usdc, body['depositAddress'])).toBe(5_000_501n);
    // What left the hot wallet counts toward the day, under its own keys; routed payments' counters are untouched
    expect(await spentToday('base-usdc')).toBe(5_000_501n);
    expect(await redis.client.keys(`${redis.prefix}${spendKeyPrefix}*`)).toEqual([]);
    expect(await server.metrics.registry.metrics()).toContain('signer_refills_usd_total{asset="base-usdc"} 5');
    expect(lastLine('Refilled a hot wallet')).toMatchObject({
      level: 30, refillId: first.refillId, asset: 'base-usdc', amount: '5', amountIn: '5000501', amountOut: '5000000', fee: '0.000501', depositAddress: body['depositAddress'],
      transactionHash: body['transactionHash'], registers: true, result: 'sent', durationMs: expect.any(Number),
    });

    // The same ID: the same answer, and nothing quoted or sent
    const calls = rpc.calls.length;
    const again = await refill('5000000', { refillId: first.refillId });

    expect(again).toEqual(first);
    expect(rpc.calls).toHaveLength(calls);
    expect(rpc.directTransactions).toHaveLength(before.transactions + 1);
    expect(quotes()).toBe(before.quotes + 1);
    expect(rpc.balanceOf(usdc, hotWallet)).toBe(funded - 5_000_501n);
    expect(await redis.client.ttl(`${redis.prefix}${refillIdKeyPrefix}${first.refillId}`)).toBeGreaterThan(7 * 86_400 - 60);

    // The same ID for another amount or asset: a conflict, and nothing done
    const conflict = { status: 409, body: { error: { code: 'refill_id_conflict', message: 'This refill ID was asked for another asset or amount' } } };
    expect(await refill('5000001', { refillId: first.refillId })).toMatchObject(conflict);
    expect(await refill('5000000', { refillId: first.refillId, asset: 'solana-usdc' })).toMatchObject(conflict);
    expect(rpc.calls).toHaveLength(calls);
    expect(quotes()).toBe(before.quotes + 1);
    expect(JSON.parse(String(await recordOf(first.refillId)))).toMatchObject({ state: 'sent', answer: { amount: '5000000', asset: 'base-usdc' } });
  });

  it('sends only ft_transfer when the token has registered the deposit address', async () => {
    changeQuote(body => {
      rpc.register(usdc, body['quote']['depositAddress']);

      return body;
    });

    const { status, body } = await refill('3000000', { asset: 'solana-usdc' });

    expect(status).toBe(200);
    expect(rpc.directTransactions.at(-1)!.calls).toEqual([
      { methodName: 'ft_transfer', args: { receiver_id: body['depositAddress'], amount: body['amountIn'] }, gas: 30_000_000_000_000n, deposit: 1n },
    ]);
    expect(rpc.balanceOf(usdc, body['depositAddress'])).toBe(BigInt(body['amountIn']));
    expect(oneClick.requests.at(-1)!.body).toMatchObject({ destinationAsset: 'nep141:sol-devnet-usdc.fakes.near', recipient: solanaWallet.address, amount: '3000000' });
    expect(lastLine('Refilled a hot wallet')).toMatchObject({ asset: 'solana-usdc', registers: false });
  });

  it('never logs or answers the NEAR key or the RPC\'s key', async () => {
    expect((await refill('1000000')).status).toBe(200);

    for (const text of texts) {
      expect(text).not.toContain(rpcKey);
      expect(text).not.toContain(key.secretKey.slice('ed25519:'.length));
    }
  });
});

describe('a refill refused before anything is sent', () => {
  it('is refused while rebalancing is off, and for an asset that isn\'t a target', async () => {
    const off = appWith({ config: await configWith({ enabled: false }) });
    const asked = quotes();

    expect(await refill('5000000', { on: off })).toMatchObject({
      status: 503, body: { error: { code: 'refills_off', message: 'Rebalancing is off: rebalancing.enabled is false' } },
    });
    expect(await refill('5000000', { asset: 'near-usdc' })).toMatchObject({
      status: 400, body: { error: { code: 'invalid_request', message: 'The asset isn\'t a rebalancing target. Targets: base-usdc, solana-usdc' } },
    });
    expect(await refill('5000000', { asset: 'tempo-pathusd' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(sends()).toBe(0);
    expect(quotes()).toBe(asked);
  });

  it('is refused without the NEAR wallet, the target chain\'s wallet, or a 1Click client, and says why', async () => {
    const noNear = appWith({ wallets: { base: baseWallet, solana: solanaWallet } });
    const noSolana = appWith({ wallets: { base: baseWallet, near: nearWallet() } });
    const noClient = createApp({
      config, logger: capture(), postgres, redis, secret: Secret.from(secret), signatures: { recordSignature: async () => undefined },
      wallets: { base: baseWallet, solana: solanaWallet, near: nearWallet() },
    });
    servers.push(noClient);

    expect((await refill('5000000', { on: noNear })).body).toEqual({ error: { code: 'refills_off', message: 'The Signer holds no NEAR wallet, which pays refills' } });
    expect((await refill('5000000', { on: noSolana, asset: 'solana-usdc' })).body)
      .toEqual({ error: { code: 'refills_off', message: 'The Signer holds no wallet on Solana Devnet, which a refill of solana-usdc goes to' } });
    expect((await refill('5000000', { on: noClient })).body).toEqual({ error: { code: 'refills_off', message: 'The Signer has no 1Click client' } });
    expect(sends()).toBe(0);
  });

  it('refuses an amount under the least or over the most per refill, and the ID may be asked again', async () => {
    const asked = quotes();
    const low = await refill('999999');
    const high = await refill('10000001');

    expect(low).toMatchObject({ status: 422, body: { error: { code: 'signing_refused', message: 'A refill is from 1 to 10 USD' } } });
    // The reason goes beside the error, so the workers can tell the refusals apart
    expect(high.body).toEqual({ error: { code: 'signing_refused', message: 'A refill is from 1 to 10 USD' }, reason: 'refill_amount' });
    expect(lastLine('Refused a refill')).toMatchObject({ level: 30, refillId: high.refillId, reason: 'refill_amount', result: 'refused' });
    expect(await recordOf(low.refillId)).toBeNull();
    expect(await spentToday('base-usdc')).toBe(0n);
    expect(quotes()).toBe(asked);
    // At the edges, under the same IDs
    expect((await refill('1000000', { refillId: low.refillId })).status).toBe(200);
    expect((await refill('10000000', { refillId: high.refillId })).status).toBe(200);
  });

  it('refuses a refill that would pass the day\'s cap for the asset, counting what left the hot wallet', async () => {
    const first = await refill('10000000');
    const second = await refill('5000000');

    expect(first.status).toBe(200);
    expect(first.body['amountIn']).toBe('10001001');
    // $10.001001 left the hot wallet: $5 more would pass $15
    expect(second).toMatchObject({ status: 422, body: { error: { code: 'signing_refused' } } });
    expect(lastLine('Refused a refill')).toMatchObject({ refillId: second.refillId, reason: 'daily_limit', window: 'day', spent: '10.001001', limit: '15' });
    expect(await spentToday('base-usdc')).toBe(10_001_001n);
    expect(await recordOf(second.refillId)).toBeNull();
    // Another asset has its own cap
    expect((await refill('5000000', { asset: 'solana-usdc' })).status).toBe(200);
  });

  it('takes 1Click\'s cost at the fee bound, and refuses one micro-USD more, leaving nothing reserved', async () => {
    // 2% of $5: 1Click may keep $0.10
    changeQuote(body => ({ ...body, quote: { ...body['quote'], amountIn: String(BigInt(body['quote']['amountOut']) + 100_001n) } }));
    const over = await refill('5000000');

    expect(over).toMatchObject({ status: 422, body: { error: { code: 'signing_refused', message: expect.stringContaining('is worth more than the amount plus 200 basis points') } } });
    expect(lastLine('Refused a refill')).toMatchObject({ reason: 'quote_rejected' });
    expect(await spentToday('base-usdc')).toBe(0n);
    expect(await recordOf(over.refillId)).toBeNull();
    expect(sends()).toBe(0);

    changeQuote(body => ({ ...body, quote: { ...body['quote'], amountIn: String(BigInt(body['quote']['amountOut']) + 100_000n) } }));
    const at = await refill('5000000', { refillId: over.refillId });

    expect(at).toMatchObject({ status: 200, body: { amountIn: '5100000' } });
    expect(await spentToday('base-usdc')).toBe(5_100_000n);
  });

  it('refuses a $10 refill that 1Click answers with $1000 in and out: nothing sent, nothing reserved', async () => {
    changeQuote(body => ({ ...body, quote: { ...body['quote'], amountIn: '1000000000', amountOut: '1000000000', minAmountOut: '1000000000' } }));

    const { status, body, refillId } = await refill('10000000');

    expect({ status, body }).toEqual({
      status: 422,
      body: { error: { code: 'signing_refused', message: 'The quote\'s amountOut, 1000000000, is more than 200 basis points above the 10000000 asked for' }, reason: 'quote_rejected' },
    });
    expect(lastLine('Refused a refill')).toMatchObject({ refillId, reason: 'quote_rejected' });
    expect(await spentToday('base-usdc')).toBe(0n);
    expect(await recordOf(refillId)).toBeNull();
    expect(sends()).toBe(0);
    expect(rpc.balanceOf(usdc, hotWallet)).toBe(funded);
  });

  it('refuses a quote whose deposit address is the source token\'s contract, or one of our own accounts', async () => {
    for (const account of [usdc, hotWallet, 'treasury.anyfare.testnet', 'pay.anyfare.testnet']) {
      changeQuote(body => ({ ...body, quote: { ...body['quote'], depositAddress: account } }));

      expect(await refill('5000000')).toMatchObject({
        status: 422, body: { error: { code: 'signing_refused', message: 'The quote\'s deposit address is one of our own accounts, or the source token\'s contract' } },
      });
    }
    expect(await spentToday('base-usdc')).toBe(0n);
    expect(sends()).toBe(0);
  });

  it('refuses a token whose decimals on 1Click aren\'t the registry\'s, before any quote', async () => {
    const other = await startFakeOneClick({ tokens: tokens.map(token => token.assetId === 'nep141:base-sepolia-usdc.fakes.near' ? { ...token, decimals: 18 } : token) });
    try {
      const app = appWith({ oneClick: createOneClickClient({ url: other.url, timeoutMs: 2_000 }) });

      const { status, body, refillId } = await refill('5000000', { on: app });

      expect({ status, body }).toEqual({
        status: 503, body: { error: { code: 'refills_off', message: '1Click lists base-usdc on base with 18 decimals, and the registry with 6' } },
      });
      expect(other.requests.filter(request => request.path === '/v0/quote')).toEqual([]);
      expect(await spentToday('base-usdc')).toBe(0n);
      expect(await recordOf(refillId)).toBeNull();
    }
    finally {
      await other.close();
    }
  });

  it('refuses a quote whose echoed recipient isn\'t our wallet', async () => {
    changeQuote(body => ({ ...body, quoteRequest: { ...body['quoteRequest'], recipient: '0x4444444444444444444444444444444444444444' } }));

    expect(await refill('5000000')).toMatchObject({
      status: 422, body: { error: { code: 'signing_refused', message: 'The quote\'s quoteRequest.recipient isn\'t the one asked for' } },
    });
    expect(await spentToday('base-usdc')).toBe(0n);
    expect(sends()).toBe(0);
  });

  it('answers 1Click\'s refusal as oneclick_unavailable, with its short message only', async () => {
    oneClick.handle('/v0/quote', () => ({ status: 400, body: { message: 'Amount is too low for bridge', detail: 'internal-trace-3c1d' } }));

    const { status, body, refillId } = await refill('5000000');

    expect({ status, body }).toEqual({ status: 503, body: { error: { code: 'oneclick_unavailable', message: '1Click refused the request: Amount is too low for bridge' } } });
    expect(await spentToday('base-usdc')).toBe(0n);
    expect(await recordOf(refillId)).toBeNull();
  });

  it('refuses when the NEAR hot wallet holds less than amountIn, with an alert for an operator', async () => {
    rpc.setBalance(usdc, hotWallet, 5_000_500n);

    const { status, body, refillId } = await refill('5000000');

    expect(status).toBe(422);
    expect(body).toEqual({ error: { code: 'signing_refused', message: expect.stringContaining('move some from the NEAR treasury') }, reason: 'source_low' });
    expect(lastLine('Refused a refill')).toMatchObject({ level: 40, refillId, reason: 'source_low', alert: true });
    expect(await spentToday('base-usdc')).toBe(0n);
    expect(await recordOf(refillId)).toBeNull();
    expect(sends()).toBe(0);
  });

  it('answers payer_busy while a NEAR payment holds the payer\'s lease, then refills under the same ID once it is released', async () => {
    const store = createRedisNearPayerStore({ redis });
    const payment = { accountId: hotWallet, quoteId: 'pay_in_flight' };
    expect(await store.takeLease(payment, 60_000)).toBe('taken');

    const busy = await refill('5000000');

    expect(busy).toMatchObject({ status: 409, body: { error: { code: 'payer_busy' } } });
    expect(await spentToday('base-usdc')).toBe(0n);
    expect(await recordOf(busy.refillId)).toBeNull();
    expect(sends()).toBe(0);
    // The payment's lease is still its own
    expect(await redis.client.get(`${redis.prefix}near:payer:${hotWallet}`)).toBe('pay_in_flight');

    expect(await store.releaseLease(payment)).toBe(true);
    const done = await refill('5000000', { refillId: busy.refillId });

    expect(done.status).toBe(200);
    // The refill's own lease went with its outcome
    expect(await redis.client.get(`${redis.prefix}near:payer:${hotWallet}`)).toBeNull();
  });
});

describe('a refill whose transaction was sent', () => {
  it('answers refill_failed when the token\'s receipt fails: nothing moved, nothing stays reserved, and the ID may be asked again', async () => {
    rpc.broadcast('revert');

    const failed = await refill('5000000');

    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({
      error: { code: 'refill_failed', message: 'The refill\'s transaction failed, and nothing moved: The token contract\'s receipt failed' },
      transactionHash: rpc.directTransactions.at(-1)!.hash,
    });
    expect(rpc.directTransactions.at(-1)!.status).toBe('failure');
    expect(rpc.balanceOf(usdc, hotWallet)).toBe(funded);
    expect(await spentToday('base-usdc')).toBe(0n);
    expect(await recordOf(failed.refillId)).toBeNull();
    expect(lastLine('A refill\'s transaction failed: nothing moved')).toMatchObject({ level: 40, refillId: failed.refillId, result: 'failed' });

    const again = await refill('5000000', { refillId: failed.refillId });

    expect(again.status).toBe(200);
    expect(rpc.balanceOf(usdc, hotWallet)).toBe(funded - BigInt(again.body['amountIn']));
  });

  it('answers refill_unknown when the node applied the transaction but never said so, keeps the reservation, and answers the same for the ID without sending', async () => {
    rpc.broadcast('timeout');
    const refillId = `ref-${randomUUID()}`;
    const asked = refill('5000000', { refillId });
    // The node took the transaction, then answers nothing more
    await waitFor(() => rpc.calls.some(call => call.method === 'send_tx'));
    rpc.unavailable(true, { methods: ['tx', 'send_tx'] });

    const unknown = await asked;
    rpc.unavailable(false);

    const transaction = rpc.directTransactions.at(-1)!;
    expect(unknown.status).toBe(502);
    expect(unknown.body).toEqual({
      error: { code: 'refill_unknown', message: 'The refill\'s transaction may have gone through: follow 1Click\'s status for its deposit address' },
      outcome: 'unknown', transactionHash: transaction.hash, depositAddress: oneClick.quotes().at(-1)!.quote.depositAddress, amountIn: '5000501', amountOut: '5000000',
      quoteDeadline: oneClick.quotes().at(-1)!.quoteRequest['deadline'], correlationId: oneClick.quotes().at(-1)!.correlationId,
    });
    // It did move: the reservation stays
    expect(rpc.balanceOf(usdc, hotWallet)).toBe(funded - 5_000_501n);
    expect(await spentToday('base-usdc')).toBe(5_000_501n);
    expect(lastLine('A refill\'s outcome is unknown: the source asset may have moved. Follow 1Click\'s status for the deposit address'))
      .toMatchObject({ level: 50, refillId, alert: true, result: 'unknown', transactionHash: transaction.hash });
    // The payer's lease went with the outcome
    expect(await redis.client.get(`${redis.prefix}near:payer:${hotWallet}`)).toBeNull();

    const calls = rpc.calls.length;
    const again = await refill('5000000', { refillId });

    expect(again).toEqual(unknown);
    expect((await refill('6000000', { refillId })).body).toEqual({ error: { code: 'refill_id_conflict', message: 'This refill ID was asked for another asset or amount' } });
    expect(rpc.calls).toHaveLength(calls);
    expect(rpc.directTransactions.filter(item => item.hash === transaction.hash)).toHaveLength(1);
  }, 15_000);

  it('holds the payer\'s lease under a quote ID the proxy\'s release can\'t name, so a release never frees it mid-send', async () => {
    // The node holds its answer: the refill holds the lease meanwhile
    rpc.broadcast('timeout');
    const refillId = `ref-${randomUUID()}`;
    const asked = refill('5000000', { refillId });
    await waitFor(() => rpc.calls.some(call => call.method === 'send_tx'));
    const leaseKey = `${redis.prefix}near:payer:${hotWallet}`;
    const release = (quoteId: string) => server.app.inject({ method: 'POST', url: `/internal/v1/quotes/${quoteId}/release`, headers: { 'x-signer-secret': secret } });

    expect(await redis.client.get(leaseKey)).toBe(`refill:${refillId}`);
    expect((await release(`refill:${refillId}`)).statusCode).toBe(400);
    expect((await release(encodeURIComponent(`refill:${refillId}`))).statusCode).toBe(400);
    expect((await release(`refill_${refillId}`)).statusCode).toBe(204);
    expect((await release(refillId)).statusCode).toBe(204);
    expect(await redis.client.get(leaseKey)).toBe(`refill:${refillId}`);

    // The lookups find the transaction the node applied: sent, and the lease goes with the outcome
    expect((await asked).status).toBe(200);
    expect(await redis.client.get(leaseKey)).toBeNull();
  }, 15_000);

  it('sends once for two asks with the same ID at once: the other is in progress, or the same answer', async () => {
    const before = { transactions: rpc.directTransactions.length, quotes: quotes() };
    const refillId = `ref-${randomUUID()}`;

    const both = await Promise.all([refill('5000000', { refillId }), refill('5000000', { refillId })]);

    const statuses = both.map(item => item.status).sort();
    expect([[200, 200], [200, 409]]).toContainEqual(statuses);
    const busy = both.find(item => item.status === 409);
    if (busy)
      expect(busy.body).toEqual({ error: { code: 'refill_in_progress', message: 'A refill with this ID is in progress: ask again later' } });
    expect(rpc.directTransactions).toHaveLength(before.transactions + 1);
    expect(quotes()).toBe(before.quotes + 1);
    expect(rpc.balanceOf(usdc, hotWallet)).toBe(funded - 5_000_501n);
    // Asked again once both are done: the answer
    expect((await refill('5000000', { refillId })).status).toBe(200);
  });
});
