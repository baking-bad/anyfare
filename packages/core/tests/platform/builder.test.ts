import { describe, expect, it } from 'vitest';

import { ValidationError } from '@anyfare/common';

import {
  assertValidPlatformConfigDocument, buildPlatformConfig, findAsset, platformDefaults, platformSummary,
  type PlatformConfigDocument,
} from '../../src/index.js';
import { loadExamplePlatformDocument, patch } from '../fixtures.js';

const document = (changes: unknown = {}): PlatformConfigDocument => {
  const value = patch(loadExamplePlatformDocument(), changes);
  assertValidPlatformConfigDocument(value);

  return value;
};

const issues = (build: () => unknown): readonly { readonly path: string; readonly message: string }[] => {
  try {
    build();
  }
  catch (error) {
    if (error instanceof ValidationError)
      return error.issues;
    throw error;
  }
  throw new Error('Expected a ValidationError');
};

const minimalOptionalFields = { logger: undefined, ownHosts: undefined, paymentKeyDefaults: undefined, timeouts: undefined };

describe('buildPlatformConfig', () => {
  it('builds the example config', () => {
    const config = buildPlatformConfig(document());

    expect(config.environment).toBe('staging');
    expect(config.assets.map(asset => asset.name)).toEqual(['base-usdc', 'solana-usdc', 'tempo-pathusd']);
    expect(findAsset(config, 'tempo-pathusd')).toMatchObject({
      network: { id: 'eip155:42431', chain: 'tempo', testnet: true }, address: '0x20c0000000000000000000000000000000000000', decimals: 6, minPrice: 0n,
    });
    expect(config.ownHosts).toEqual(['anyfare.test', 'api.anyfare.test', 'pay.anyfare.test']);
  });

  it('applies the documented defaults', () => {
    const config = buildPlatformConfig(document(minimalOptionalFields));

    expect(config.logger.level).toBe('info');
    expect(config.paymentKeyDefaults.dailyBudget).toBe(5_000_000n);
    expect(config.timeouts).toEqual(platformDefaults.timeouts);
    expect(findAsset(config, 'base-usdc')?.minPrice).toBe(0n);
  });

  it('merges partial overrides with defaults and normalizes own hosts', () => {
    const config = buildPlatformConfig(document({ timeouts: { connectMs: 1_000 }, ownHosts: ['Edge.Anyfare.test', '203.0.113.7'] }));

    expect(config.timeouts).toEqual({ connectMs: 1_000, requestMs: 30_000, settleMs: 30_000 });
    expect(config.ownHosts).toContain('edge.anyfare.test');
    expect(config.ownHosts).toContain('203.0.113.7');
  });

  it('is deeply frozen and doesn\'t change the document', () => {
    const source = document();
    const before = structuredClone(source);
    const config = buildPlatformConfig(source);

    expect(source).toEqual(before);
    expect(Object.isFrozen(config.assets[0]!.network)).toBe(true);
    expect(Object.isFrozen(config.rateLimits.signup)).toBe(true);
  });

  it('freezes every object in the built config, so it is read-only at runtime', () => {
    const config = buildPlatformConfig(document());
    const unfrozen = (value: unknown, path: string): readonly string[] => typeof value === 'object' && value !== null
      ? [...Object.isFrozen(value) ? [] : [path || '/'], ...Object.entries(value).flatMap(([key, nested]) => unfrozen(nested, `${path}/${key}`))]
      : [];

    expect(unfrozen(config, '')).toEqual([]);
    expect(() => Object.assign(config.urls, { api: 'https://evil.example.com' })).toThrow(TypeError);
    expect(() => (config.assets as unknown[]).push({})).toThrow(TypeError);
  });

  it.each([
    ['equal key prefixes', { keyPrefixes: { payment: 'afm_test_' } }, '/keyPrefixes/payment'],
    ['a key prefix that starts with the other', { keyPrefixes: { master: 'af_test_master_' } }, '/keyPrefixes/payment'],
    ['an unsupported network', { assets: [{ name: 'x', network: 'eip155:1', address: '0x1111111111111111111111111111111111111111', decimals: 6, peg: 'usd' }] }, '/assets/0/network'],
    ['an amount that overflows', { paymentKeyDefaults: { dailyBudget: '99999999999999' } }, '/paymentKeyDefaults/dailyBudget'],
    ['an amount that overflows in an asset', { assets: [{ name: 'x', network: 'eip155:84532', address: '0x1111111111111111111111111111111111111111', decimals: 6, peg: 'usd', minPrice: '99999999999999' }] }, '/assets/0/minPrice'],
  ])('rejects %s', (_name, changes, path) => {
    expect(issues(() => buildPlatformConfig(document(changes))).map(issue => issue.path)).toContain(path);
  });

  it('rejects mainnets in staging and testnets in production', () => {
    const production = issues(() => buildPlatformConfig(document({ environment: 'production' })));

    expect(production).toContainEqual({ path: '/assets/0/network', message: 'Base Sepolia is a testnet; production uses mainnets' });

    const staging = loadExamplePlatformDocument();
    (staging['assets'] as Record<string, unknown>[])[2]!['network'] = 'eip155:4217';

    expect(issues(() => buildPlatformConfig(staging as never))).toEqual([{ path: '/assets/2/network', message: 'Tempo is a mainnet; staging uses testnets' }]);
  });

  it('checks every asset against its network', () => {
    const value = loadExamplePlatformDocument();
    const assets = value['assets'] as Record<string, unknown>[];
    assets.push({ ...assets[1], name: 'base-usdc' });
    assets[0] = { ...assets[0], address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
    assets[1] = { ...assets[1], payTo: '0x1111111111111111111111111111111111111111' };
    assertValidPlatformConfigDocument(value);

    expect(issues(() => buildPlatformConfig(value))).toEqual([
      { path: '/assets/0/address', message: 'is not a valid token address on Base Sepolia' },
      { path: '/assets/1/payTo', message: 'is not a valid address on Solana Devnet' },
      { path: '/assets/3/name', message: 'duplicate asset name "base-usdc"' },
      { path: '/assets/3/address', message: 'another asset already uses this token on the same network' },
    ]);
  });

  it('builds an asset without payTo, which is not offered to buyers', () => {
    const value = loadExamplePlatformDocument();
    const assets = value['assets'] as Record<string, unknown>[];
    const { payTo: _payTo, ...withoutPayTo } = assets[0]!;
    assets[0] = withoutPayTo;
    assertValidPlatformConfigDocument(value);
    const config = buildPlatformConfig(value);

    expect(findAsset(config, 'base-usdc')?.payTo).toBeUndefined();
    expect(findAsset(config, 'solana-usdc')?.payTo).toBe('11111111111111111111111111111111');
  });

  it('rejects an asset with an invalid payTo', () => {
    expect(issues(() => buildPlatformConfig(document({ assets: [{ name: 'base-usdc', network: 'eip155:84532', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, peg: 'usd', payTo: '0x12' }] }))))
      .toEqual([{ path: '/assets/0/payTo', message: 'is not a valid address on Base Sepolia' }]);
  });
});

describe('platformSummary', () => {
  it('names the environment, URLs, asset names and networks, and no address', () => {
    const summary = platformSummary(buildPlatformConfig(document()));

    expect(summary).toEqual({
      environment: 'staging',
      urls: { website: 'https://anyfare.test', api: 'https://api.anyfare.test', pay: 'https://pay.anyfare.test' },
      assets: [
        { name: 'base-usdc', network: 'eip155:84532' },
        { name: 'solana-usdc', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
        { name: 'tempo-pathusd', network: 'eip155:42431' },
      ],
    });
    expect(JSON.stringify(summary)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe('assertValidPlatformConfigDocument', () => {
  it.each([
    ['an unknown field', { colour: 'blue' }, '/colour', 'unknown field'],
    ['a missing field', { keyPrefixes: undefined }, '', 'missing required field "keyPrefixes"'],
    ['an unknown version', { version: 2 }, '/version', 'must be 1'],
    ['a URL with a path', { urls: { api: 'https://api.anyfare.test/v1' } }, '/urls/api', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['an HTTP origin', { urls: { pay: 'http://pay.anyfare.test' } }, '/urls/pay', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['a key prefix with capitals', { keyPrefixes: { master: 'AFM_' } }, '/keyPrefixes/master', 'must be 2–32 lowercase letters, digits, or underscores, such as af_live_'],
    ['a numeric amount', { paymentKeyDefaults: { dailyBudget: 5 } }, '/paymentKeyDefaults/dailyBudget', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['an empty asset registry', { assets: [] }, '/assets', 'must have at least 1 item'],
    ['an unknown peg', { assets: [{ name: 'x', network: 'eip155:84532', address: '0x0', decimals: 6, peg: 'eur', payTo: '0x0' }] }, '/assets/0/peg', 'must be "usd"'],
    ['a numeric payTo', { assets: [{ name: 'x', network: 'eip155:84532', address: '0x0', decimals: 6, peg: 'usd', payTo: 1 }] }, '/assets/0/payTo', 'must be a string: put the address in quotes, since YAML reads an unquoted 0x… as a number'],
    ['an unknown log level', { logger: { level: 'verbose' } }, '/logger/level', 'must be one of: "trace", "debug", "info", "warn", "error", "fatal"'],
    ['a missing signup rate limit', { rateLimits: { signup: undefined } }, '/rateLimits', 'missing required field "signup"'],
    ['a removed section', { feeBps: 100 }, '/feeBps', 'unknown field'],
  ])('rejects %s', (_name, changes, path, message) => {
    const value = patch(loadExamplePlatformDocument(), changes);

    expect(issues(() => assertValidPlatformConfigDocument(value))).toContainEqual({ path, message });
  });

  it('rejects unsafe objects before the schema runs', () => {
    const value: unknown = JSON.parse('{"__proto__": {"admin": true}}');

    expect(issues(() => assertValidPlatformConfigDocument(value))).toEqual([{ path: '/__proto__', message: 'the key "__proto__" is not allowed' }]);
  });
});
