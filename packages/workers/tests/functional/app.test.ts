import { fixtureTime } from '@anyfare/testing';

import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger, runApp, Secret } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import {
  createAccountRepository, createPaymentRepository, createPostgres, createRoutingRepository, createTopupRepository, createTreasuryRepository,
} from '@anyfare/db';
import { createFacilitators } from '@anyfare/payments';
import {
  createFakeClock, createManualTimers, nearFacilitatorOff, createTestCertificate, createTestDatabase, encodeBase58, facilitatorAnswers, startFakeFacilitator,
  startFakeOneClick, startFakeSolanaRpc, startFakeTempoRpc, trustTestCertificate, type FakeFacilitator, type FakeOneClick, type FakeSolanaRpc, type FakeTempoRpc,
  type TestDatabase,
} from '@anyfare/testing';
import { createOneClickClient } from '@anyfare/topups';

import { createApp, type WorkersServer } from '../../src/app.js';
import { holdExpiryLockId } from '../../src/holdExpiry.js';
import { rebalancingIntervalMs, rebalancingLockId } from '../../src/rebalancing.js';
import { createRefillSigner } from '../../src/signerClient.js';
import { checkEachFacilitator, defaultMetricsPort, readEvmRpcUrls, readNearRpcUrls, startWorkers } from '../../src/start.js';
import { createEvmBalanceReader, createSolanaBalanceReader } from '../../src/treasury/readers.js';

const exampleConfig = { CONFIG_PATH: 'config/example.yaml' };
const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const silent = createLogger({ level: 'silent' });
const allJobs = ['hold_expiry', 'settlement_follow_up', 'routing_losses', 'public_stats', 'public_stats_all', 'treasury_balances', 'reconciliation'];
// What startWorkers runs on the example config: its top-ups section names a recipient and an asset, so the status job runs though top-ups are off,
// and with its 1Click client the rebalancing job, which follows the refills already sent though rebalancing is off
const startedJobs = [
  'hold_expiry', 'settlement_follow_up', 'routing_losses', 'public_stats', 'public_stats_all', 'topup_status', 'rebalancing', 'treasury_balances', 'reconciliation',
];

let config: PlatformConfig;
let database: TestDatabase;
let server: WorkersServer;
let url: string;
let evm: Awaited<ReturnType<typeof startFakeEvmRpc>>;
let solanaRpc: FakeSolanaRpc;

/** A JSON-RPC that answers every ERC-20 `balanceOf` through `eth_call` with $1. */
const startFakeEvmRpc = async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(call.method === 'eth_call'
        ? { jsonrpc: '2.0', id: call.id, result: `0x${(1_000_000n).toString(16).padStart(64, '0')}` }
        : { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `${call.method} isn't faked` } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

const closedPort = async (): Promise<number> => {
  const listener = createNetServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise(resolve => listener.close(resolve));

  return port;
};

const capture = (level = 'info') => {
  const lines: Record<string, unknown>[] = [];

  return { lines, logger: createLogger({ level }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }) };
};

// Readers against the fakes, for the treasury jobs
const fakeReaders = () => ({
  evm: createEvmBalanceReader({ rpcUrlFor: () => evm.url, timeoutMs: 2_000 }),
  solana: createSolanaBalanceReader({ rpcUrl: Secret.from(solanaRpc.url), timeoutMs: 2_000 }),
});

const metricsOf = async (app: WorkersServer): Promise<string> => {
  const port = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    return await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
  }
  finally {
    await app.close();
  }
};

// Disabled facilitators and MPP: the startup checks have their own tests
const quietStartup = Buffer.from(JSON.stringify({
  facilitators: [{ name: 'cdp', url: 'https://api.cdp.coinbase.com/platform/v2/x402', networks: [base, solana], enabled: false }, nearFacilitatorOff],
  mpp: { enabled: false },
})).toString('base64');

beforeAll(async () => {
  [config, database, evm, solanaRpc] = await Promise.all([loadPlatformConfig({ env: exampleConfig }), createTestDatabase(), startFakeEvmRpc(), startFakeSolanaRpc()]);
  server = createApp({ config, logger: silent, postgres: database.postgres });
  const port = await server.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server?.close();
  await Promise.all([evm?.close(), solanaRpc?.close()]);
  await database?.drop();
});

describe('workers on the metrics port', () => {
  it('answers /_/health, /_/ready with the Postgres check, and /metrics on one port', async () => {
    const [health, ready, metrics] = await Promise.all([fetch(`${url}/_/health`), fetch(`${url}/_/ready`), fetch(`${url}/metrics`)]);

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready', checks: { postgres: 'ok' } });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('process_cpu_user_seconds_total');
  });

  it('answers /_/ready with 503 while Postgres is unreachable', async () => {
    const down = createPostgres({ url: Secret.from(`postgres://anyfare:anyfare@127.0.0.1:${await closedPort()}/anyfare`), logger: silent, connectTimeoutMs: 1_000 });
    const app = createApp({ config, logger: silent, postgres: down });
    const port = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const ready = await fetch(`http://127.0.0.1:${port}/_/ready`);

      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: 'not_ready', checks: { postgres: 'failed' } });
    }
    finally {
      await app.close();
      await down.close();
    }
  });

  it('listens on 9082 by default', () => {
    expect(defaultMetricsPort).toBe(9082);
  });
});

