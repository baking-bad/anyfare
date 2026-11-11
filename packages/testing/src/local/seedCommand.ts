import { createLogger, Secret } from '@anyfare/common';
import { loadPlatformConfig } from '@anyfare/core';
import { createPostgres, migrateDatabase } from '@anyfare/db';

import { loadLocalConfig } from './config.js';
import { assertLocalDatabase, assertNotProduction } from './guard.js';
import { createScratchDatabase, dropScratchDatabase, isScratchName, urlOfDatabase } from './scratch.js';
import { emptyLocal, seedLocal, type SeedSummary } from './seed.js';

export const seedUsage = 'Usage: npm run seed:local [-- --empty] [-- --checked-only] [-- --scratch | --scratch-name <name>]\n'
  + '  (no option)          fills the local database with about 2,000 calls, accounts, top-ups and services, and a few services a check listed, then counts the public numbers\n'
  + '  --empty              removes the rows the seed wrote, and counts the public numbers again; rows made any other way stay\n'
  + '  --checked-only       seeds only the services a check listed: no call, account or top-up\n'
  + '  --scratch            makes a new empty database next to the local one, seeds it, prints its name and leaves it\n'
  + '  --scratch-name <n>   seeds the scratch database a running stack printed (npm run stack:local -- --scratch)\n'
  + '  --drop-scratch <n>   drops the scratch database of that name, and no other';

export interface SeedCommandOptions {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
}

export interface SeedCommandResult {
  readonly mode: 'seed' | 'empty' | 'drop';
  readonly summary: SeedSummary | undefined;
  // The scratch database the run used, or dropped
  readonly scratchDatabase: string | undefined;
}

interface ParsedArguments {
  readonly empty: boolean;
  readonly checkedOnly: boolean;
  readonly scratch: boolean;
  readonly scratchName: string | undefined;
  readonly dropScratch: string | undefined;
}

const parseArguments = (args: readonly string[]): ParsedArguments => {
  const flags = new Set<string>();
  const named: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--empty' || argument === '--checked-only' || argument === '--scratch')
      flags.add(argument);
    else if (argument === '--scratch-name' || argument === '--drop-scratch') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`${argument} needs a database name`);
      named[argument] = value;
      index += 1;
    }
    else
      throw new Error(`Unknown option ${argument}`);
  }
  const parsed: ParsedArguments = {
    empty: flags.has('--empty'), checkedOnly: flags.has('--checked-only'), scratch: flags.has('--scratch'),
    scratchName: named['--scratch-name'], dropScratch: named['--drop-scratch'],
  };
  if (parsed.scratch && parsed.scratchName !== undefined)
    throw new Error('--scratch and --scratch-name are not used together');
  if (parsed.empty && parsed.checkedOnly)
    throw new Error('--empty and --checked-only are not used together');
  if (parsed.empty && parsed.scratch)
    throw new Error('--empty on a new scratch database has nothing to remove');
  if (parsed.dropScratch !== undefined && (parsed.empty || parsed.checkedOnly || parsed.scratch || parsed.scratchName !== undefined))
    throw new Error('--drop-scratch is used alone');
  if (parsed.scratchName !== undefined && !isScratchName(parsed.scratchName))
    throw new Error(`${parsed.scratchName} is not the name of a scratch database`);

  return parsed;
};

/**
 * `npm run seed:local`. Refuses before it opens anything when the database isn't on this machine or
 * the platform config is production. It never removes a row the seed did not write.
 */
export const runSeedCommand = async ({ args, env, log }: SeedCommandOptions): Promise<SeedCommandResult> => {
  const parsed = parseArguments(args);

  const databaseUrl = env['DATABASE_URL'];
  assertLocalDatabase(databaseUrl);
  // The declared environment first: the local overrides are never merged over a production config
  assertNotProduction(await loadPlatformConfig({ env: { CONFIG_PATH: env['CONFIG_PATH']?.trim() || 'config/example.yaml' } }), env);
  if (parsed.dropScratch !== undefined) {
    await dropScratchDatabase(databaseUrl!, parsed.dropScratch);
    log(`Dropped the scratch database ${parsed.dropScratch}`);

    return { mode: 'drop', summary: undefined, scratchDatabase: parsed.dropScratch };
  }
  const config = await loadLocalConfig({}, env);

  const logger = createLogger({ level: 'silent' });
  let scratchDatabase = parsed.scratchName;
  let url = Secret.from(databaseUrl!);
  if (parsed.scratch) {
    log('Making a scratch database');
    const scratch = await createScratchDatabase(databaseUrl!);
    scratchDatabase = scratch.name;
    url = scratch.url;
  }
  else if (parsed.scratchName !== undefined)
    url = urlOfDatabase(databaseUrl!, parsed.scratchName);
  await migrateDatabase({ url, logger });
  const postgres = createPostgres({ url, logger });
  try {
    if (parsed.empty) {
      log('Removing the rows the seed wrote');
      await emptyLocal({ postgres, config });

      return { mode: 'empty', summary: undefined, scratchDatabase };
    }

    return { mode: 'seed', summary: await seedLocal({ postgres, config, log, checkedOnly: parsed.checkedOnly }), scratchDatabase };
  }
  finally {
    await postgres.close();
  }
};

export const describeSummary = (summary: SeedSummary): string => summary.calls === 0 && summary.accounts === 0 ? [
  `${summary.checkedServices} services with ${summary.checkedEndpoints} endpoints that only a check listed, and no call`,
].join('\n') : [
  `${summary.calls} calls (${summary.freeCalls} free) to ${summary.services} services and ${summary.endpoints} endpoints`,
  ...Object.entries(summary.callsByWay).map(([way, calls]) => `  ${way}: ${calls}`),
  `${summary.checkedServices} more services with only checked endpoints, and 2 checked endpoints on a paid one (${summary.checkedEndpoints} checked in all)`,
  `${summary.accounts} Credits accounts and ${summary.topups} top-ups`,
  'A master key and a payment key of the first account, made up and good only against this database:',
  `  ${summary.masterKey}`,
  `  ${summary.paymentKey}`,
].join('\n');
