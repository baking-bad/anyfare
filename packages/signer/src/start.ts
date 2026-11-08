import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from '@solana/kit';
import { privateKeyToAccount } from 'viem/accounts';

import {
  formatUsd, InvalidEnvironmentError, readCommit, readHost, readLogLevel, readPort, readSecret, Secret, type AppContext, type AppEnvironment, type Logger,
  type RunningApp,
} from '@anyfare/common';
import {
  isValidAddress, loadPlatformConfig, nearNetworkOf, platformSummary, readNearRpc, readSolanaRpc, type NearRpc, type NetworkInfo, type PlatformConfig,
} from '@anyfare/core';
import { createPostgres, createRedis } from '@anyfare/db';

import { createApp } from './app.js';
import { nearPublicKeyOf, readNearAccessKey, type NearAccessKey } from './near.js';

export const defaultPort = 8083;
export const defaultMetricsPort = 9083;
// Long enough that guessing it over the network is hopeless
export const minimumSignerSecretLength = 32;

const readSignerSecret = (env: AppEnvironment): Secret => {
  const secret = readSecret('SIGNER_SECRET', env);
  if (secret.expose().length < minimumSignerSecretLength) {
    secret.destroy();
    throw new InvalidEnvironmentError(`SIGNER_SECRET must be at least ${minimumSignerSecretLength} characters`);
  }

  return secret;
};

/**
 * A wallet key, taken out of the environment as it's read, so nothing that reads the environment
 * later, such as a child process or a crash report, finds it. Undefined when it isn't set.
 */
const takeKey = (env: AppEnvironment, name: string): Secret | undefined => {
  try {
    return env[name]?.trim() ? readSecret(name, env) : undefined;
  }
  finally {
    delete (env as Record<string, string | undefined>)[name];
  }
};

/**
 * A hot wallet's private key, `0x` and 64 hex characters: SIGNER_BASE_KEY for Base, SIGNER_TEMPO_KEY for
 * Tempo. Optional: without it, nothing is paid on that chain. One key may serve both: the address is the
 * same on each.
 */
export const readWallet = (env: AppEnvironment, name: 'SIGNER_BASE_KEY' | 'SIGNER_TEMPO_KEY') => {
  const key = takeKey(env, name);
  if (!key)
    return undefined;
  try {
    const value = key.expose().trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(value))
      throw new InvalidEnvironmentError(`${name} must be 0x and 64 hex characters`);

    return privateKeyToAccount(value as `0x${string}`);
  }
  finally {
    key.destroy();
  }
};

// A Solana secret key: 32 bytes of seed, then the 32 bytes of its public key
const solanaKeyLength = 64;

/** The 64 bytes of SIGNER_SOLANA_KEY: base58, as Phantom and Solflare export it, or a JSON array of numbers, as `solana-keygen` writes it. */
const solanaKeyBytes = (value: string): Uint8Array | undefined => {
  try {
    if (value.startsWith('[')) {
      const numbers = JSON.parse(value) as unknown;

      return Array.isArray(numbers) && numbers.every((item: unknown) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)
        ? Uint8Array.from(numbers as number[])
        : undefined;
    }

    // A copy, and the decoder's own bytes zeroed
    const decoded = getBase58Encoder().encode(value) as Uint8Array;
    try {
      return Uint8Array.from(decoded);
    }
    finally {
      decoded.fill(0);
    }
  }
  catch {
    return undefined;
  }
};

/**
 * The Solana hot wallet, from SIGNER_SOLANA_KEY. Optional: without it, nothing is paid on Solana. Its
 * address must be `signer.wallets.solana` when that's set, or the balance monitor watches another
 * wallet. Neither the key nor its bytes reach an error.
 */