describe('the jobs', () => {
  it('runs hold expiry, the settlement follow-up, routing losses and the public numbers\' two counts, and the treasury jobs only with a balance reader', () => {
    expect(server.jobs).toEqual(['hold_expiry', 'settlement_follow_up', 'routing_losses', 'public_stats', 'public_stats_all']);
    expect(createApp({ config, logger: silent, postgres: database.postgres, balanceReaders: fakeReaders() }).jobs).toEqual(allJobs);
  });

  it('runs each job under its advisory lock, and exports its last success time, duration and runs on the metrics port', async () => {
    const app = createApp({ config, logger: silent, postgres: database.postgres, balanceReaders: fakeReaders() });
    const results = [];
    for (const job of app.jobs)
      results.push(await app.scheduler.runNow(job));

    const text = await metricsOf(app);
    expect(results).toEqual(allJobs.map(() => 'success'));
    for (const job of allJobs) {
      expect(text).toMatch(new RegExp(`^workers_job_last_success_timestamp_seconds\\{job="${job}"\\} \\d+`, 'm'));
      expect(text).toMatch(new RegExp(`^workers_job_duration_seconds\\{job="${job}"\\} [\\d.e-]+$`, 'm'));
      expect(text).toContain(`workers_job_runs_total{job="${job}",result="success"} 1`);
    }
    // $1 in each of the example's payTo wallets
    expect(text).toMatch(/^treasury_balance_usd\{wallet="payTo:base-usdc",asset="base-usdc"\} 1$/m);
    expect(text).toMatch(/^treasury_drift_usd\{asset="base-usdc"\} 1$/m);
  });

  it('skips a job while another session holds its lock', async () => {
    const replica = createPostgres({ url: database.url, logger: silent });
    const app = createApp({ config, logger: silent, postgres: replica });
    try {
      const unlock = (await database.postgres.tryAdvisoryLock(holdExpiryLockId))!;
      try {
        expect(await app.scheduler.runNow('hold_expiry')).toBe('skipped');
      }
      finally {
        await unlock();
      }
      expect(await app.scheduler.runNow('hold_expiry')).toBe('success');
      expect(await metricsOf(app)).toContain('workers_job_runs_total{job="hold_expiry",result="skipped"} 1');
    }
    finally {
      await replica.close();
    }
  });
});

