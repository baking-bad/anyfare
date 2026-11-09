import { fixtureTime } from '@anyfare/testing';

import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { createServer } from 'node:http';

import { Registry } from '@prometheus-io/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret } from '@anyfare/common';
import { findAsset, loadPlatformConfig, treasuryWallets, type Asset, type PlatformConfig } from '@anyfare/core';
import { createAccountRepository, createLedger, createPaymentRepository, createRoutingRepository, createTreasuryRepository, type Ledger } from '@anyfare/db';
import {
  createFakeClock, createTestDatabase, encodeBase58, startFakeNearRpc, startFakeSolanaRpc, type FakeNearRpc, type FakeSolanaRpc, type TestDatabase,
} from '@anyfare/testing';

import { createReconciliationJob, createTreasuryBalancesJob, createTreasuryMetrics } from '../../src/treasury/jobs.js';
import { createEvmBalanceReader, createNearBalanceReader, createSolanaBalanceReader, readerFor } from '../../src/treasury/readers.js';

const clock = createFakeClock(fixtureTime(1, 2, 0, 0, 0, 0));
const logs: Record<string, unknown>[] = [];
const logger = createLogger({}, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });
const lowWallet = 'A Signer wallet holds less than a day\'s spend limit: top it up';
const noTokenAccount = 'A payTo has no token account for its asset: payments to it fail until it has one';
// The selector of ERC-20 balanceOf(address)
const balanceOfSelector = '0x70a08231';

let database: TestDatabase;
let config: PlatformConfig;
let ledger: Ledger;
let evm: Awaited<ReturnType<typeof startFakeEvmRpc>>;
let solana: FakeSolanaRpc;
let nearRpc: FakeNearRpc;

/** A JSON-RPC that answers `eth_call` of ERC-20 `balanceOf` from a map, by holder address, and records each call. */
const startFakeEvmRpc = async () => {
  const balances = new Map<string, bigint>();
  const calls: { readonly method: string; readonly to: string | undefined }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string; params?: [{ to?: string; data?: string }] };
      const [{ to, data = '' } = {}] = call.params ?? [];
      calls.push({ method: call.method, to: to?.toLowerCase() });
      response.setHeader('content-type', 'application/json');
      if (call.method !== 'eth_call' || !data.startsWith(balanceOfSelector)) {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `${call.method} isn't faked` } }));
        return;
      }
      const holder = `0x${data.slice(34, 74)}`.toLowerCase();
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: `0x${(balances.get(holder) ?? 0n).toString(16).padStart(64, '0')}` }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    balances,
    calls,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

beforeAll(async () => {
  [database, config, evm, solana, nearRpc] = await Promise.all([
    createTestDatabase(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }), startFakeEvmRpc(), startFakeSolanaRpc(), startFakeNearRpc(),
  ]);
  ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
});

afterAll(async () => {
  await Promise.all([evm?.close(), solana?.close(), nearRpc?.close()]);
  await database?.drop();
});

beforeEach(() => {
  logs.length = 0;
  // Each reconciliation is a day after the last, so the latest run is the one just made
  clock.advance(24 * 60 * 60_000);
});

const treasury = () => createTreasuryRepository({ db: database.db });
const latestRun = async () => (await treasury().latestReconciliationRun())!;
const assetsNamed = (...names: readonly string[]): readonly Asset[] => config.assets.filter(asset => names.includes(asset.name));
const asset = (name: string): Asset => findAsset(config, name)!;
// Base Sepolia and Tempo Moderato, both EVM, on the fake
const evmReaders = () => readerFor({
  evm: createEvmBalanceReader({ rpcUrlFor: network => network === 'eip155:84532' || network === config.mpp.network.id ? evm.url : undefined, timeoutMs: 2_000 }),
});

const balances = (source: PlatformConfig, readers: ReturnType<typeof readerFor>, registry = new Registry(), signerDailyLimit = source.signer.maxPerNetworkPerDay) =>
  createTreasuryBalancesJob({ wallets: async () => treasuryWallets(source), readerFor: readers, signerDailyLimit, metrics: createTreasuryMetrics(registry), logger })();