export const readSolanaWallet = async (env: AppEnvironment, config: Pick<PlatformConfig, 'signer'>): Promise<KeyPairSigner | undefined> => {
  const key = takeKey(env, 'SIGNER_SOLANA_KEY');
  if (!key)
    return undefined;
  const bytes = solanaKeyBytes(key.expose().trim());
  key.destroy();
  if (bytes?.length !== solanaKeyLength) {
    bytes?.fill(0);
    throw new InvalidEnvironmentError('SIGNER_SOLANA_KEY must be a 64-byte Solana secret key: base58, or a JSON array of 64 numbers');
  }
  let wallet: KeyPairSigner;
  try {
    wallet = await createKeyPairSignerFromBytes(bytes);
  }
  catch {
    throw new InvalidEnvironmentError('SIGNER_SOLANA_KEY is not a valid Solana key pair: its last 32 bytes must be the public key of its first 32');
  }
  finally {
    bytes.fill(0);
  }
  const configured = config.signer.wallets.solana;
  if (configured !== undefined && configured !== wallet.address)
    throw new InvalidEnvironmentError(`SIGNER_SOLANA_KEY's address, ${wallet.address}, isn't signer.wallets.solana, ${configured}`);

  return wallet;
};

// A NEAR KeyPairString: `ed25519:` and base58
const nearKeyPattern = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,128}$/;

/** The NEAR hot wallet from the environment: its account, its key, the key's public key, and its network. */
export interface NearWalletSetup {
  readonly accountId: string;
  readonly secretKey: Secret;
  readonly publicKey: string;
  readonly network: NetworkInfo;
}

/**
 * The NEAR hot wallet: SIGNER_NEAR_ACCOUNT, and its full-access key from SIGNER_NEAR_KEY, `ed25519:` and
 * base58. Both or neither: without them, nothing is paid on NEAR. Its network is the platform config's
 * NEAR network, and its account must be `signer.wallets.near` when that's set, or the balance monitor
 * watches another wallet. The key is taken out of the environment as it's read, and no error echoes it.
 */
export const readNearWallet = (env: AppEnvironment, config: Pick<PlatformConfig, 'assets' | 'signer'>): NearWalletSetup | undefined => {
  const key = takeKey(env, 'SIGNER_NEAR_KEY');
  const accountId = env['SIGNER_NEAR_ACCOUNT']?.trim() ?? '';
  try {
    if (!key && accountId === '')
      return undefined;
    if (!key || accountId === '')
      throw new InvalidEnvironmentError('SIGNER_NEAR_ACCOUNT and SIGNER_NEAR_KEY must be set together, or not at all');
    const network = nearNetworkOf(config);
    if (!network)
      throw new InvalidEnvironmentError('SIGNER_NEAR_KEY is set, but the platform config has no NEAR asset to pay in');
    if (!isValidAddress(network, accountId))
      throw new InvalidEnvironmentError('SIGNER_NEAR_ACCOUNT must be a NEAR account ID');
    const configured = config.signer.wallets.near;
    if (configured !== undefined && configured !== accountId)
      throw new InvalidEnvironmentError(`SIGNER_NEAR_ACCOUNT, ${accountId}, isn't signer.wallets.near, ${configured}`);
    let secretKey: Secret | undefined;
    try {
      const value = key.expose().trim();
      if (!nearKeyPattern.test(value))
        throw new Error('not a NEAR key');
      secretKey = Secret.from(value);

      return { accountId, secretKey, publicKey: nearPublicKeyOf(secretKey), network };
    }
    catch {
      secretKey?.destroy();
      throw new InvalidEnvironmentError('SIGNER_NEAR_KEY must be ed25519: and a base58 key');
    }
  }
  finally {
    key?.destroy();
  }
};

/**
 * The NEAR hot wallet, once, before the Signer listens: its key is a full-access key of its account.
 * Otherwise it doesn't start. When the RPC doesn't answer, it warns and starts: a NEAR RPC outage
 * mustn't stop Base, Solana, and Tempo payments. No message carries the key or the RPC's URL.
 */