describe('the top-up status job', () => {
  let oneClick: FakeOneClick;
  // The example config with top-ups off, at the fake, and these changes to its top-ups section
  const envWith = (topups: Record<string, unknown>, env: Record<string, string> = {}) => ({
    ...exampleConfig,
    CONFIG: Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(quietStartup, 'base64').toString('utf8')) as object, topups: { url: oneClick.url, ...topups },
    })).toString('base64'),
    DATABASE_URL: database.url.expose(),
    HOST: '127.0.0.1',
    METRICS_PORT: '0',
    ...env,
  });

  beforeAll(async () => {
    oneClick = await startFakeOneClick();
  });

  afterAll(async () => {
    await oneClick?.close();
  });

  it('runs while the top-ups section names a recipient and an asset, whether or not top-ups are on, and only with a 1Click client', async () => {
    const client = createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 });
    const app = createApp({ config, logger: silent, postgres: database.postgres, oneClick: client });

    expect(config.topups).toMatchObject({ enabled: false, recipient: 'treasury.anyfare.testnet', asset: expect.objectContaining({ name: 'near-usdc' }) });
    expect(app.jobs).toEqual(['hold_expiry', 'settlement_follow_up', 'routing_losses', 'public_stats', 'public_stats_all', 'topup_status', 'rebalancing']);
    expect(await app.scheduler.runNow('topup_status')).toBe('success');
    const text = await metricsOf(app);
    expect(text).toContain('workers_job_runs_total{job="topup_status",result="success"} 1');
    expect(text).toContain('workers_topups_credited_total 0');

    const enabled = { ...config, topups: { ...config.topups, enabled: true } };
    expect(createApp({ config: enabled, logger: silent, postgres: database.postgres, oneClick: client }).jobs).toContain('topup_status');
    const withoutRecipient = { ...config, topups: { ...config.topups, recipient: undefined } };
    expect(createApp({ config: withoutRecipient, logger: silent, postgres: database.postgres, oneClick: client }).jobs).not.toContain('topup_status');
    expect(createApp({ config, logger: silent, postgres: database.postgres }).jobs).not.toContain('topup_status');
  });

  it('exits with 1 naming the 1Click key variable the config names and the environment lacks, top-ups on or off, and starts with it', async () => {
    for (const enabled of [false, true]) {
      const { lines, logger } = capture();
      const exit = vi.fn();

      await runApp({ name: 'workers', start: startWorkers, logger, exit, env: envWith({ enabled, apiKey: 'ONECLICK_API_KEY' }) });

      expect(exit).toHaveBeenCalledWith(1);
      expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ error: { code: 'missing_secret', secretName: 'ONECLICK_API_KEY' } });
    }

    const { lines, logger } = capture();
    const app = await startWorkers({ env: envWith({ enabled: false, apiKey: 'ONECLICK_API_KEY' }, { ONECLICK_API_KEY: 'oneclick-key-secret' }), logger });
    await app.close();

    expect(lines.find(line => line['msg'] === 'Started')).toMatchObject({ jobs: startedJobs });
    expect(JSON.stringify(lines)).not.toContain('oneclick-key-secret');
  });

  it('fails a run, and keeps the top-up polled, when 1Click refuses the key', async () => {
    const client = createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 });
    const clock = createFakeClock(fixtureTime(0, 12, 12, 0, 0, 0));
    const topups = createTopupRepository({ db: database.db, clock });
    const accountId = 'acc_refused_key';
    await createAccountRepository({ db: database.db }).create({ id: accountId, createdAt: clock.now() });
    await topups.create({
      id: 'top_refused_key', accountId, requestId: undefined, network: 'base', blockchain: 'base', tokenSymbol: 'USDC',
      originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', tokenDecimals: 6, amount: 1_000_000n, destinationAsset: 'near-usdc',
      recipient: 'treasury.anyfare.testnet', refundTo: 'treasury.anyfare.testnet', payBy: new Date(clock.now().getTime() + 24 * 60 * 60_000), quoteRequest: {},
    });
    await topups.markQuoted('top_refused_key', {
      quoteResponse: {}, correlationId: 'corr-refused-key', depositAddress: `0x${'7'.repeat(40)}`, depositMemo: undefined,
      addressExpiresAt: new Date(clock.now().getTime() + 96 * 60 * 60_000), sendAmount: 1_000_000n, sendAtLeast: 990_000n, estimatedCredits: 999_380n,
      nextPollAt: clock.now(),
    });
    oneClick.handle('/v0/status', () => ({ status: 401, body: { message: 'Unauthorized' } }));
    const { lines, logger } = capture();
    const app = createApp({ config, logger, postgres: database.postgres, clock, oneClick: client });
    try {
      expect(await app.scheduler.runNow('topup_status')).toBe('failure');
    }
    finally {
      oneClick.reset();
      await topups.markExpired('top_refused_key', 'waiting', { oneClickStatus: 'PENDING_DEPOSIT', lastStatus: {}, polledAt: clock.now() });
    }

    expect(lines.find(line => line['msg'] === 'A job failed' && line['job'] === 'topup_status')).toMatchObject({ level: 50, counts: { rejected: 1, polled: 1 } });
    expect(lines.find(line => line['msg'] === 'A top-up\'s status can\'t be read: 1Click refused our key or answered in a shape we don\'t know'))
      .toMatchObject({ level: 50, topupId: 'top_refused_key', reason: 'auth_failed', status: 401, alert: true });
  });

  it('has the balance monitor report the account top-ups deliver to', async () => {
    const app = createApp({ config, logger: silent, postgres: database.postgres, balanceReaders: { near: { balance: async () => 2_000_000n } } });

    expect(await app.scheduler.runNow('treasury_balances')).toBe('success');

    expect(await metricsOf(app)).toMatch(/^treasury_balance_usd\{wallet="treasury:near",asset="near-usdc"\} 2$/m);
  });
});

describe('the rebalancing job', () => {
  // Made-up Signer wallets, which rebalancing needs named
  const wallets = { base: `0x${'3'.repeat(40)}`, solana: encodeBase58(Buffer.alloc(32, 7)), near: 'hot.anyfare.testnet' };
  const signerEnv = { SIGNER_URL: 'http://127.0.0.1:8083', SIGNER_SECRET: 'rebalancing-signer-secret-0123456789' };
  // The example config with rebalancing on, or off, and the startup checks off
  const envWith = (enabled: boolean, env: Record<string, string> = {}): Record<string, string> => ({
    ...exampleConfig,
    CONFIG: Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(quietStartup, 'base64').toString('utf8')) as object, signer: { wallets }, rebalancing: { enabled },
    })).toString('base64'),
    DATABASE_URL: database.url.expose(),
    HOST: '127.0.0.1',
    METRICS_PORT: '0',
    ...env,
  });
  const warning = 'Rebalancing is on, but the workers can\'t reach the Signer: no refills';

  it('runs with a 1Click client, on or off and with or without a Signer, every rebalancing.intervalSeconds', async () => {
    const on = await loadPlatformConfig({ env: envWith(true) });
    const oneClick = createOneClickClient({ url: 'http://127.0.0.1:8085', timeoutMs: 2_000 });
    const signer = createRefillSigner({ url: signerEnv.SIGNER_URL, secret: Secret.from(signerEnv.SIGNER_SECRET) });

    expect(createApp({ config: on, logger: silent, postgres: database.postgres, oneClick, signer }).jobs).toContain('rebalancing');
    // Without a Signer, or switched off, it asks for no refill and still follows the ones already sent
    expect(createApp({ config: on, logger: silent, postgres: database.postgres, oneClick }).jobs).toContain('rebalancing');
    expect(createApp({ config, logger: silent, postgres: database.postgres, oneClick, signer }).jobs).toContain('rebalancing');
    expect(createApp({ config: on, logger: silent, postgres: database.postgres, signer }).jobs).not.toContain('rebalancing');
    expect(rebalancingIntervalMs(on)).toBe(300_000);
    expect(rebalancingLockId).toBe(7_301_746_214);
  });

  it('warns once at start when rebalancing is on without SIGNER_URL or SIGNER_SECRET, and starts the job with both, never logging the secret', async () => {
    for (const missing of ['SIGNER_URL', 'SIGNER_SECRET'] as const) {
      const { lines, logger } = capture();
      const env = envWith(true, signerEnv);
      delete env[missing];

      const app = await startWorkers({ env, logger });
      await app.close();

      expect(lines.filter(line => line['msg'] === warning)).toEqual([expect.objectContaining({ level: 40, missing: [missing] })]);
      expect(lines.find(line => line['msg'] === 'Started')).toMatchObject({ jobs: startedJobs });
    }

    const { lines, logger } = capture();
    const app = await startWorkers({ env: envWith(true, signerEnv), logger });
    await app.close();

    expect(lines.find(line => line['msg'] === 'Started')).toMatchObject({ jobs: startedJobs });
    expect(lines.filter(line => line['msg'] === warning)).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(signerEnv.SIGNER_SECRET);

    // Off: the Signer isn't read, and nothing warns
    const off = capture();
    await (await startWorkers({ env: envWith(false), logger: off.logger })).close();
    expect(off.lines.find(line => line['msg'] === 'Started')).toMatchObject({ jobs: startedJobs });
    expect(off.lines.filter(line => line['msg'] === warning)).toEqual([]);
  });
});