const reconciliation = (source: PlatformConfig, readers: ReturnType<typeof readerFor>, registry = new Registry()) => createReconciliationJob({
  config: source, wallets: async () => treasuryWallets(source), readerFor: readers, ledger, treasury: treasury(), metrics: createTreasuryMetrics(registry),
  clock, ids: randomIdGenerator, logger,
})();

describe('the EVM balance reader', () => {
  it('reads the token\'s balanceOf for the holder through eth_call, in atomic units', async () => {
    const usdc = asset('base-usdc');
    const holder = '0x6666666666666666666666666666666666666666';
    evm.balances.set(holder, 12_345_678n);
    evm.calls.length = 0;
    const reader = createEvmBalanceReader({ rpcUrlFor: () => evm.url, timeoutMs: 2_000 });

    expect(await reader.balance({ address: holder, asset: usdc })).toBe(12_345_678n);
    expect(await reader.balance({ address: '0x7777777777777777777777777777777777777777', asset: usdc })).toBe(0n);
    expect(evm.calls).toEqual([{ method: 'eth_call', to: usdc.address.toLowerCase() }, { method: 'eth_call', to: usdc.address.toLowerCase() }]);
    expect(reader.hasTokenAccount).toBeUndefined();
  });

  it('throws for a network without an RPC', async () => {
    const reader = createEvmBalanceReader({ rpcUrlFor: () => undefined, timeoutMs: 2_000 });

    await expect(reader.balance({ address: '0x6666666666666666666666666666666666666666', asset: asset('base-usdc') })).rejects.toThrow('No RPC for eip155:84532');
  });
});

