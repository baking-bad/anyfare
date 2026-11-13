import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret, type Server } from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createLedger, createRefillRepository, createTreasuryRepository, ledgerAccountIds, refills, type Refill } from '@anyfare/db';
import { createApp as createSigner, refillIdKeyPrefix, type SignerDependencies } from '@anyfare/signer';
import {
  createFakeClock, createTestDatabase, createTestRedis, defaultOneClickTokens, encodeBase58, generateNearKey, startFakeNearRpc, startFakeOneClick,
  startFakeSolanaRpc, type FakeClock, type FakeNearRpc, type FakeOneClick, type FakeSolanaRpc, type TestDatabase, type TestRedis,
} from '@anyfare/testing';
import { createOneClickClient } from '@anyfare/topups';

import { createApp, type WorkersServer } from '../../src/app.js';
import { createRefillSigner } from '../../src/signerClient.js';
import { createSolanaBalanceReader } from '../../src/treasury/readers.js';

// The whole refill: the workers see the Signer's Solana wallet under its floor on the fake Solana RPC,
// the real Signer quotes it at the fake 1Click and pays it from its NEAR hot wallet on the fake NEAR
// node, 1Click delivers, and the workers book it. Postgres and Redis are real.

const secret = 'signer-secret-0123456789abcdef-0123456789';
// Made-up accounts and keys: the NEAR hot wallet, and the Solana wallet that receives refills
const hotWallet = 'hot.anyfare.testnet';
const key = generateNearKey();
const solanaWallet = encodeBase58(randomBytes(32));
// The NEAR hot wallet's USDC: $100
const funded = 100_000_000n;
const minuteMs = 60_000;

let config: PlatformConfig;
let database: TestDatabase;
let redis: TestRedis;
let rpc: FakeNearRpc;
let solanaRpc: FakeSolanaRpc;
let oneClick: FakeOneClick;
let signer: Server;
let signerUrl: string;
// The workers' own clock, from now: each poll is due when the test says
let clock: FakeClock;
let usdc: string;
let mint: string;
const signerLines: Record<string, unknown>[] = [];
const workerLines: Record<string, unknown>[] = [];

// The workers, asking the Signer within `timeoutMs`. They never listen, so a job runs only when a test asks.
const workersWith = (timeoutMs?: number): WorkersServer => createApp({
  config,
  logger: createLogger({ level: 'debug' }, { write: (line: string) => workerLines.push(JSON.parse(line) as Record<string, unknown>) }),
  postgres: database.postgres,
  clock,
  balanceReaders: { solana: createSolanaBalanceReader({ rpcUrl: Secret.from(solanaRpc.url), timeoutMs: 2_000 }) },
  oneClick: createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 }),
  signer: createRefillSigner({ url: signerUrl, secret: Secret.from(secret), ...timeoutMs === undefined ? {} : { timeoutMs } }),
});