describe('the reconciliation across restarts', () => {
  const hourMs = 60 * 60_000;

  /** Workers on a database of their own, on manual timers, as a replica that just started. */
  const restart = async (latestRunAgoMs: number | undefined) => {
    const own = await createTestDatabase();
    const clock = createFakeClock(fixtureTime(0, 10, 12, 0, 0, 0));
    const treasury = createTreasuryRepository({ db: own.db });
    if (latestRunAgoMs !== undefined)
      await treasury.recordReconciliationRun({ id: 'rec_before_restart', ranAt: new Date(clock.now().getTime() - latestRunAgoMs), results: {}, alerts: 0 });
    const timers = createManualTimers();
    const app = createApp({ config, logger: silent, postgres: own.postgres, clock, timers, balanceReaders: fakeReaders() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const latestId = async () => (await treasury.latestReconciliationRun())?.id;

    return {
      timers, latestId,
      close: async () => {
        await app.close();
        await own.drop();
      },
    };
  };

  it('runs a day after the last run: an hour after a restart 23 hours later', async () => {
    const replica = await restart(23 * hourMs);
    try {
      replica.timers.advance(hourMs - 1_000);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await replica.latestId()).toBe('rec_before_restart');

      replica.timers.advance(1_000);
      await vi.waitFor(async () => expect(await replica.latestId()).toMatch(/^rec_(?!before_restart)/));
    }
    finally {
      await replica.close();
    }
  });

  it('runs at once after a restart with no run yet, or with the last a day or more ago', async () => {
    for (const ago of [undefined, 25 * hourMs]) {
      const replica = await restart(ago);
      try {
        replica.timers.advance(0);
        await vi.waitFor(async () => expect(await replica.latestId()).toMatch(/^rec_(?!before_restart)/));
      }
      finally {
        await replica.close();
      }
    }
  });

  it('exports every job\'s last success time as 0 before its first run', async () => {
    const app = createApp({ config, logger: silent, postgres: database.postgres, balanceReaders: fakeReaders() });
    const text = await metricsOf(app);

    for (const job of allJobs)
      expect(text).toContain(`workers_job_last_success_timestamp_seconds{job="${job}"} 0`);
  });
});

describe('two workers on one database', () => {
  let facilitator: FakeFacilitator;

  beforeAll(async () => {
    facilitator = await startFakeFacilitator({ networks: [base, solana] });
  });

  afterAll(async () => {
    await facilitator?.close();
  });

  it('runs a job on one of them: the other finds its lock taken and skips', async () => {
    const withFacilitator = await loadPlatformConfig({
      env: { ...exampleConfig, CONFIG: Buffer.from(JSON.stringify({ facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff] })).toString('base64') },
    });
    // A payment left settling long enough ago, with its target leg, and a facilitator slow to settle it
    const clock = createFakeClock(fixtureTime(0, 9, 12, 0, 0, 0));
    const payments = createPaymentRepository({ db: database.db, clock });
    await payments.create({
      id: 'pay_two_workers', requestId: 'req-two-workers', rail: 'x402', buyerAccountId: undefined, keyId: undefined, targetHost: 'api.target.test',
      targetPath: '/v1/quote', network: base, asset: 'base-usdc', atomicAmount: 1_000n, amount: 1_000n, status: 'verified',
    });
    const routing = createRoutingRepository({ db: database.db, clock });
    await routing.recordTargetPayment({
      paymentId: 'pay_two_workers', protocol: 'x402', network: base, asset: 'base-usdc', amount: 800n, atomicAmount: 800n,
      payTo: '0x4444444444444444444444444444444444444444', signatureId: 'sig_two_workers',
    });
    await payments.changeStatus({
      paymentId: 'pay_two_workers', to: 'settling', settlementRequest: { paymentPayload: { x402Version: 2, payload: {} }, paymentRequirements: { network: base } },
    });
    facilitator.handle('/settle', request => ({ ...facilitatorAnswers.settled(request), delayMs: 300 }));
    clock.advance(10 * 60_000);
    const replica = createPostgres({ url: database.url, logger: silent });
    const appFor = (postgres: typeof replica) => createApp({
      config: withFacilitator, logger: silent, postgres, clock,
      facilitators: createFacilitators({ config: withFacilitator, cdpApiKey: () => { throw new Error('No CDP key in tests'); }, clock }),
    });
    const [first, second] = [appFor(database.postgres), appFor(replica)];

    try {
      const running = first.scheduler.runNow('settlement_follow_up');
      await vi.waitFor(() => expect(facilitator.requests.some(request => request.path === '/settle')).toBe(true));
      const skipped = await second.scheduler.runNow('settlement_follow_up');

      expect(skipped).toBe('skipped');
      expect(await running).toBe('success');
      expect(facilitator.requests.filter(request => request.path === '/settle')).toHaveLength(1);
      expect(await payments.find('pay_two_workers')).toMatchObject({ status: 'settled' });
      expect(await metricsOf(second)).toContain('workers_job_runs_total{job="settlement_follow_up",result="skipped"} 1');
    }
    finally {
      await first.close();
      await replica.close();
    }
  });
});