export const checkNearWallet = async ({ wallet, rpc, budgetMs, logger }: {
  readonly wallet: NearWalletSetup;
  readonly rpc: NearRpc;
  // How long the check may take, retry included
  readonly budgetMs: number;
  readonly logger: Logger;
}): Promise<void> => {
  const { accountId, publicKey, network } = wallet;
  let accessKey: NearAccessKey;
  try {
    accessKey = await readNearAccessKey({ rpcUrl: rpc.url, accountId, publicKey, budgetMs });
  }
  catch {
    logger.warn({ host: rpc.host }, 'The NEAR RPC didn\'t answer at startup: NEAR payments will be tried, and fail while it is down');

    return;
  }
  if (accessKey.kind === 'no_account')
    throw new InvalidEnvironmentError(`SIGNER_NEAR_ACCOUNT, ${accountId}, doesn't exist on ${network.id}`);
  if (accessKey.kind === 'no_key')
    throw new InvalidEnvironmentError(`SIGNER_NEAR_KEY isn't an access key of ${accountId} on ${network.id}`);
  if (accessKey.permission !== 'FullAccess')
    throw new InvalidEnvironmentError(`SIGNER_NEAR_KEY isn't a full-access key of ${accountId} on ${network.id}`);
};

/**
 * Wires the production dependencies from platform config and the environment, then listens. The hot
 * wallets' keys come from the stack's secrets. The spend counters use the Signer's own Redis ACL user,
 * from REDIS_URL.
 */
export const startSigner = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const secret = readSignerSecret(env);
  const base = readWallet(env, 'SIGNER_BASE_KEY');
  const tempo = readWallet(env, 'SIGNER_TEMPO_KEY');
  const solana = await readSolanaWallet(env, config);
  const near = readNearWallet(env, config);
  if (!base && !tempo && !solana && !near)
    logger.warn('The Signer has no wallet: SIGNER_BASE_KEY, SIGNER_TEMPO_KEY, SIGNER_SOLANA_KEY, and SIGNER_NEAR_KEY are not set, so routed payments are refused');
  // Solana targets: SOLANA_RPC_URL, which may carry a key in its path. Only its host is logged.
  const solanaRpc = solana ? readSolanaRpc(env, config) : undefined;
  if (solanaRpc?.public)
    logger.warn({ host: solanaRpc.host }, 'SOLANA_RPC_URL is not set: the Signer builds Solana payments through the public RPC, which is rate limited');
  // NEAR targets: NEAR_RPC_URLS's item for the network, which may carry a key. Only its host is logged.
  const nearRpc = near ? readNearRpc(env, config) : undefined;
  if (near && nearRpc) {
    if (nearRpc.public)
      logger.warn({ host: nearRpc.host }, `NEAR_RPC_URLS names no RPC for ${near.network.id}: the Signer builds NEAR payments through the x402 SDK's public RPC, which is rate limited`);
    await checkNearWallet({ wallet: near, rpc: nearRpc, budgetMs: config.timeouts.connectMs, logger });
  }
  const databaseUrl = readSecret('DATABASE_URL', env);
  const redisUrl = readSecret('REDIS_URL', env);

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({
    config, logger, postgres, redis, secret,
    wallets: {
      ...base ? { base } : {}, ...tempo ? { tempo } : {}, ...solana ? { solana } : {},
      ...near && nearRpc ? { near: { accountId: near.accountId, secretKey: near.secretKey, rpcUrl: nearRpc.url } } : {},
    },
    ...solanaRpc ? { solanaRpcUrl: solanaRpc.url } : {},
  });
  let ports;
  try {
    ports = await server.listen(listen);
  }
  catch (error) {
    await closeConnections();
    throw error;
  }
  // Once, what this Signer pays with. The wallets' public addresses, never their keys, and the RPCs' hosts only.
  const { signer } = config;
  logger.info({
    app: 'signer',
    commit: readCommit(env) ?? null,
    logLevel: logger.level,
    environment: platformSummary(config).environment,
    wallets: { base: base?.address ?? null, tempo: tempo?.address ?? null, solana: solana?.address ?? null, near: near?.accountId ?? null },
    solanaRpc: solanaRpc?.host ?? null,
    nearRpc: nearRpc?.host ?? null,
    limits: {
      maxPerCall: formatUsd(signer.maxPerCall),
      maxPerNetworkPerHour: signer.maxPerNetworkPerHour === undefined ? null : formatUsd(signer.maxPerNetworkPerHour),
      maxPerNetworkPerDay: formatUsd(signer.maxPerNetworkPerDay),
    },
    ports,
  }, 'Started');

  return {
    close: async () => {
      await server.close();
      await closeConnections();
    },
  };
};