describe('the balance monitor', () => {
  it('reports each wallet\'s holdings as a metric, read from the EVM RPCs', async () => {
    evm.balances.set(asset('tempo-pathusd').payTo!.toLowerCase(), 40_000_000n);
    evm.balances.set(asset('base-usdc').payTo!.toLowerCase(), 12_500_000n);
    const registry = new Registry();

    const result = await balances({ ...config, assets: assetsNamed('tempo-pathusd', 'base-usdc') }, evmReaders(), registry);

    expect(result).toEqual({ wallets: 2, balances: 2 });
    const text = await registry.metrics();
    expect(text).toMatch(/treasury_balance_usd\{wallet="payTo:tempo-pathusd",asset="tempo-pathusd"\} 40\n/);
    expect(text).toMatch(/treasury_balance_usd\{wallet="payTo:base-usdc",asset="base-usdc"\} 12\.5\n/);
    expect(logs.filter(line => line['alert'] === true)).toEqual([]);
  });

  it('reports the Signer\'s hot wallets, and alerts for each below a day\'s spend limit', async () => {
    const wallets = { base: '0x3333333333333333333333333333333333333333', tempo: '0x4444444444444444444444444444444444444444' };
    const tempoAsset = config.assets.find(item => item.network.id === config.mpp.network.id)!;
    const withSigner = { ...config, assets: assetsNamed('base-usdc', tempoAsset.name), signer: { ...config.signer, wallets: { ...config.signer.wallets, ...wallets } } };
    // $4 on Base and $6 on Tempo, against a $5 daily limit
    evm.balances.set(wallets.base, 4_000_000n);
    evm.balances.set(wallets.tempo, 6_000_000n);
    const registry = new Registry();

    await balances(withSigner, evmReaders(), registry, 5_000_000n);

    const text = await registry.metrics();
    expect(text).toMatch(/treasury_balance_usd\{wallet="signer:base",asset="base-usdc"\} 4\n/);
    expect(text).toMatch(new RegExp(`treasury_balance_usd\\{wallet="signer:tempo",asset="${tempoAsset.name}"\\} 6\\n`));
    expect(logs.filter(line => line['msg'] === lowWallet)).toEqual([expect.objectContaining({ level: 40, wallet: 'signer:base', held: '4', dailyLimit: '5', alert: true })]);
  });

  it('alerts for the NEAR hot wallet below a day\'s spend limit: it is the payTo buyers pay, noted as the Signer\'s', async () => {
    const nearUsdc = asset('near-usdc');
    const withHotWallet = {
      ...config, assets: assetsNamed('near-usdc'), signer: { ...config.signer, wallets: { ...config.signer.wallets, near: nearUsdc.payTo } },
    };
    // $3 of USDC on NEAR against a $5 daily limit
    const near = { balance: async () => 3_000_000n };
    const registry = new Registry();

    expect(treasuryWallets(withHotWallet)).toEqual([
      expect.objectContaining({ name: 'payTo:near-usdc', role: 'pay_to', signer: 'signer:near' }),
      expect.objectContaining({ name: 'treasury:near', role: 'treasury', addresses: [config.topups.recipient] }),
    ]);
    await balances(withHotWallet, readerFor({ near }), registry, 5_000_000n);

    const text = await registry.metrics();
    expect(text).toMatch(/treasury_balance_usd\{wallet="payTo:near-usdc",asset="near-usdc"\} 3\n/);
    expect(text).toMatch(/treasury_balance_usd\{wallet="treasury:near",asset="near-usdc"\} 3\n/);
    // The account top-ups deliver to holds as little, but nothing pays out of it
    expect(logs.filter(line => line['msg'] === lowWallet)).toEqual([expect.objectContaining({ level: 40, wallet: 'payTo:near-usdc', held: '3', dailyLimit: '5', alert: true })]);
  });

  it('fails the run when a balance can\'t be read, logging the RPC\'s short message, never its URL', async () => {
    const listener = createNetServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address() as AddressInfo;
    await new Promise(resolve => listener.close(resolve));
    const refusing = readerFor({ evm: createEvmBalanceReader({ rpcUrlFor: () => `http://127.0.0.1:${port}/v2/evm-rpc-key-secret?apikey=evm-query-secret`, timeoutMs: 2_000 }) });

    await expect(balances({ ...config, assets: assetsNamed('base-usdc') }, refusing)).rejects.toThrow('1 treasury balances couldn\'t be read');

    expect(logs.find(line => line['msg'] === 'Failed to read a treasury balance')).toMatchObject({
      level: 50, wallet: 'payTo:base-usdc', asset: 'base-usdc', network: 'eip155:84532', error: { message: expect.stringContaining('HTTP request failed.') },
    });
    for (const secret of ['evm-rpc-key-secret', 'evm-query-secret', 'balanceOf'])
      expect(JSON.stringify(logs)).not.toContain(secret);
  });
});