describe('startup', () => {
  it('exits with 1 and logs the reason when the platform config is invalid', async () => {
    const { lines, logger } = capture();
    const exit = vi.fn();

    await runApp({ name: 'workers', start: startWorkers, logger, exit, env: { CONFIG_PATH: 'config/missing.yaml' } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ level: 60, error: { message: expect.stringContaining('config/missing.yaml') } });
  });

  it('exits with 1 without DATABASE_URL', async () => {
    const { lines, logger } = capture();
    const exit = vi.fn();

    await runApp({ name: 'workers', start: startWorkers, logger, exit, env: { ...exampleConfig, CONFIG: quietStartup } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ error: { code: 'missing_secret', secretName: 'DATABASE_URL' } });
  });

  it('exits with 1 naming the CDP key variable an enabled facilitator needs and the environment lacks', async () => {
    const { lines, logger } = capture();
    const exit = vi.fn();

    await runApp({ name: 'workers', start: startWorkers, logger, exit, env: { ...exampleConfig, DATABASE_URL: database.url.expose(), CDP_API_KEY_ID: 'key-id' } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ error: { code: 'missing_secret', secretName: 'CDP_API_KEY_SECRET' } });
  });

  it.each([
    ['an item without a network', 'https://base.example'],
    ['a network that isn\'t EVM', `${solana}=https://sol.example`],
    ['a URL that isn\'t HTTP(S)', 'eip155:8453=ftp://base.example/evm-url-secret'],
  ])('refuses EVM_RPC_URLS with %s, without echoing it', (_case, value) => {
    expect(() => readEvmRpcUrls({ EVM_RPC_URLS: value }, config)).toThrow('EVM_RPC_URLS must be eip155:<chain ID>=<HTTP(S) URL> items, separated by commas');
    try {
      readEvmRpcUrls({ EVM_RPC_URLS: value }, config);
    }
    catch (error) {
      expect((error as Error).message).not.toContain('example');
    }
  });

  it('reads EVM_RPC_URLS over the public defaults and mpp.rpcUrl', () => {
    const urls = readEvmRpcUrls({ EVM_RPC_URLS: ' eip155:8453=https://base.example/rpc?region=eu , eip155:42431=https://tempo.example ' }, {
      mpp: { ...config.mpp, rpcUrl: 'https://tempo-from-config.example' },
    });

    expect(urls.get('eip155:8453')).toBe('https://base.example/rpc?region=eu');
    expect(urls.get('eip155:42431')).toBe('https://tempo.example');
    expect(urls.get('eip155:84532')).toBe('https://sepolia.base.org');
  });

  it('reads NEAR_RPC_URLS for the config\'s NEAR network in order, then the x402 SDK\'s public RPC as the last fallback', () => {
    expect(readNearRpcUrls({}, 'near:testnet')).toEqual(['https://rpc.testnet.fastnear.com']);
    expect(readNearRpcUrls({ NEAR_RPC_URLS: ' near:mainnet=https://near.example/v1/near-key , near:mainnet=https://backup.example ' }, 'near:mainnet')).toEqual([
      'https://near.example/v1/near-key', 'https://backup.example', 'https://rpc.mainnet.fastnear.com',
    ]);
  });

  it.each([
    ['an item without a network', 'https://near.example/near-url-secret', 'NEAR_RPC_URLS must be near:<network>=<HTTP(S) URL> items'],
    ['a network that isn\'t NEAR', `${base}=https://near.example/near-url-secret`, 'NEAR_RPC_URLS must be near:<network>=<HTTP(S) URL> items'],
    ['another NEAR network than the config\'s', 'near:mainnet=https://near.example/near-url-secret', 'NEAR_RPC_URLS names near:mainnet, but the platform config\'s NEAR network is near:testnet'],
    ['a password', 'near:testnet=https://user:near-url-secret@near.example', 'NEAR_RPC_URLS can\'t carry a username or password'],
  ])('refuses NEAR_RPC_URLS with %s, without echoing it', (_case, value, message) => {
    const error = (() => {
      try {
        readNearRpcUrls({ NEAR_RPC_URLS: value }, 'near:testnet');
      }
      catch (thrown) {
        return thrown as Error;
      }
      return undefined;
    })();

    expect(error?.message).toContain(message);
    expect(error?.message).not.toContain('near-url-secret');
  });
});

