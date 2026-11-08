import {
  InvalidEnvironmentError, readCommit, readHost, readLogLevel, readPort, readSecret, systemClock, type AppContext, type AppEnvironment, type Logger,
  type RunningApp,
} from '@anyfare/common';
import { loadPlatformConfig, platformSummary, readSolanaRpc, type PlatformConfig } from '@anyfare/core';
import { createPostgres } from '@anyfare/db';
import {
  checkFacilitators, createFacilitators, createMppSettlementCheck, createTempoRpc, type Facilitator, type MppSettlementCheck,
} from '@anyfare/payments';
import { NEAR_RPC_URLS } from '@x402/near';

import { createApp } from './app.js';
import { createEvmBalanceReader, createNearBalanceReader, createSolanaBalanceReader, type NearBalanceReader } from './treasury/readers.js';

export const defaultMetricsPort = 9082;
// How long the facilitators get to answer /supported at startup, and the Tempo node its chain ID
export const startupCheckTimeoutMs = 10_000;
// Each balance read of the treasury jobs
export const balanceReadTimeoutMs = 10_000;

// Public RPCs of the EVM networks the treasury reads. EVM_RPC_URLS overrides them, and mpp.rpcUrl Tempo's.
const defaultEvmRpcUrls: Readonly<Record<string, string>> = {
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:84532': 'https://sepolia.base.org',
  'eip155:4217': 'https://rpc.tempo.xyz',
  'eip155:42431': 'https://rpc.moderato.tempo.xyz',
};

const evmNetworkPattern = /^eip155:[1-9][0-9]*$/;

const httpUrlOf = (value: string): URL | undefined => {
  try {
    const url = new URL(value);

    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  }
  catch {
    return undefined;
  }
};

const isHttpUrl = (value: string): boolean => httpUrlOf(value) !== undefined;

const hostOf = (url: string): string => httpUrlOf(url)?.host ?? 'an RPC';

/**
 * The EVM RPCs the treasury reads, by network: the public defaults, `mpp.rpcUrl` for `mpp.network`,
 * then `EVM_RPC_URLS`, `eip155:8453=https://…,eip155:4217=https://…`, without credentials. An invalid
 * item throws without echoing it.
 */
export const readEvmRpcUrls = (env: AppEnvironment, config: Pick<PlatformConfig, 'mpp'>): ReadonlyMap<string, string> => new Map([
  ...Object.entries(defaultEvmRpcUrls),
  ...config.mpp.rpcUrl ? [[config.mpp.network.id, config.mpp.rpcUrl] as const] : [],
  ...(env['EVM_RPC_URLS'] ?? '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const separator = item.indexOf('=');
    const network = separator < 0 ? '' : item.slice(0, separator).trim();
    const url = separator < 0 ? '' : item.slice(separator + 1).trim();
    if (!evmNetworkPattern.test(network) || !isHttpUrl(url))
      throw new InvalidEnvironmentError('EVM_RPC_URLS must be eip155:<chain ID>=<HTTP(S) URL> items, separated by commas');

    return [network, url] as const;
  }),
]);

/**
 * The NEAR RPCs the treasury and the settlement follow-up read on the platform config's NEAR network, in
 * order: the items of NEAR_RPC_URLS, `near:mainnet=https://…` separated by commas as the facilitator
 * reads them, then the x402 SDK's public RPC of the network, the one fallback left when they fail.
 * Only that network may be named. A URL may carry a key in its path or query string, never as a
 * username or password, so an invalid item throws without echoing it, and only hosts are logged.
 */
export const readNearRpcUrls = (env: AppEnvironment, network: string): readonly string[] => {
  const urls: string[] = [];
  for (const item of (env['NEAR_RPC_URLS'] ?? '').split(',').map(entry => entry.trim()).filter(Boolean)) {
    const separator = item.indexOf('=');
    const name = separator < 0 ? '' : item.slice(0, separator).trim();
    const url = separator < 0 ? '' : item.slice(separator + 1).trim();
    const parsed = httpUrlOf(url);
    if (!(name in NEAR_RPC_URLS) || !parsed)
      throw new InvalidEnvironmentError('NEAR_RPC_URLS must be near:<network>=<HTTP(S) URL> items, separated by commas');
    if (parsed.username !== '' || parsed.password !== '')
      throw new InvalidEnvironmentError('NEAR_RPC_URLS can\'t carry a username or password: put a key in the path or the query string');
    if (name !== network)
      throw new InvalidEnvironmentError(`NEAR_RPC_URLS names ${name}, but the platform config's NEAR network is ${network}`);
    urls.push(url);
  }
  const fallback = (NEAR_RPC_URLS as Readonly<Record<string, string>>)[network];

  return [...new Set([...urls, ...fallback === undefined ? [] : [fallback]])];
};

/**
 * Each facilitator's startup check on its own: `/supported` with `exact` on each of its networks.
 * Returns those that passed, and warns about each that didn't.
 */