describe('the reconciliation', () => {
  it('records each run, and alerts when the chain holds other than the ledger says', async () => {
    // The ledger knows of 40 pathUSD and 10 USDC: the chain holds 40 and 12.5
    evm.balances.set(asset('tempo-pathusd').payTo!.toLowerCase(), 40_000_000n);
    evm.balances.set(asset('base-usdc').payTo!.toLowerCase(), 12_500_000n);
    await ledger.treasuryTransfer({ reference: 'seed-pathusd', from: { asset: 'seed', amount: 40_000_000n }, to: { asset: 'tempo-pathusd', amount: 40_000_000n } });
    await ledger.treasuryTransfer({ reference: 'seed-usdc', from: { asset: 'seed', amount: 10_000_000n }, to: { asset: 'base-usdc', amount: 10_000_000n } });
    const registry = new Registry();

    const result = await reconciliation({ ...config, assets: assetsNamed('tempo-pathusd', 'base-usdc') }, evmReaders(), registry);

    expect(result).toEqual({ assets: 2, alerts: 1 });
    expect(await latestRun()).toEqual({
      id: expect.stringMatching(/^rec_/),
      ranAt: clock.now(),
      alerts: 1,
      results: {
        'tempo-pathusd': { ledger: '40', chain: '40', drift: '0', alert: false },
        'base-usdc': { ledger: '10', chain: '12.5', drift: '2.5', alert: true },
      },
    });
    expect(logs.filter(line => line['msg'] === 'Treasury drift: the chain and the ledger disagree')).toEqual([
      expect.objectContaining({ level: 50, asset: 'base-usdc', ledger: '10', chain: '12.5', drift: '2.5', alert: true }),
    ]);
    const text = await registry.metrics();
    expect(text).toMatch(/treasury_drift_usd\{asset="base-usdc"\} 2\.5\n/);
    expect(text).toMatch(/treasury_drift_usd\{asset="tempo-pathusd"\} 0\n/);
  });

  it('counts the Signer\'s hot wallets with the payTo wallets: they pay the targets the ledger books', async () => {
    const wallets = { base: '0x3333333333333333333333333333333333333333', tempo: '0x4444444444444444444444444444444444444444' };
    const assets = assetsNamed('tempo-pathusd', 'base-usdc');
    evm.balances.set(wallets.base, 4_000_000n);
    evm.balances.set(wallets.tempo, 6_000_000n);

    await reconciliation({ ...config, assets }, evmReaders());
    const without = (await latestRun()).results;
    clock.advance(60_000);
    await reconciliation({ ...config, assets, signer: { ...config.signer, wallets: { ...config.signer.wallets, ...wallets } } }, evmReaders());
    const counted = (await latestRun()).results;

    const chainOf = (results: typeof without, asset: string) => Number(results[asset]!.chain);
    expect(chainOf(counted, 'base-usdc') - chainOf(without, 'base-usdc')).toBe(4);
    expect(chainOf(counted, 'tempo-pathusd') - chainOf(without, 'tempo-pathusd')).toBe(6);
    expect(counted['base-usdc']!.ledger).toBe(without['base-usdc']!.ledger);
  });

  it('counts an address once when the Signer wallet is also a payTo', async () => {
    const assets = assetsNamed('base-usdc');
    const shared = asset('base-usdc').payTo!;

    await reconciliation({ ...config, assets }, evmReaders());
    const alone = (await latestRun()).results;
    clock.advance(60_000);
    await reconciliation({ ...config, assets, signer: { ...config.signer, wallets: { ...config.signer.wallets, base: shared.toLowerCase() } } }, evmReaders());

    expect((await latestRun()).results).toEqual(alone);
  });

  it('reconciles without drift after a routed settle: the buyer\'s $1 into payTo, the target\'s $0.80 out of the Signer wallet', async () => {
    const fresh = await createTestDatabase();
    try {
      const books = createLedger({ db: fresh.db, clock, ids: randomIdGenerator });
      const signerWallet = '0x8888888888888888888888888888888888888888';
      const source = { ...config, assets: assetsNamed('base-usdc'), signer: { ...config.signer, wallets: { ...config.signer.wallets, base: signerWallet } } };
      const payTo = asset('base-usdc').payTo!.toLowerCase();
      const run = async () => {
        clock.advance(60_000);
        await createReconciliationJob({
          config: source, wallets: async () => treasuryWallets(source), readerFor: evmReaders(), ledger: books, treasury: createTreasuryRepository({ db: fresh.db }),
          metrics: createTreasuryMetrics(new Registry()), clock, ids: randomIdGenerator, logger,
        })();

        return (await createTreasuryRepository({ db: fresh.db }).latestReconciliationRun())!.results;
      };
      // The operator funds the hot wallet with $5, booked as a treasury transfer
      await books.treasuryTransfer({ reference: 'fund-signer-base', from: { asset: 'seed', amount: 5_000_000n }, to: { asset: 'base-usdc', amount: 5_000_000n } });
      evm.balances.set(payTo, 0n);
      evm.balances.set(signerWallet, 5_000_000n);
      expect(await run()).toEqual({ 'base-usdc': { ledger: '5', chain: '5', drift: '0', alert: false } });

      // A routed call: the Signer pays the target $0.80, and the buyer's $1 over x402 settles
      const payments = createPaymentRepository({ db: fresh.db, clock });
      const routing = createRoutingRepository({ db: fresh.db, clock });
      await payments.create({
        id: 'pay_routed', requestId: 'req-routed', rail: 'x402', buyerAccountId: undefined, keyId: undefined, targetHost: 'api.target.test', targetPath: '/v1/quote',
        network: 'eip155:84532', asset: 'base-usdc', atomicAmount: 1_000_000n, amount: 1_000_000n, status: 'verified',
      });
      await routing.recordTargetPayment({
        paymentId: 'pay_routed', protocol: 'x402', network: 'eip155:84532', asset: 'base-usdc', amount: 800_000n, atomicAmount: 800_000n,
        payTo: '0x9999999999999999999999999999999999999999', signatureId: 'sig_routed',
      });
      await routing.updateTargetPayment('pay_routed', { status: 'settled', transactionHash: `0x${'1'.repeat(64)}` });
      await books.settle({ paymentId: 'pay_routed', asset: 'base-usdc', transactionHash: `0x${'2'.repeat(64)}`, receipt: undefined, needsReview: false });
      evm.balances.set(payTo, 1_000_000n);
      evm.balances.set(signerWallet, 4_200_000n);

      expect(await run()).toEqual({ 'base-usdc': { ledger: '5.2', chain: '5.2', drift: '0', alert: false } });
    }
    finally {
      await fresh.drop();
    }
  });

  it('records nothing when a balance can\'t be read', async () => {
    const before = await latestRun();
    const refusing = readerFor({ evm: createEvmBalanceReader({ rpcUrlFor: () => 'http://127.0.0.1:9/rpc', timeoutMs: 2_000 }) });

    await expect(reconciliation({ ...config, assets: assetsNamed('base-usdc') }, refusing)).rejects.toThrow('no reconciliation without them');

    expect(await latestRun()).toEqual(before);
  });
});