describe('the facilitators at startup', () => {
  // The facilitator at a fake, without auth: the settlement follow-up repeats settles through it
  const envFor = (facilitatorUrl: string) => ({
    ...exampleConfig,
    CONFIG: Buffer.from(JSON.stringify({ facilitators: [{ name: 'cdp', url: facilitatorUrl, networks: [base, solana] }, nearFacilitatorOff], mpp: { enabled: false } })).toString('base64'),
    DATABASE_URL: database.url.expose(),
    HOST: '127.0.0.1',
    METRICS_PORT: '0',
  });

  it('starts once every enabled facilitator answers /supported with exact on its networks', async () => {
    // A made-up Solana fee payer, which Solana's exact scheme needs
    const facilitator = await startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) });
    try {
      const { lines, logger } = capture();
      const app = await startWorkers({ env: envFor(facilitator.url), logger });
      await app.close();

      expect(facilitator.requests.map(request => request.path)).toContain('/supported');
      expect(lines.find(line => line['msg'] === 'Started')).toMatchObject({ settlementFollowUp: { facilitators: ['cdp'], mpp: false } });
    }
    finally {
      await facilitator.close();
    }
  });

  it.each([
    ['its /supported fails', (facilitator: FakeFacilitator) => facilitator.handle('/supported', facilitatorAnswers.unavailable), 'The cdp facilitator\'s /supported failed'],
    ['it doesn\'t list exact on its network', () => undefined, `doesn't list exact on ${solana}`],
  ])('starts when %s, with a warning naming it, and the follow-up runs without it', async (_case, script, message) => {
    // Supports Base Sepolia only, unless the case scripts /supported
    const facilitator = await startFakeFacilitator({ networks: [base] });
    script(facilitator);
    const { lines, logger } = capture();
    try {
      const app = await startWorkers({ env: envFor(facilitator.url), logger });
      const started = lines.find(line => line['msg'] === 'Started');
      try {
        const port = (started?.['ports'] as { metricsPort: number }).metricsPort;
        const ready = await fetch(`http://127.0.0.1:${port}/_/ready`);

        // Hold expiry and routing losses need no facilitator: readiness is Postgres only
        expect(ready.status).toBe(200);
      }
      finally {
        await app.close();
      }

      const warning = lines.find(line => line['msg'] === 'A facilitator failed its startup check: the settlement follow-up runs without it until a restart');
      expect(warning).toMatchObject({ level: 40, facilitator: 'cdp' });
      expect(JSON.stringify(warning)).toContain(message);
      expect(started).toMatchObject({ jobs: startedJobs, settlementFollowUp: { facilitators: [], mpp: false } });
    }
    finally {
      await facilitator.close();
    }
  });
});

describe('two facilitators at startup, one of them down', () => {
  const feePayer = encodeBase58(Uint8Array.from({ length: 32 }, () => 9));
  let down: FakeFacilitator;
  let up: FakeFacilitator;

  beforeAll(async () => {
    [down, up] = await Promise.all([startFakeFacilitator({ networks: [base] }), startFakeFacilitator({ networks: [solana], feePayer })]);
    down.handle('/supported', facilitatorAnswers.unavailable);
  });

  afterAll(async () => {
    await Promise.all([down?.close(), up?.close()]);
  });

  const twoFacilitators = () => Buffer.from(JSON.stringify({
    facilitators: [{ name: 'cdp', url: down.url, networks: [base] }, { name: 'backup', url: up.url, networks: [solana] }, nearFacilitatorOff],
    mpp: { enabled: false },
  })).toString('base64');

  it('keeps the one that passes, warns about the other, and the follow-up repeats settles through the one kept', async () => {
    const { lines, logger } = capture();
    const env = { ...exampleConfig, CONFIG: twoFacilitators(), DATABASE_URL: database.url.expose(), HOST: '127.0.0.1', METRICS_PORT: '0' };

    const started = await startWorkers({ env, logger });
    await started.close();

    expect(lines.filter(line => line['msg'] === 'A facilitator failed its startup check: the settlement follow-up runs without it until a restart')).toEqual([
      expect.objectContaining({ level: 40, facilitator: 'cdp' }),
    ]);
    expect(lines.find(line => line['msg'] === 'Started')).toMatchObject({ settlementFollowUp: { facilitators: ['backup'], mpp: false } });

    // The same check and lookup, on workers whose follow-up a test can run
    const twoConfig = await loadPlatformConfig({ env: { ...exampleConfig, CONFIG: twoFacilitators() } });
    const clock = createFakeClock(fixtureTime(0, 11, 12, 0, 0, 0));
    const kept = await checkEachFacilitator({
      config: twoConfig, facilitators: createFacilitators({ config: twoConfig, cdpApiKey: () => { throw new Error('No CDP key in tests'); }, clock }), logger: silent,
    });
    expect(kept.map(facilitator => facilitator.name)).toEqual(['backup']);
    const payments = createPaymentRepository({ db: database.db, clock });
    const routing = createRoutingRepository({ db: database.db, clock });
    for (const [id, network, asset] of [['pay_backup_solana', solana, 'solana-usdc'], ['pay_backup_base', base, 'base-usdc']] as const) {
      await payments.create({
        id, requestId: `req-${id}`, rail: 'x402', buyerAccountId: undefined, keyId: undefined, targetHost: 'api.target.test', targetPath: '/v1/quote',
        network, asset, atomicAmount: 1_000n, amount: 1_000n, status: 'verified',
      });
      await routing.recordTargetPayment({
        paymentId: id, protocol: 'x402', network: base, asset: 'base-usdc', amount: 800n, atomicAmount: 800n,
        payTo: '0x4444444444444444444444444444444444444444', signatureId: `sig_${id}`,
      });
      await payments.changeStatus({
        paymentId: id, to: 'settling', settlementRequest: { paymentPayload: { x402Version: 2, payload: { transaction: id } }, paymentRequirements: { network } },
      });
    }
    clock.advance(10 * 60_000);
    const app = createApp({ config: twoConfig, logger: silent, postgres: database.postgres, clock, facilitators: kept });
    try {
      // The Base payment waits for its facilitator: the run fails, and the Solana one settles
      expect(await app.scheduler.runNow('settlement_follow_up')).toBe('failure');
    }
    finally {
      await app.close();
    }

    expect(up.requests.filter(request => request.path === '/settle').map(request => (request.body as { paymentRequirements: { network: string } }).paymentRequirements.network))
      .toEqual([solana]);
    expect(down.requests.filter(request => request.path === '/settle')).toEqual([]);
    expect(await payments.find('pay_backup_solana')).toMatchObject({ status: 'settled' });
    expect(await payments.find('pay_backup_base')).toMatchObject({ status: 'settling', needsReview: false });
    await payments.changeStatus({ paymentId: 'pay_backup_base', to: 'failed', settlementRequest: null });
  });
});

