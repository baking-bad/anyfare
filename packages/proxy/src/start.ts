import {
  readCommit, readHost, readLogLevel, readPort, readSecret, systemClock, type AppContext, type RunningApp,
} from '@anyfare/common';
import { loadPlatformConfig, platformSummary } from '@anyfare/core';
import { createPostgres, createRedis, createRedisReplayStore } from '@anyfare/db';
import { createFacilitators, initializeMpp, initializeX402, type MppSetup } from '@anyfare/payments';

import { createApp } from './app.js';
import { readMppSecretKey } from './payments/mpp.js';
import { createSignerClient } from './routing/support.js';

export const defaultPort = 8080;
export const defaultMetricsPort = 9080;
// How long the facilitators get to answer /supported at startup, and the Tempo RPC its chain ID
export const startupCheckTimeoutMs = 10_000;

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startProxy = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const databaseUrl = readSecret('DATABASE_URL', env);
  const redisUrl = readSecret('REDIS_URL', env);
  // The Signer and the internal API, on the internal network. Without the Signer, routed calls answer
  // 503 and nobody pays.
  const signerUrl = env['SIGNER_URL']?.trim();
  const signer = signerUrl
    ? createSignerClient({ url: signerUrl, secret: readSecret('SIGNER_SECRET', env), timeoutMs: config.timeouts.connectMs })
    : undefined;
  const internalApiUrl = env['INTERNAL_API_URL']?.trim();
  const internalApi = internalApiUrl ? { url: internalApiUrl, secret: readSecret('INTERNAL_API_SECRET', env) } : undefined;
  if (!signer)
    logger.warn('Payment routing pays no targets: SIGNER_URL is not set');
  // Traefik's addresses or CIDR ranges, comma-separated, so the unpaid limit sees the client IP
  const trustProxy = env['TRUST_PROXY']?.trim() || undefined;
  // MPP is offered to buyers only when it is on and has a recipient. Its key is read only then.
  const offersMpp = config.mpp.enabled && config.mpp.recipient !== undefined;
  const mppSecretKey = offersMpp ? readMppSecretKey(env) : undefined;
  if (!offersMpp)
    logger.warn({ reason: config.mpp.enabled ? 'no_recipient' : 'disabled' }, 'MPP isn\'t offered to buyers: mpp.enabled is false or mpp.recipient is not set');
  // Every enabled facilitator answers /supported, or the proxy doesn't start
  const x402 = config.facilitators.some(facilitator => facilitator.enabled)
    ? await initializeX402({
      config,
      facilitators: createFacilitators({
        config,
        // The CDP API key, by the names platform config gives
        cdpApiKey: auth => ({ id: readSecret(auth.apiKeyId, env), secret: readSecret(auth.apiKeySecret, env) }),
        clock: systemClock,
      }),
      timeoutMs: startupCheckTimeoutMs,
    })
    : undefined;

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  // One-time claims of x402 payments and MPP credentials, shared by every replica
  const replayStore = createRedisReplayStore({ redis });
  const closeConnections = async () => {
    await replayStore.close();
    await Promise.all([postgres.close(), redis.close()]);
  };
  // The Tempo RPC answers with mpp.network's chain ID, or the proxy doesn't start
  let mpp: MppSetup | undefined;
  try {
    if (mppSecretKey)
      mpp = await initializeMpp({ config, secretKey: mppSecretKey, store: replayStore, timeoutMs: startupCheckTimeoutMs });
  }
  catch (error) {
    await closeConnections();
    throw error;
  }
  const server = createApp({
    config, logger, postgres, redis, trustProxy, x402, mpp, claims: replayStore, ...signer ? { signer } : {}, ...internalApi ? { internalApi } : {},
  });
  let ports;
  try {
    ports = await server.listen(listen);
  }
  catch (error) {
    await closeConnections();
    throw error;
  }
  // What this replica runs with, once. Names, networks, and URLs: never a secret or a key.
  logger.info({
    app: 'proxy',
    commit: readCommit(env) ?? null,
    logLevel: logger.level,
    ...platformSummary(config),
    // The rails this replica serves: x402 and MPP need their facilitators and RPC at startup
    serving: { x402: x402 !== undefined, mpp: mpp !== undefined },
    routing: { signer: signer !== undefined, internalApi: internalApi !== undefined },
    ports,
  }, 'Started');

  // Drains in-flight requests before closing the pools
  return {
    close: async () => {
      await server.close();
      await closeConnections();
    },
  };
};