describe('the Solana balance reader, and the treasury jobs on Solana', () => {
  // The fake answers on any path: a provider's URL may carry its key there
  const rpcUrl = () => Secret.from(`${solana.url}/solana-rpc-key-secret`);
  const solanaReader = () => createSolanaBalanceReader({ rpcUrl: rpcUrl(), timeoutMs: 2_000 });
  // Made-up owners
  const owner = encodeBase58(new Uint8Array(32).fill(9));
  const signerWallet = encodeBase58(new Uint8Array(32).fill(7));
  const usdc = () => asset('solana-usdc');
  const solanaOnly = () => ({ ...config, assets: assetsNamed('solana-usdc') });

  it('reads the sum of the owner\'s token accounts for the mint through getTokenAccountsByOwner, and 0 without one', async () => {
    solana.setTokenAccounts(owner, usdc().address, [3_000_000n, 1_250_000n]);
    const reader = solanaReader();

    expect(await reader.balance({ address: owner, asset: usdc() })).toBe(4_250_000n);
    expect(await reader.hasTokenAccount({ address: owner, asset: usdc() })).toBe(true);
    // Another mint's accounts don't count
    expect(await reader.balance({ address: owner, asset: { ...usdc(), address: 'So11111111111111111111111111111111111111112' } })).toBe(0n);
    expect(solana.calls.at(-1)).toBe('getTokenAccountsByOwner');

    solana.setTokenAccounts(owner, usdc().address, []);
    expect(await reader.balance({ address: owner, asset: usdc() })).toBe(0n);
    expect(await reader.hasTokenAccount({ address: owner, asset: usdc() })).toBe(false);
  });

  it.each([
    ['a JSON-RPC error', 'error', /refused getTokenAccountsByOwner/],
    ['an answer without accounts', 'malformed', /without a list of accounts/],
  ] as const)('throws on %s, without the RPC\'s URL', async (_case, mode, message) => {
    solana.failTokenAccounts(mode);
    try {
      const failure = await solanaReader().balance({ address: owner, asset: usdc() }).then(() => undefined, (error: unknown) => error as Error);

      expect(failure?.message).toMatch(message);
      expect(JSON.stringify({ message: failure?.message, cause: String(failure?.cause) })).not.toContain('solana-rpc-key-secret');
    }
    finally {
      solana.failTokenAccounts(undefined);
    }
  });

  it('throws when the RPC doesn\'t answer, without its URL', async () => {
    const failing = createSolanaBalanceReader({ rpcUrl: Secret.from('http://127.0.0.1:9/solana-rpc-key-secret'), timeoutMs: 2_000 });
    const failure = await failing.balance({ address: owner, asset: usdc() }).then(() => undefined, (error: unknown) => error as Error);

    expect(failure?.message).toBe('The Solana RPC didn\'t answer getTokenAccountsByOwner');
    expect(failure).toMatchObject({ code: 'solana_rpc_unavailable' });
  });

  it('reports the Solana treasury\'s balance, and alerts about a payTo without a USDC account', async () => {
    const run = async () => {
      const registry = new Registry();
      logs.length = 0;
      await balances(solanaOnly(), readerFor({ solana: solanaReader() }), registry);

      return { text: await registry.metrics(), warnings: logs.filter(line => line['msg'] === noTokenAccount) };
    };

    solana.setTokenAccounts(usdc().payTo!, usdc().address, [7_500_000n]);
    const funded = await run();
    expect(funded.text).toMatch(/treasury_balance_usd\{wallet="payTo:solana-usdc",asset="solana-usdc"\} 7\.5\n/);
    expect(funded.warnings).toEqual([]);

    solana.setTokenAccounts(usdc().payTo!, usdc().address, []);
    const missing = await run();
    expect(missing.text).toMatch(/treasury_balance_usd\{wallet="payTo:solana-usdc",asset="solana-usdc"\} 0\n/);
    expect(missing.warnings).toEqual([expect.objectContaining({
      level: 40, wallet: 'payTo:solana-usdc', asset: 'solana-usdc', network: usdc().network.id, address: usdc().payTo, alert: true,
    })]);

    // A USDC account that is merely empty is no warning
    solana.setTokenAccounts(usdc().payTo!, usdc().address, [0n]);
    expect((await run()).warnings).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain('solana-rpc-key-secret');
  });

  it('reports the Signer\'s Solana wallet and alerts below a day\'s limit, and the reconciliation counts it', async () => {
    const withSigner = { ...solanaOnly(), signer: { ...config.signer, wallets: { ...config.signer.wallets, solana: signerWallet } } };
    const readers = readerFor({ solana: solanaReader() });
    // $3 in the hot wallet, against a $5 daily limit
    solana.setTokenAccounts(signerWallet, usdc().address, [3_000_000n]);
    solana.setTokenAccounts(usdc().payTo!, usdc().address, [6_000_000n]);
    const registry = new Registry();

    await balances(withSigner, readers, registry, 5_000_000n);

    expect(await registry.metrics()).toMatch(/treasury_balance_usd\{wallet="signer:solana",asset="solana-usdc"\} 3\n/);
    expect(logs.filter(line => line['msg'] === lowWallet)).toEqual([expect.objectContaining({ level: 40, wallet: 'signer:solana', held: '3', dailyLimit: '5', alert: true })]);

    await reconciliation(solanaOnly(), readers);
    const without = (await latestRun()).results;
    clock.advance(60_000);
    await reconciliation(withSigner, readers);
    const counted = (await latestRun()).results;
    expect(Number(counted['solana-usdc']!.chain) - Number(without['solana-usdc']!.chain)).toBe(3);
    expect(counted['solana-usdc']!.ledger).toBe(without['solana-usdc']!.ledger);
  });

  it('reconciles solana-usdc: it matches when the ledger and the chain agree, and alerts above $1 of drift', async () => {
    const readers = readerFor({ solana: solanaReader() });
    // The ledger knows of 6 USDC on Solana
    await ledger.treasuryTransfer({ reference: 'seed-solana-usdc', from: { asset: 'seed', amount: 6_000_000n }, to: { asset: 'solana-usdc', amount: 6_000_000n } });

    solana.setTokenAccounts(usdc().payTo!, usdc().address, [6_000_000n]);
    expect(await reconciliation(solanaOnly(), readers)).toEqual({ assets: 1, alerts: 0 });
    expect(await latestRun()).toMatchObject({ ranAt: clock.now(), alerts: 0, results: { 'solana-usdc': { ledger: '6', chain: '6', drift: '0', alert: false } } });

    clock.advance(60_000);
    solana.setTokenAccounts(usdc().payTo!, usdc().address, [4_500_000n]);
    const registry = new Registry();
    expect(await reconciliation(solanaOnly(), readers, registry)).toEqual({ assets: 1, alerts: 1 });
    expect(await latestRun()).toMatchObject({ ranAt: clock.now(), alerts: 1, results: { 'solana-usdc': { ledger: '6', chain: '4.5', drift: '-1.5', alert: true } } });
    expect(logs).toContainEqual(expect.objectContaining({ level: 50, asset: 'solana-usdc', drift: '-1.5', alert: true }));
    expect(await registry.metrics()).toMatch(/treasury_drift_usd\{asset="solana-usdc"\} -1\.5\n/);
  });
});