describe('the Tempo node at startup', () => {
  // The follow-up reads MPP receipts there. mpp.rpcUrl must be HTTPS: the fake serves a test certificate.
  const certificate = createTestCertificate({ hosts: ['127.0.0.1'] });
  const envFor = (mpp: Record<string, unknown>) => ({
    ...exampleConfig,
    CONFIG: Buffer.from(JSON.stringify({
      facilitators: [{ name: 'cdp', url: 'https://api.cdp.coinbase.com/platform/v2/x402', networks: [base, solana], enabled: false }, nearFacilitatorOff],
      mpp,
    })).toString('base64'),
    DATABASE_URL: database.url.expose(),
    HOST: '127.0.0.1',
    METRICS_PORT: '0',
  });
  const withRpc = async (work: (rpc: FakeTempoRpc) => Promise<void>) => {
    const rpc = await startFakeTempoRpc({ tls: certificate });
    const untrust = trustTestCertificate(certificate);
    try {
      await work(rpc);
    }
    finally {
      await untrust();
      await rpc.close();
    }
  };

  it('starts once the Tempo node answers with mpp.network\'s chain ID', async () => {
    await withRpc(async rpc => {
      const { lines, logger } = capture();
      const app = await startWorkers({ env: envFor({ rpcUrl: rpc.url }), logger });
      await app.close();

      expect(rpc.calls.map(call => call.method)).toEqual(['eth_chainId']);
      expect(lines.find(line => line['msg'] === 'Started')).toMatchObject({ settlementFollowUp: { facilitators: [], mpp: true } });
    });
  });

  it.each([
    ['answers another chain ID', (rpc: FakeTempoRpc) => rpc.answerChainId(4_217), 'The Tempo RPC answers chain ID 4217, not 42431 (mpp.network)'],
    ['doesn\'t answer', (rpc: FakeTempoRpc) => rpc.unavailable(true), 'HTTP request failed'],
  ])('starts when the Tempo node %s, with a warning, and the follow-up runs without it', async (_case, script, message) => {
    await withRpc(async rpc => {
      script(rpc);
      const { lines, logger } = capture();

      const app = await startWorkers({ env: envFor({ rpcUrl: rpc.url }), logger });
      await app.close();

      const warning = lines.find(line => line['msg'] === 'The Tempo node failed its startup check: the settlement follow-up runs without it until a restart');
      expect(warning).toMatchObject({ level: 40, network: 'eip155:42431' });
      expect(JSON.stringify(warning)).toContain(message);
      expect(JSON.stringify(warning)).not.toContain(rpc.url);
      expect(lines.find(line => line['msg'] === 'Started')).toMatchObject({ settlementFollowUp: { facilitators: [], mpp: false } });
    });
  });

  it('never calls the Tempo node with mpp.enabled: false', async () => {
    await withRpc(async rpc => {
      const app = await startWorkers({ env: envFor({ enabled: false, rpcUrl: rpc.url }), logger: capture().logger });
      await app.close();

      expect(rpc.calls).toEqual([]);
    });
  });
});