beforeAll(async () => {
  [database, redis, rpc, solanaRpc, oneClick] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeNearRpc(), startFakeSolanaRpc(), startFakeOneClick({
    // 1Click lists no testnet tokens: example.yaml's USDC on Solana Devnet under a made-up asset ID
    tokens: [...defaultOneClickTokens, {
      assetId: 'nep141:sol-devnet-usdc.fakes.near', decimals: 6, blockchain: 'sol', symbol: 'USDC', price: 0.99948, priceUpdatedAt: '2026-11-12T09:00:00.000Z',
      contractAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    }],
  })]);
  // Rebalancing on, for the Solana wallet only: under $3, up to $6. A second a NEAR read and a send.
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        timeouts: { connectMs: 1_000, settleMs: 1_500 },
        topups: { url: oneClick.url },
        signer: { wallets: { solana: solanaWallet, near: hotWallet } },
        rebalancing: { enabled: true, targets: [{ asset: 'solana-usdc', blockchain: 'sol', floor: '3', target: '6' }] },
      })).toString('base64'),
    },
  });
  usdc = findAsset(config, 'near-usdc')!.address;
  mint = findAsset(config, 'solana-usdc')!.address;
  rpc.addAccount({ accountId: hotWallet, publicKey: key.publicKey });
  rpc.addToken({ contractId: usdc, balances: { [hotWallet]: funded } });
  clock = createFakeClock(new Date());
  // The Signer's Solana wallet only receives refills here: its address is all a refill reads of it
  const solana = { address: solanaWallet } as unknown as NonNullable<SignerDependencies['wallets']['solana']>;
  signer = createSigner({
    config,
    logger: createLogger({ level: 'debug' }, { write: (line: string) => signerLines.push(JSON.parse(line) as Record<string, unknown>) }),
    postgres: database.postgres,
    redis,
    secret: Secret.from(secret),
    wallets: { solana, near: { accountId: hotWallet, secretKey: Secret.from(key.secretKey), rpcUrl: Secret.from(rpc.url) } },
    oneClick: createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 }),
    refillPollMs: 100,
  });
  signerUrl = `http://127.0.0.1:${(await signer.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
});

afterAll(async () => {
  await signer?.close();
  await Promise.all([rpc?.close(), solanaRpc?.close(), oneClick?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const rows = () => database.db.select().from(refills);
const refillOf = async (id: string): Promise<Refill> => (await createRefillRepository({ db: database.db, clock, ids: randomIdGenerator }).find(id))!;
// The hot wallet's transfers of USDC, by deposit address
const transfersTo = (depositAddress: string) =>
  rpc.directTransactions.filter(transaction => transaction.calls.some(call => call.methodName === 'ft_transfer' && (call.args as { receiver_id?: string }).receiver_id === depositAddress));
const holdSolana = (amount: bigint) => solanaRpc.setTokenAccounts(solanaWallet, mint, [amount]);

const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
  for (let waited = 0; !await condition(); waited += 20) {
    if (waited > 10_000)
      throw new Error('The condition never held');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

describe('a refill from end to end', () => {
  it('refills a Solana wallet under its floor from the NEAR hot wallet once, books it when 1Click delivers, and sends nothing new once it is above', async () => {
    const workers = workersWith();
    expect(workers.jobs).toContain('rebalancing');
    // $1 under a $3 floor: $5 brings it to its $6 target
    holdSolana(1_000_000n);

    expect(await workers.scheduler.runNow('rebalancing')).toBe('success');

    const [row] = await rows();
    expect(await rows()).toHaveLength(1);
    const refill = await refillOf(row!.id);
    expect(refill).toMatchObject({ asset: 'solana-usdc', sourceAsset: 'near-usdc', amount: 5_000_000n, status: 'sent', amountOut: 5_000_000n });
    const depositAddress = refill.depositAddress!;
    // The fake NEAR node moved amountIn once, from the hot wallet to 1Click's deposit address
    expect(transfersTo(depositAddress)).toEqual([expect.objectContaining({ hash: refill.nearTransactionHash, signerId: hotWallet, receiverId: usdc, status: 'success' })]);
    expect(rpc.balanceOf(usdc, depositAddress)).toBe(refill.amountIn);
    expect(rpc.balanceOf(usdc, hotWallet)).toBe(funded - refill.amountIn!);
    expect(oneClick.quotes().at(-1)!.quoteRequest).toMatchObject({ swapType: 'EXACT_OUTPUT', amount: '5000000', recipient: solanaWallet, refundTo: hotWallet });

    // 1Click delivers $5 to the Solana wallet
    oneClick.setStatus(depositAddress, 'SUCCESS');
    const delivery = (await createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 }).status({ depositAddress })).swapDetails.destinationChainTxHashes[0]!.hash;
    holdSolana(6_000_000n);
    clock.advance(10_000);

    expect(await workers.scheduler.runNow('rebalancing')).toBe('success');

    const booked = await refillOf(refill.id);
    expect(booked).toMatchObject({ status: 'succeeded', amountInUsd: refill.amountIn, amountOutUsd: 5_000_000n, deliveryTransactionHashes: [delivery] });
    // One treasury transfer from USDC on NEAR to USDC on Solana, with both amounts
    expect(await createTreasuryRepository({ db: database.db }).findTransfer(`refill:${refill.id}`)).toMatchObject({
      fromAsset: 'near-usdc', fromAmount: refill.amountIn, toAsset: 'solana-usdc', toAmount: 5_000_000n, transactions: [refill.nearTransactionHash, delivery],
      ledgerTransactionId: booked.ledgerTransactionId,
    });
    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
    const accounts = [ledgerAccountIds.treasury('near-usdc'), ledgerAccountIds.treasury('solana-usdc'), ledgerAccountIds.conversion];
    expect(await ledger.balancesOf(accounts)).toEqual(new Map([
      [accounts[0], refill.amountIn], [accounts[1], -5_000_000n], [accounts[2], 5_000_000n - refill.amountIn!],
    ]));
    expect(workerLines.filter(line => line['msg'] === 'A refill arrived and was booked')).toEqual([expect.objectContaining({ refillId: refill.id, arrived: '5' })]);

    // The wallet is back above its floor: nothing new
    const quotes = oneClick.quotes().length;
    clock.advance(5 * minuteMs);

    expect(await workers.scheduler.runNow('rebalancing')).toBe('success');

    expect(await rows()).toHaveLength(1);
    expect(oneClick.quotes()).toHaveLength(quotes);
    expect(transfersTo(depositAddress)).toHaveLength(1);
    expect(rpc.directTransactions).toHaveLength(1);
  });

  it('asks again with the same ID when its first ask timed out after the Signer sent, and gets the stored answer: one transfer', async () => {
    await database.db.delete(refills);
    const before = rpc.directTransactions.length;
    // The node holds its answer to the send for 2 s, and the Signer waits a second for it, then looks the
    // transaction up: the workers stop waiting before that, after the send
    const workers = workersWith(900);
    rpc.broadcast('timeout');
    holdSolana(1_000_000n);

    expect(await workers.scheduler.runNow('rebalancing')).toBe('success');

    const [row] = await rows();
    expect(row).toMatchObject({ status: 'requested', asset: 'solana-usdc', amount: 5_000_000n });
    expect(workerLines.filter(line => line['msg'] === 'The Signer\'s answer to a refill never arrived: it is asked again next run, with the same ID').at(-1))
      .toMatchObject({ refillId: row!.id, code: 'timeout' });
    // The Signer sent, then finds its transaction and keeps the answer under the ID
    expect(rpc.directTransactions).toHaveLength(before + 1);
    await waitFor(async () => (await redis.client.get(`${redis.prefix}${refillIdKeyPrefix}${row!.id}`))?.includes('"state":"sent"') === true);
    clock.advance(minuteMs);

    expect(await workers.scheduler.runNow('rebalancing')).toBe('success');

    const refill = await refillOf(row!.id);
    expect(refill).toMatchObject({ status: 'sent', depositAddress: expect.any(String) });
    expect(signerLines.filter(line => line['msg'] === 'Answered a refill again')).toEqual([expect.objectContaining({ refillId: row!.id, outcome: 'sent' })]);
    expect(rpc.directTransactions).toHaveLength(before + 1);
    expect(transfersTo(refill.depositAddress!)).toEqual([expect.objectContaining({ hash: refill.nearTransactionHash })]);
    expect(await rows()).toHaveLength(1);
  }, 20_000);
});
