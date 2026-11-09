import {
  readCommit, readHost, readLogLevel, readPort, readSecret, type AppContext, type RunningApp,
} from '@anyfare/common';
import { loadPlatformConfig, platformSummary } from '@anyfare/core';
import { createPostgres, createRedis } from '@anyfare/db';
import { createOneClickClient } from '@anyfare/topups';

import { createApp } from './app.js';
import { readInternalSecret } from './internal/secret.js';

export const defaultPort = 8081;
export const defaultMetricsPort = 9081;
// The internal API: no Traefik labels and no published port, so only the internal network reaches it
export const defaultInternalPort = 8082;

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startApi = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
    internalPort: readPort(env, 'INTERNAL_PORT', defaultInternalPort),
  };
  // The proxies in front, such as Traefik, as addresses or CIDR ranges, comma-separated, so per-IP limits see the client IP
  const trustProxy = env['TRUST_PROXY']?.trim() || undefined;
  const databaseUrl = readSecret('DATABASE_URL', env);
  const redisUrl = readSecret('REDIS_URL', env);
  // Missing or too short, the app stops here with the reason
  const internalSecret = readInternalSecret(env);
  const { topups } = config;
  const oneClick = createOneClickClient({
    url: topups.url,
    // Read only while top-ups are on, so a deployment that has them off needs no key. Missing, the app stops here.
    apiKey: topups.enabled && topups.apiKey !== undefined ? readSecret(topups.apiKey, env) : undefined,
    timeoutMs: topups.timeoutMs,
  });

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({ config, logger, postgres, redis, trustProxy, internalSecret, oneClick });
  let ports;
  try {
    ports = await server.listen(listen);
  }
  catch (error) {
    await closeConnections();
    throw error;
  }
  // Once, what this replica runs with. Names, networks, and URLs: never a secret or a key.
  logger.info({
    app: 'api',
    commit: readCommit(env) ?? null,
    logLevel: logger.level,
    ...platformSummary(config),
    ports,
  }, 'Started');

  return {
    close: async () => {
      await server.close();
      await closeConnections();
    },
  };
};
