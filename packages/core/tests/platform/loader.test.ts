import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DocumentError, ValidationError } from '@anyfare/common';

import { ConfigLoadError, loadPlatformConfig, loadPlatformConfigDocument } from '../../src/index.js';
import { examplePlatformConfigPath } from '../fixtures.js';

let directory: string;
let example: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'anyfare-platform-config-'));
  example = await readFile(examplePlatformConfigPath, 'utf8');
  await writeFile(path.join(directory, 'base.yaml'), example);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const load = (env: Record<string, string>) => loadPlatformConfig({ env, cwd: directory });
const base64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  }
  catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
};

describe('loadPlatformConfig', () => {
  it('loads the example config from CONFIG_PATH', async () => {
    const config = await loadPlatformConfig({ env: { CONFIG_PATH: examplePlatformConfigPath.pathname } });

    expect(config.environment).toBe('staging');
    expect(config.keyPrefixes).toEqual({ master: 'afm_test_', payment: 'af_test_' });
    expect(config.rateLimits.signup).toEqual({ requests: 10, windowSeconds: 3600 });
    expect(config.facilitators.map(facilitator => [facilitator.name, facilitator.url, facilitator.enabled])).toEqual([
      ['cdp', 'https://api.cdp.coinbase.com/platform/v2/x402', true],
      ['near', 'http://127.0.0.1:8084', true],
    ]);
    expect(config.mpp).toMatchObject({ network: { id: 'eip155:42431' }, recipient: '0x2222222222222222222222222222222222222222', enabled: true, rpcUrl: undefined });
    expect(config.sizeLimits).toEqual({ requestBodyBytes: 1_048_576, bufferedResponseBytes: 10_485_760 });
    expect(config.signer.maxPerCall).toBe(1_000_000n);
    expect(config.signer.maxPerNetworkPerDay).toBe(100_000_000n);
  });

  it('merges files left to right, then CONFIG; lists replace and objects merge', async () => {
    await writeFile(path.join(directory, 'override.json'), JSON.stringify({ logger: { level: 'debug' }, rateLimits: { signup: { requests: 3 } } }));
    const config = await load({ CONFIG_PATH: 'base.yaml, override.json', CONFIG: base64('rateLimits:\n  unpaidIp: { requests: 5, windowSeconds: 1 }\ntimeouts:\n  connectMs: 1000\nassets:\n  - { name: base-usdc, network: "eip155:84532", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, peg: usd }\n'
      + '  - { name: near-usdc, network: "near:testnet", address: 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af, decimals: 6, peg: usd }\n') });

    expect(config.logger.level).toBe('debug');
    expect(config.rateLimits.signup).toEqual({ requests: 3, windowSeconds: 3600 });
    expect(config.timeouts.connectMs).toBe(1000);
    expect(config.rateLimits.unpaidIp).toEqual({ requests: 5, windowSeconds: 1 });
    expect(config.rateLimits.paymentKey).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.assets.map(asset => asset.name)).toEqual(['base-usdc', 'near-usdc']);
  });

  it('takes the whole config from CONFIG alone', async () => {
    expect((await load({ CONFIG: base64(example) })).version).toBe(1);
  });

  it.each(['false', '0', ' FALSE '])('reads plain CONFIG when CONFIG_DECODE is %s', async flag => {
    expect((await load({ CONFIG_PATH: 'base.yaml', CONFIG: '{"logger": {"level": "warn"}}', CONFIG_DECODE: flag })).logger.level).toBe('warn');
  });

  it('separates loading the document from building the runtime config', async () => {
    const document = await loadPlatformConfigDocument({ env: { CONFIG_PATH: 'base.yaml' }, cwd: directory });

    // As written: amounts stay strings, defaults aren't applied
    expect(document.paymentKeyDefaults?.dailyBudget).toBe('5');
    expect(document.ownHosts).toEqual([]);
    expect(document.assets[0]).not.toHaveProperty('minPrice');
  });

  it.each([
    ['no sources', {}],
    ['an empty CONFIG', { CONFIG: '  ' }],
    ['an empty CONFIG_PATH', { CONFIG_PATH: '' }],
    ['a trailing comma', { CONFIG_PATH: 'base.yaml,' }],
    ['an invalid CONFIG_DECODE', { CONFIG: 'e30=', CONFIG_DECODE: 'maybe' }],
    ['non-canonical base64', { CONFIG: 'e30' }],
    ['base64 with whitespace', { CONFIG: 'e30=\n' }],
    ['a missing file', { CONFIG_PATH: 'missing.yaml' }],
    ['a directory', { CONFIG_PATH: '.' }],
  ])('rejects %s, so the app doesn\'t start', async (_name, env) => {
    expect(await rejection(load(env))).toBeInstanceOf(ConfigLoadError);
  });

  it('rejects oversized files before reading them', async () => {
    await writeFile(path.join(directory, 'large.yaml'), 'x'.repeat(1024 * 1024 + 1));
    const error = await rejection(load({ CONFIG_PATH: 'large.yaml' }));

    expect(error).toBeInstanceOf(ConfigLoadError);
    expect((error as ConfigLoadError).cause).toMatchObject({ message: 'the file exceeds the 1048576-byte size limit' });
  });

  it('reports syntax errors with the file, line, and column', async () => {
    await writeFile(path.join(directory, 'broken.yaml'), 'logger: 1\nlogger: 2\n');
    const error = await rejection(load({ CONFIG_PATH: 'base.yaml,broken.yaml' }));

    expect(error).toBeInstanceOf(DocumentError);
    expect(error).toMatchObject({ source: 'broken.yaml', line: 2, column: 1, reason: 'duplicate key' });
  });

  it('rejects invalid UTF-8 and invalid inline YAML', async () => {
    await writeFile(path.join(directory, 'binary.yaml'), Buffer.from([0xff, 0xfe]));

    expect(await rejection(load({ CONFIG_PATH: 'binary.yaml' }))).toMatchObject({ reason: 'it is not valid UTF-8' });
    expect(await rejection(load({ CONFIG: base64([1, 2]) }))).toMatchObject({ source: 'CONFIG', reason: 'the root must be a mapping' });
  });

  it('attributes schema errors to the file that set the value', async () => {
    await writeFile(path.join(directory, 'bad-limit.yaml'), '# Overrides\ntimeouts:\n  connectMs: soon\n');
    const error = await rejection(load({ CONFIG_PATH: 'base.yaml,bad-limit.yaml' }));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues).toEqual([
      { path: '/timeouts/connectMs', message: 'must be an integer', source: 'bad-limit.yaml', line: 3, column: 14 },
    ]);
  });

  it('reports every cross-field problem at once, with positions', async () => {
    const broken = example
      .replace('master: afm_test_', 'master: af_test_')
      .replace('network: eip155:42431', 'network: eip155:4217');
    const error = await rejection(load({ CONFIG: base64(broken) }));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues.map(issue => [issue.path, issue.source])).toEqual([
      ['/keyPrefixes/payment', 'CONFIG'],
      // A mainnet in staging, and a Tempo network other than mpp.network
      ['/assets/2/network', 'CONFIG'],
      ['/assets/2/network', 'CONFIG'],
    ]);
    expect((error as ValidationError).issues.every(issue => issue.line !== undefined)).toBe(true);
  });

  it('refuses a section that does not exist', async () => {
    const withExtra = loadPlatformConfig({
      env: { CONFIG_PATH: examplePlatformConfigPath.pathname, CONFIG: base64({ extra: { asset: 'base-usdc' } }) },
    });

    await expect(withExtra).rejects.toThrow('Invalid platform config');
  });
});
