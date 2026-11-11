import { countPublicNumbers } from '../../../testing/src/local/seed.js';
import { createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '@anyfare/testing';
import { defaultStackPorts, startLocalStack, type LocalStack } from '../../../testing/src/local/stack.js';

import type { SiteSettings } from '../../src/config';

// The real API, pay host, workers and Signer on free ports, with fake paid APIs behind them, for the tests
// that run what an agent reads.

export interface RunningStack {
  readonly stack: LocalStack;
  // The hosts the agent files are built for: the stack's own
  readonly hosts: SiteSettings;
  // The fake paid API's link on Base, as a person writes it: no scheme
  readonly paidLink: string;
  // Runs the workers' count of the public numbers once, as their timer does a few minutes in
  countNumbers(): Promise<void>;
  stop(): Promise<void>;
}

const freePorts = Object.fromEntries(Object.keys(defaultStackPorts).map(name => [name, 0]));

export const startStack = async (): Promise<RunningStack> => {
  let database: TestDatabase | undefined;
  let redis: TestRedis | undefined;
  let stack: LocalStack | undefined;
  try {
    [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    stack = await startLocalStack({ databaseUrl: database.url.expose(), redisUrl: redis.url.expose(), redisPrefix: redis.prefix, ports: freePorts });
  }
  catch (error) {
    await stack?.close();
    await Promise.all([database?.drop(), redis?.cleanup()]);
    throw error;
  }
  const running = stack;

  return {
    stack: running,
    hosts: {
      siteUrl: running.urls.website, apiUrl: running.urls.api, payUrl: running.urls.pay, consoleUrl: 'http://localhost:3001',
      apiInternalUrl: running.urls.api, payInternalUrl: running.urls.pay,
    },
    paidLink: `${running.paidApiHost}/base`,
    countNumbers: () => countPublicNumbers({ postgres: database!.postgres, config: running.config }),
    stop: async () => {
      await running.close();
      await Promise.all([database?.drop(), redis?.cleanup()]);
    },
  };
};