describe('the workers\' lines', () => {
  it('runs every job without logging a secret: an RPC\'s error is its short message, never its URL with a key', async () => {
    const { lines, logger } = capture('debug');
    const port = await closedPort();
    const app = createApp({
      config, logger, postgres: database.postgres,
      balanceReaders: {
        // An RPC that refuses, at a URL that carries a key in its path and its query
        evm: createEvmBalanceReader({ rpcUrlFor: () => `http://127.0.0.1:${port}/v2/evm-rpc-key-secret?apikey=evm-query-secret`, timeoutMs: 2_000 }),
        // A Solana RPC that refuses, with a key in its path
        solana: createSolanaBalanceReader({ rpcUrl: Secret.from(`http://127.0.0.1:${port}/solana-rpc-key-secret`), timeoutMs: 2_000 }),
      },
    });
    try {
      for (const job of app.jobs)
        await app.scheduler.runNow(job);
    }
    finally {
      await app.close();
    }

    expect(lines.filter(line => line['msg'] === 'A job ran').map(line => line['job'])).toEqual(['hold_expiry', 'settlement_follow_up', 'routing_losses', 'public_stats', 'public_stats_all']);
    expect(lines.find(line => line['msg'] === 'A job ran' && line['job'] === 'hold_expiry')).toMatchObject({ level: 20, counts: { captured: 0, released: 0, failed: 0 } });
    expect(lines.find(line => line['msg'] === 'Failed to read a treasury balance' && line['network'] === base)).toMatchObject({
      level: 50, error: { message: expect.stringContaining('HTTP request failed.') },
    });
    expect(lines.find(line => line['msg'] === 'Failed to read a treasury balance' && line['network'] === solana)).toMatchObject({
      level: 50, error: { message: expect.stringMatching(/^The Solana RPC didn't answer getTokenAccountsByOwner: fetch failed: connect ECONNREFUSED/) },
    });
    expect(lines.filter(line => line['msg'] === 'A job failed').map(line => line['job'])).toEqual(['treasury_balances', 'reconciliation']);
    expect(lines.find(line => line['msg'] === 'A job failed' && line['job'] === 'treasury_balances')).toMatchObject({
      level: 50, error: { message: expect.stringContaining('treasury balances couldn\'t be read') },
    });
    const logged = JSON.stringify(lines);
    for (const secret of ['evm-rpc-key-secret', 'evm-query-secret', 'solana-rpc-key-secret', 'balanceOf', 'Request body'])
      expect(logged).not.toContain(secret);
  });

  it('logs one startup line with the commit, the jobs, the follow-up\'s rails and the treasury readers\' networks, at LOG_LEVEL, never a secret', async () => {
    const { lines, logger } = capture();
    const env = {
      ...exampleConfig,
      CONFIG: quietStartup,
      DATABASE_URL: database.url.expose(),
      EVM_RPC_URLS: 'eip155:8453=https://base.example/v2/startup-rpc-path',
      SOLANA_RPC_URL: 'https://sol.example/startup-solana-key',
      NEAR_RPC_URLS: 'near:testnet=https://near.example/startup-near-key',
      HOST: '127.0.0.1',
      METRICS_PORT: '0',
      LOG_LEVEL: 'debug',
      GIT_SHA: 'deadbee',
    };

    const app = await startWorkers({ env, logger });
    await app.close();

    expect(logger.level).toBe('debug');
    expect(lines.filter(line => line['msg'] === 'Started')).toEqual([expect.objectContaining({
      level: 30, app: 'workers', commit: 'deadbee', logLevel: 'debug', environment: 'staging',
      rails: { credits: true, x402: [], mpp: false },
      jobs: startedJobs,
      settlementFollowUp: { facilitators: [], mpp: false },
      treasuryReaders: { evm: expect.arrayContaining(['eip155:8453', 'eip155:84532', 'eip155:42431']), solana: 'sol.example', near: ['near.example', 'rpc.testnet.fastnear.com'] },
      ports: { metricsPort: expect.any(Number) },
    })]);
    const logged = JSON.stringify(lines);
    for (const secret of ['startup-rpc-path', 'startup-solana-key', 'startup-near-key', database.url.expose()])
      expect(logged).not.toContain(secret);
  });

  it('warns at startup when SOLANA_RPC_URL is unset, and reads Solana through the network\'s public RPC', async () => {
    const { lines, logger } = capture();
    const env = { ...exampleConfig, CONFIG: quietStartup, DATABASE_URL: database.url.expose(), HOST: '127.0.0.1', METRICS_PORT: '0' };

    const app = await startWorkers({ env, logger });
    await app.close();

    expect(lines.filter(line => typeof line['msg'] === 'string' && line['msg'].startsWith('SOLANA_RPC_URL is not set'))).toEqual([
      expect.objectContaining({ level: 40, host: 'api.devnet.solana.com' }),
    ]);
    expect(lines.find(line => line['msg'] === 'Started')).toMatchObject({ treasuryReaders: { solana: 'api.devnet.solana.com' } });
  });

  it('starts its jobs with the listener, and stops them before it closes', async () => {
    const { lines, logger } = capture('debug');
    const env = { ...exampleConfig, CONFIG: quietStartup, DATABASE_URL: database.url.expose(), HOST: '127.0.0.1', METRICS_PORT: '0' };

    const app = await startWorkers({ env, logger });
    await app.close();

    expect(lines.filter(line => line['msg'] === 'Started')).toHaveLength(1);
    // Nothing ran: every first run is one interval away, and the public numbers' come after the payments' jobs
    expect(lines.filter(line => line['msg'] === 'A job ran' || line['msg'] === 'A job failed')).toEqual([]);
  });
});