describe('the NEAR balance reader, and the treasury jobs on NEAR', () => {
  const usdc = () => asset('near-usdc');
  const nearOnly = () => ({ ...config, assets: assetsNamed('near-usdc') });
  // The fake answers on any path: a provider's URL may carry its key there
  const rpcUrl = () => `${nearRpc.url}/near-rpc-key-secret`;
  const nearReader = (rpcUrls = [rpcUrl()]) => createNearBalanceReader({ rpcUrls, logger, timeoutMs: 2_000 });
  // Made-up accounts
  const holder = 'treasury-holder.testnet';
  const stranger = 'nobody-here.testnet';

  beforeAll(() => {
    nearRpc.addToken({ contractId: usdc().address, balances: { [holder]: 4_250_000n } });
  });

  beforeEach(() => {
    nearRpc.reset();
  });

  /** A port nothing listens on, with a key in the URL's path and query. */
  const closedUrl = async (): Promise<string> => {
    const listener = createNetServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address() as AddressInfo;
    await new Promise(resolve => listener.close(resolve));

    return `http://127.0.0.1:${port}/v2/near-dead-key-secret?apikey=near-query-secret`;
  };

  it('reads the token\'s ft_balance_of for the account through query call_function at the final block, in atomic units', async () => {
    expect(await nearReader().balance({ address: holder, asset: usdc() })).toBe(4_250_000n);

    expect(nearRpc.calls).toEqual([{
      method: 'query',
      params: {
        request_type: 'call_function', finality: 'final', account_id: usdc().address, method_name: 'ft_balance_of',
        args_base64: Buffer.from(JSON.stringify({ account_id: holder })).toString('base64'),
      },
    }]);
  });

  it('reads 0 for an account the token holds nothing for, and never reads storage_balance_of', async () => {
    expect(await nearReader().balance({ address: stranger, asset: usdc() })).toBe(0n);
    expect(nearRpc.calls.map(call => (call.params as { method_name?: string }).method_name)).toEqual(['ft_balance_of']);
  });

  it('reads the chain\'s final height through the same RPCs', async () => {
    const before = nearRpc.height;

    expect(await nearReader().height()).toBe(before + 1n);
    expect(nearRpc.calls).toEqual([{ method: 'block', params: { finality: 'final' } }]);
  });

  it('goes on to the next RPC when one fails, naming only its host', async () => {
    logs.length = 0;
    const dead = await closedUrl();
    const reader = nearReader([dead, rpcUrl()]);

    expect(await reader.balance({ address: holder, asset: usdc() })).toBe(4_250_000n);
    nearRpc.unavailable(true, { methods: ['block'] });
    const second = createNearBalanceReader({ rpcUrls: [rpcUrl(), `${nearRpc.url}/other`], logger, timeoutMs: 2_000 });
    await expect(second.height()).rejects.toMatchObject({ code: 'near_rpc_unavailable', message: 'The NEAR RPC answered block with status 503' });

    expect(logs.filter(line => line['msg'] === 'A NEAR RPC failed: trying the next')).toEqual([
      expect.objectContaining({ level: 40, host: new URL(dead).host, next: new URL(nearRpc.url).host, error: expect.objectContaining({ message: expect.stringMatching(/^The NEAR RPC didn't answer ft_balance_of: fetch failed/) }) }),
      expect.objectContaining({ level: 40, host: new URL(nearRpc.url).host, error: expect.objectContaining({ message: 'The NEAR RPC answered block with status 503' }) }),
    ]);
    for (const secret of ['near-dead-key-secret', 'near-query-secret', 'near-rpc-key-secret', '/other'])
      expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it.each([
    ['a token it doesn\'t know', () => ({ ...usdc(), address: 'no-token.testnet' }), 'The NEAR RPC refused ft_balance_of: UNKNOWN_ACCOUNT'],
    ['an account that isn\'t a token', () => ({ ...usdc(), address: holder }), 'The NEAR RPC answered ft_balance_of with the contract\'s error'],
  ])('throws on %s, without the RPC\'s URL', async (_case, assetOf, message) => {
    nearRpc.addAccount({ accountId: holder });
    const failure = await nearReader().balance({ address: stranger, asset: assetOf() }).then(() => undefined, (error: unknown) => error as Error);

    expect(failure?.message).toBe(message);
    expect(JSON.stringify({ message: failure?.message, cause: String(failure?.cause) })).not.toContain('near-rpc-key-secret');
  });

  it('reports the NEAR payTo\'s balance and the account top-ups deliver to, and the reconciliation counts both', async () => {
    const readers = readerFor({ near: nearReader() });
    nearRpc.setBalance(usdc().address, usdc().payTo!, 7_500_000n);
    nearRpc.setBalance(usdc().address, config.topups.recipient!, 2_500_000n);
    const registry = new Registry();

    expect(await balances(nearOnly(), readers, registry)).toEqual({ wallets: 2, balances: 2 });

    const text = await registry.metrics();
    expect(text).toMatch(/treasury_balance_usd\{wallet="payTo:near-usdc",asset="near-usdc"\} 7\.5\n/);
    expect(text).toMatch(/treasury_balance_usd\{wallet="treasury:near",asset="near-usdc"\} 2\.5\n/);
    // The ledger books a top-up into the treasury of its asset: the USDC sits in the account top-ups deliver to
    await ledger.treasuryTransfer({ reference: 'seed-near-usdc', from: { asset: 'seed', amount: 7_500_000n }, to: { asset: 'near-usdc', amount: 7_500_000n } });
    await createAccountRepository({ db: database.db }).create({ id: 'acc_topped_up', createdAt: clock.now() });
    await ledger.topUp({ accountId: 'acc_topped_up', asset: 'near-usdc', amount: 2_500_000n, reference: 'deposit-address-near' });
    expect(await reconciliation(nearOnly(), readers)).toEqual({ assets: 1, alerts: 0 });
    expect((await latestRun()).results).toEqual({ 'near-usdc': { ledger: '10', chain: '10', drift: '0', alert: false } });
  });

  it('fails the balance monitor when every NEAR RPC fails, logging their hosts only', async () => {
    logs.length = 0;
    const readers = readerFor({ near: nearReader([await closedUrl()]) });

    await expect(balances(nearOnly(), readers)).rejects.toThrow('2 treasury balances couldn\'t be read');

    expect(logs.filter(line => line['msg'] === 'Failed to read a treasury balance').map(line => line['wallet'])).toEqual(['payTo:near-usdc', 'treasury:near']);
    expect(logs.find(line => line['msg'] === 'Failed to read a treasury balance')).toMatchObject({
      level: 50, wallet: 'payTo:near-usdc', asset: 'near-usdc', network: 'near:testnet', error: { code: 'near_rpc_unavailable', message: expect.stringMatching(/^The NEAR RPC didn't answer ft_balance_of: fetch failed/) },
    });
    for (const secret of ['near-dead-key-secret', 'near-query-secret'])
      expect(JSON.stringify(logs)).not.toContain(secret);
  });
});
