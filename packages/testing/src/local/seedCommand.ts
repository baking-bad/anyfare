import { createLogger, Secret } from '@anyfare/common';
import { loadPlatformConfig } from '@anyfare/core';
import { createPostgres, migrateDatabase } from '@anyfare/db';

import { loadLocalConfig } from './config.js';
import { assertLocalDatabase, assertNotProduction } from './guard.js';
import { emptyLocal, seedLocal, type SeedSummary } from './seed.js';

export const seedUsage = 'Usage: npm run seed:local [-- --empty]\n'
  + '  (no option)  fills the local database with about 2,000 calls, accounts, top-ups and services, then counts the public numbers\n'
  + '  --empty      removes the rows the seed wrote, and counts the public numbers again';

export interface SeedCommandOptions {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
}

export interface SeedCommandResult {
  readonly mode: 'seed' | 'empty';
  readonly summary: SeedSummary | undefined;
}

/**
 * `npm run seed:local`. Refuses before it opens anything when the database isn't on this machine or
 * the platform config is production.
 */
export const runSeedCommand = async ({ args, env, log }: SeedCommandOptions): Promise<SeedCommandResult> => {
  const unknown = args.filter(argument => argument !== '--empty');
  if (unknown.length > 0)
    throw new Error(`Unknown option ${unknown[0]}`);
  const empty = args.includes('--empty');

  const databaseUrl = env['DATABASE_URL'];
  assertLocalDatabase(databaseUrl);
  // The declared environment first: the local overrides are never merged over a production config
  assertNotProduction(await loadPlatformConfig({ env: { CONFIG_PATH: env['CONFIG_PATH']?.trim() || 'config/example.yaml' } }), env);
  const config = await loadLocalConfig({}, env);

  const logger = createLogger({ level: 'silent' });
  const url = Secret.from(databaseUrl!);
  await migrateDatabase({ url, logger });
  const postgres = createPostgres({ url, logger });
  try {
    if (empty) {
      log('Removing the rows the seed wrote');
      await emptyLocal({ postgres, config });

      return { mode: 'empty', summary: undefined };
    }

    return { mode: 'seed', summary: await seedLocal({ postgres, config, log }) };
  }
  finally {
    await postgres.close();
  }
};

export const describeSummary = (summary: SeedSummary): string => [
  `${summary.calls} calls (${summary.freeCalls} free) to ${summary.services} services and ${summary.endpoints} endpoints`,
  ...Object.entries(summary.callsByWay).map(([way, calls]) => `  ${way}: ${calls}`),
  `${summary.accounts} Credits accounts and ${summary.topups} top-ups`,
  'A master key and a payment key of the first account, made up and good only against this database:',
  `  ${summary.masterKey}`,
  `  ${summary.paymentKey}`,
].join('\n');