export const checkEachFacilitator = async ({ config, facilitators, logger, timeoutMs = startupCheckTimeoutMs }: {
  readonly config: PlatformConfig;
  readonly facilitators: readonly Facilitator[];
  readonly logger: Logger;
  readonly timeoutMs?: number;
}): Promise<Facilitator[]> => {
  const checks = await Promise.allSettled(facilitators.map(facilitator => checkFacilitators({ config, facilitators: [facilitator], timeoutMs })));

  return facilitators.filter((facilitator, index) => {
    const check = checks[index];
    if (check?.status !== 'rejected')
      return true;
    logger.warn({ error: check.reason, facilitator: facilitator.name },
      'A facilitator failed its startup check: the settlement follow-up runs without it until a restart');

    return false;
  });
};

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startWorkers = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const databaseUrl = readSecret('DATABASE_URL', env);
  const evmRpcUrls = readEvmRpcUrls(env, config);
  // Solana through SOLANA_RPC_URL, which may carry a key in its path. Only its host is logged.
  const solanaRpc = readSolanaRpc(env, config);

  // The settlement follow-up repeats settles through the enabled facilitators, with the CDP key each one's auth names.
  // A key that isn't set stops the start: that's the config, not an outage.
  let facilitators = createFacilitators({
    config,
    cdpApiKey: auth => ({ id: readSecret(auth.apiKeyId, env), secret: readSecret(auth.apiKeySecret, env) }),
    facilitatorApiKey: auth => readSecret(auth.apiKey, env),
    clock: systemClock,
  });
  // Hold expiry and routing losses need neither the facilitators nor the Tempo node, so an outage at
  // startup only leaves the follow-up without the one that failed: it counts those payments undecided.
  facilitators = await checkEachFacilitator({ config, facilitators, logger });
  // While MPP is on, the follow-up reads receipts on the Tempo node, which must answer with mpp.network's chain ID
  let mppCheck: MppSettlementCheck | undefined;
  if (config.mpp.enabled) {
    const rpc = createTempoRpc({ network: config.mpp.network, url: config.mpp.rpcUrl });
    try {
      await rpc.check(startupCheckTimeoutMs);
      mppCheck = createMppSettlementCheck({ rpc, timeoutMs: config.timeouts.connectMs, clock: systemClock });
    }
    catch (error) {
      logger.warn({ error, network: config.mpp.network.id },
        'The Tempo node failed its startup check: the settlement follow-up runs without it until a restart');
    }
  }

  if (solanaRpc?.public)
    logger.warn({ host: solanaRpc.host }, 'SOLANA_RPC_URL is not set: the treasury reads Solana through its public RPC, which is rate limited');
  // NEAR: the treasury's balances and the follow-up's height, through the RPCs of the config's one NEAR network
  const nearNetworks = [...new Set(config.assets.filter(asset => asset.network.namespace === 'near').map(asset => asset.network.id))];
  const nearRpcUrls = nearNetworks.length === 1 ? readNearRpcUrls(env, nearNetworks[0]!) : [];
  if (nearNetworks.length > 1)
    logger.warn({ networks: nearNetworks }, 'The platform config has NEAR assets on several networks: the workers read none of them, and no NEAR refusal is final');
  const near: NearBalanceReader | undefined = nearRpcUrls.length > 0 ? createNearBalanceReader({ rpcUrls: nearRpcUrls, logger, timeoutMs: balanceReadTimeoutMs }) : undefined;
  const balanceReaders = {
    evm: createEvmBalanceReader({ rpcUrlFor: network => evmRpcUrls.get(network), timeoutMs: balanceReadTimeoutMs }),
    ...solanaRpc ? { solana: createSolanaBalanceReader({ rpcUrl: solanaRpc.url, timeoutMs: balanceReadTimeoutMs }) } : {},
    ...near ? { near } : {},
  };

  const postgres = createPostgres({ url: databaseUrl, logger });
  const server = createApp({
    config, logger, postgres, facilitators, balanceReaders, ...mppCheck ? { mppCheck } : {}, ...near ? { nearHeight: () => near.height() } : {},
  });
  let port;
  try {
    port = await server.listen(listen);
  }
  catch (error) {
    await postgres.close();
    throw error;
  }
  // Once, what this replica runs. Network names and the Solana and NEAR RPCs' hosts only: an RPC URL can carry a key.
  logger.info({
    app: 'workers',
    commit: readCommit(env) ?? null,
    logLevel: logger.level,
    ...platformSummary(config),
    jobs: server.jobs,
    settlementFollowUp: { facilitators: facilitators.map(facilitator => facilitator.name), mpp: mppCheck !== undefined },
    treasuryReaders: { evm: [...evmRpcUrls.keys()], solana: solanaRpc?.host ?? null, near: nearRpcUrls.length > 0 ? nearRpcUrls.map(hostOf) : null },
    ports: { metricsPort: port },
  }, 'Started');

  return {
    close: async () => {
      await server.close();
      await postgres.close();
    },
  };
};
