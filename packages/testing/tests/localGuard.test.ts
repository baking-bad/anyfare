import { describe, expect, it } from 'vitest';

import { assertLocalDatabase, assertNotProduction, LocalOnlyError } from '../src/local/guard.js';
import { runSeedCommand } from '../src/local/seedCommand.js';
import { startLocalStack } from '../src/local/stack.js';

// The local tools refuse a database that isn't this machine's, and a production platform config, before they open anything

const local = 'postgres://anyfare:secret-password@localhost:5433/anyfare';
const remote = 'postgres://anyfare:secret-password@db.internal.example.com:5432/anyfare';
const redis = 'redis://:secret-password@localhost:6380';
const log = (): void => undefined;

describe('assertLocalDatabase', () => {
  it.each([[local], ['postgres://u:p@127.0.0.1:5432/db'], ['postgres://u:p@LOCALHOST/db']])('accepts %s', url => {
    expect(() => assertLocalDatabase(url)).not.toThrow();
  });

  it.each([
    [remote],
    ['postgres://u:p@10.0.0.4:5432/db'],
    ['postgres://u:p@localhost.example.com/db'],
    ['postgres://u:p@[::1]:5432/db'],
    ['not a url'],
    [''],
    [undefined],
  ])('refuses %s', url => {
    expect(() => assertLocalDatabase(url)).toThrow(LocalOnlyError);
  });

  it('never repeats the URL, which carries a password', () => {
    expect(() => assertLocalDatabase(remote)).toThrow(/db\.internal\.example\.com/);
    expect(() => assertLocalDatabase(remote)).not.toThrow(/secret-password/);
  });
});

describe('assertNotProduction', () => {
  it('refuses a production platform config, and NODE_ENV=production', () => {
    expect(() => assertNotProduction({ environment: 'production' }, {})).toThrow(LocalOnlyError);
    expect(() => assertNotProduction({ environment: 'staging' }, { NODE_ENV: 'production' })).toThrow(LocalOnlyError);
    expect(() => assertNotProduction({ environment: 'staging' }, {})).not.toThrow();
  });
});

describe('npm run seed:local', () => {
  it.each([[[]], [['--empty']]])('refuses a database that is not on this machine (%j)', async args => {
    await expect(runSeedCommand({ args, env: { DATABASE_URL: remote }, log })).rejects.toThrow(LocalOnlyError);
  });

  it.each([[[]], [['--empty']]])('refuses a production platform config, on a local database (%j)', async args => {
    await expect(runSeedCommand({ args, env: { DATABASE_URL: local, CONFIG_PATH: 'config/production.yaml' }, log })).rejects.toThrow(/environment is production/);
  });

  it('refuses without a database URL, and an option it does not know', async () => {
    await expect(runSeedCommand({ args: [], env: {}, log })).rejects.toThrow(LocalOnlyError);
    await expect(runSeedCommand({ args: ['--wipe'], env: { DATABASE_URL: local }, log })).rejects.toThrow(/Unknown option --wipe/);
  });
});

describe('npm run stack:local', () => {
  it('refuses a database that is not on this machine, and a production platform config', async () => {
    await expect(startLocalStack({ databaseUrl: remote, redisUrl: redis, env: {} })).rejects.toThrow(LocalOnlyError);
    await expect(startLocalStack({ databaseUrl: local, redisUrl: redis, configPath: 'config/production.yaml', env: {} })).rejects.toThrow(/environment is production/);
  });
});
