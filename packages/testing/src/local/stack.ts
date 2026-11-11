import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { createApp as createApi } from '@anyfare/api';
import {
  createAddressPolicy, createLogger, OutboundHttp, Secret, systemClock, type Logger,
} from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createPostgres, createRedis, createRedisReplayStore, migrateDatabase } from '@anyfare/db';
import {
  createFacilitators, createMppSettlementCheck, createTempoRpc, initializeMpp, initializeX402,
} from '@anyfare/payments';
import { createApp as createProxy, createSignerClient } from '@anyfare/proxy';
import { createApp as createSigner } from '@anyfare/signer';
import { createOneClickClient } from '@anyfare/topups';
import { createApp as createWorkers } from '@anyfare/workers';

import { createFakeResolver } from '../dns.js';
import { startFakeFacilitator, type FakeFacilitator } from '../facilitator.js';
import { startFakeNearRpc, generateNearKey, type FakeNearRpc } from '../nearRpc.js';
import { startFakeOneClick, type FakeOneClick } from '../oneClick.js';
import { encodeBase58 } from '../solanaRpc.js';
import { startFakeTempoRpc, type FakeTempoRpc } from '../tempoRpc.js';
import { loadLocalConfig } from './config.js';
import { startFakePaidApi, type FakePaidApi } from './fakeApi.js';
import { assertLocalDatabase, assertNotProduction } from './guard.js';

// The local stack: the Platform API, the proxy, the workers and the Signer, with every outside service a
// fake from this package, on fixed local ports. Nothing here holds money: the keys are made up at start.

export interface StackPorts {
  // The pay host
  readonly proxy: number;
  readonly api: number;
  // The API's internal listener, which the proxy registers endpoints through
  readonly internalApi: number;
  readonly signer: number;
  // The workers have no public listener: their health and metrics are here
  readonly workers: number;
  readonly proxyMetrics: number;
  readonly apiMetrics: number;
  readonly signerMetrics: number;
  readonly facilitator: number;
  readonly paidApi: number;
  readonly oneClick: number;
  readonly nearRpc: number;
  readonly tempoRpc: number;
  // Where the website's dev server listens. Only named in links: nothing starts there.
  readonly website: number;
}

export const defaultStackPorts: StackPorts = {
  proxy: 8180,
  api: 8181,
  internalApi: 8182,
  signer: 8183,
  workers: 8184,
  proxyMetrics: 9180,
  apiMetrics: 9181,
  signerMetrics: 9183,
  facilitator: 8185,
  paidApi: 8186,
  oneClick: 8187,
  nearRpc: 8188,
  tempoRpc: 8189,
  website: 3000,
};

// The name of the fake paid API. The proxy's resolver knows it, and no other name.
export const fakeApiHost = 'fake-api.test';

export interface StackOptions {
  // DATABASE_URL and REDIS_URL: the local ones from docker-compose.yml
  readonly databaseUrl: string;
  readonly redisUrl: string;
  // Starts every Redis key and channel, so a test can share the server. Default: none.
  readonly redisPrefix?: string;
  // A port of 0 takes a free one. Default: defaultStackPorts.
  readonly ports?: Partial<StackPorts>;
  // Default: CONFIG_PATH of the environment, else config/example.yaml
  readonly configPath?: string;
  // Default: warnings only
  readonly logger?: Logger;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface LocalStack {
  readonly ports: StackPorts;
  readonly config: PlatformConfig;
  readonly urls: {
    readonly api: string;
    readonly pay: string;
    readonly website: string;
    readonly paidApi: string;
    readonly facilitator: string;
    readonly oneClick: string;
    readonly nearRpc: string;
    readonly tempoRpc: string;
  };
  // The fake paid API, as the pay host names it: `<host>:<port>`
  readonly paidApiHost: string;
  readonly paidApiEndpoints: FakePaidApi['endpoints'];
  close(): Promise<void>;
}

/** What the stack needs and can't find. Its message says how to fix it. */
export class StackPrerequisiteError extends Error {}

const signerSecret = 'local-signer-secret-0123456789abcdef-0123456789';
const internalSecret = 'local-internal-secret-0123456789abcdef-xyz';
const mppSecretKey = 'local-mpp-secret-key-0123456789abcdef-0123';

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));

  return port;
};

