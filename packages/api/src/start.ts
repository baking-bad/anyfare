import {
  readCommit, readHost, readLogLevel, readPort, readSecret, type AppContext, type RunningApp,
} from '@anyfare/common';
import { loadPlatformConfig, platformSummary } from '@anyfare/core';
import { createPostgres, createRedis } from '@anyfare/db';

import { createApp } from './app.js';

export const defaultPort = 8081;
export const defaultMetricsPort = 9081;

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startApi = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  // The proxies in front, such as Traefik, as addresses or CIDR ranges, comma-separated, so per-IP limits see the client IP
  const trustProxy = env['TRUST_PROXY']?.trim() || undefined;
  const databaseUrl = readSecret('DATABASE_URL', env);
  const redisUrl = readSecret('REDIS_URL', env);

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({ config, logger, postgres, redis, trustProxy });
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