const waitForRedis = async (redis: ReturnType<typeof createRedis>, name: string): Promise<void> => {
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      await redis.ping();

      return;
    }
    catch {
      await sleep(200);
    }
  }
  throw new StackPrerequisiteError(`Redis isn't reachable at ${name}. Start it with: docker compose up -d redis`);
};

const hostOf = (url: string): string => {
  const parsed = new URL(url);

  return parsed.port === '' ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
};

/**
 * Starts everything, in order, and returns once each app listens. A failure closes what had started. The
 * proxy reaches the fake paid API the way the proxy's own functional tests do: its Outbound HTTP gets a
 * resolver that knows `fake-api.test`, an address policy that allows 127.0.0.0/8 on top of the public
 * one, and the fake's certificate as its only CA. That policy is refused when NODE_ENV is production.
 */
export const startLocalStack = async (options: StackOptions): Promise<LocalStack> => {
  const env = options.env ?? process.env;
  assertLocalDatabase(options.databaseUrl);
  assertNotProduction(await loadPlatformConfig({ env: { CONFIG_PATH: options.configPath ?? (env['CONFIG_PATH']?.trim() || 'config/example.yaml') } }), env);

  const logger = options.logger ?? createLogger({ name: 'stack', level: 'warn' });
  const requested = { ...defaultStackPorts, ...options.ports };
  const ports: StackPorts = Object.fromEntries(
    await Promise.all(Object.entries(requested).map(async ([name, port]) => [name, port === 0 ? await freePort() : port] as const)),
  ) as unknown as StackPorts;

  const closers: (() => Promise<unknown>)[] = [];
  const closeAll = async (): Promise<void> => {
    for (const close of closers.splice(0).reverse())
      await close().catch(() => undefined);
  };
  const own = <TResource extends { close(): Promise<unknown> }>(resource: TResource): TResource => {
    closers.push(() => resource.close());

    return resource;
  };

  try {
    // Postgres and Redis come from docker-compose.yml
    const databaseUrl = Secret.from(options.databaseUrl);
    const postgres = own(createPostgres({ url: databaseUrl, logger }));
    try {
      await postgres.ping();
    }
    catch (error) {
      throw new StackPrerequisiteError(`Postgres isn't reachable at ${hostOf(options.databaseUrl)}. Start it with: docker compose up -d db`, { cause: error });
    }
    await migrateDatabase({ url: databaseUrl, logger });
    const statsPostgres = own(createPostgres({ url: databaseUrl, logger, maxConnections: 4 }));
    const redis = own(createRedis({ url: Secret.from(options.redisUrl), logger, prefix: options.redisPrefix ?? '' }));
    await waitForRedis(redis, hostOf(options.redisUrl));

    // The fakes
    const facilitator: FakeFacilitator = own(await startFakeFacilitator({
      networks: ['eip155:84532', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'near:testnet'],
      feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)),
      port: ports.facilitator,
    }));
    const oneClick: FakeOneClick = own(await startFakeOneClick({ port: ports.oneClick }));
    const nearRpc: FakeNearRpc = own(await startFakeNearRpc({ port: ports.nearRpc }));
    const tempoRpc: FakeTempoRpc = own(await startFakeTempoRpc({ port: ports.tempoRpc }));

    // The platform config: the example's, with the local overrides, and our own ports. Its `urls` must be
    // HTTPS origins in a file, so they are set here, once the config is loaded.
    const loaded = await loadLocalConfig({
      ...options.configPath === undefined ? {} : { configPath: options.configPath },
      extra: {
        facilitators: [
          { name: 'cdp', url: facilitator.url, networks: ['eip155:84532', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'] },
          { name: 'near', url: facilitator.url, networks: ['near:testnet'] },
        ],
        topups: { url: oneClick.url },
      },
    }, env);
    const urls = {
      website: `http://localhost:${ports.website}`, api: `http://localhost:${ports.api}`, pay: `http://localhost:${ports.proxy}`,
    };
    const config: PlatformConfig = { ...loaded, urls, ownHosts: [...new Set([...loaded.ownHosts, 'localhost'])] };

    const paidApi = own(await startFakePaidApi({ config, host: fakeApiHost, port: ports.paidApi, tempoRpcUrl: tempoRpc.url }));
    const nearUsdc = findAsset(config, 'near-usdc')!;

    // The Signer's wallets: keys made now, for this run only. The NEAR wallet and its token exist on the fake node.
    const wallet = privateKeyToAccount(generatePrivateKey());
    const nearKey = generateNearKey();
    const hotWallet = 'hot.anyfare.testnet';
    nearRpc.addAccount({ accountId: hotWallet, publicKey: nearKey.publicKey });
    nearRpc.addAccount({ accountId: 'api.merchant.testnet' });
    nearRpc.addToken({ contractId: nearUsdc.address, balances: { [hotWallet]: 1_000_000_000n }, registered: ['api.merchant.testnet'] });

    const signer = own(createSigner({
      config, logger, postgres, redis, secret: Secret.from(signerSecret), tempoRpcUrl: tempoRpc.url,
      wallets: { base: wallet, tempo: wallet, near: { accountId: hotWallet, secretKey: Secret.from(nearKey.secretKey), rpcUrl: Secret.from(nearRpc.url) } },
    }));
    await signer.listen({ host: '127.0.0.1', port: ports.signer, metricsPort: ports.signerMetrics });

    const api = own(createApi({
      config, logger, postgres, redis, internalSecret: Secret.from(internalSecret),
      oneClick: createOneClickClient({ url: oneClick.url, timeoutMs: config.topups.timeoutMs }),
    }));
    await api.listen({ host: '127.0.0.1', port: ports.api, metricsPort: ports.apiMetrics, internalPort: ports.internalApi });

    const facilitators = createFacilitators({ config, cdpApiKey: () => { throw new Error('The local stack uses no CDP key'); }, clock: systemClock });
    const x402 = await initializeX402({ config, facilitators, timeoutMs: 5_000 });
    const claims = own(createRedisReplayStore({ redis }));
    const mpp = await initializeMpp({ config, secretKey: Secret.from(mppSecretKey), store: claims, timeoutMs: 5_000, rpcUrl: tempoRpc.url });
    const http = own(new OutboundHttp({
      ownHosts: config.ownHosts,
      resolver: createFakeResolver({ [fakeApiHost]: '127.0.0.1' }),
      addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
      ca: paidApi.ca,
      connectTimeoutMs: 5_000,
      totalTimeoutMs: 15_000,
    }));
    const proxy = own(createProxy({
      config, logger, postgres, redis, http, x402, mpp, claims,
      signer: createSignerClient({ url: `http://127.0.0.1:${ports.signer}`, secret: Secret.from(signerSecret), timeoutMs: 5_000 }),
      internalApi: { url: `http://127.0.0.1:${ports.internalApi}`, secret: Secret.from(internalSecret) },
    }));
    await proxy.listen({ host: '127.0.0.1', port: ports.proxy, metricsPort: ports.proxyMetrics });

    const workers = own(createWorkers({
      config, logger, postgres, statsPostgres, facilitators,
      mppCheck: createMppSettlementCheck({ rpc: createTempoRpc({ network: config.mpp.network, url: tempoRpc.url }), timeoutMs: config.timeouts.connectMs, clock: systemClock }),
      oneClick: createOneClickClient({ url: oneClick.url, timeoutMs: config.topups.timeoutMs }),
    }));
    await workers.listen({ host: '127.0.0.1', port: ports.workers });

    // One close, in the reverse order of the start: the proxy first, the connections last
    let closing: Promise<void> | undefined;

    return {
      ports,
      config,
      urls: {
        api: urls.api, pay: urls.pay, website: urls.website, paidApi: `https://${fakeApiHost}:${paidApi.port}`, facilitator: facilitator.url, oneClick: oneClick.url,
        nearRpc: nearRpc.url, tempoRpc: tempoRpc.url,
      },
      paidApiHost: `${fakeApiHost}:${paidApi.port}`,
      paidApiEndpoints: paidApi.endpoints,
      close: () => closing ??= closeAll(),
    };
  }
  catch (error) {
    await closeAll();
    throw error;
  }
};
