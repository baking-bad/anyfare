import { describe, expect, it } from 'vitest';

import { ValidationError } from '@anyfare/common';

import {
  assertValidPlatformConfigDocument, buildPlatformConfig, findAsset, findFacilitator, platformDefaults, platformSummary,
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

const minimalOptionalFields = {
  logger: undefined, ownHosts: undefined, paymentKeyDefaults: undefined, timeouts: undefined,
  sizeLimits: undefined, signer: undefined, rateLimits: { documents: undefined, probeIp: undefined },
};

type MutableDocument = { facilitators: Record<string, unknown>[] };

describe('buildPlatformConfig', () => {
  it('builds the example config', () => {
    const config = buildPlatformConfig(document());

    expect(config.environment).toBe('staging');
    expect(config.assets.map(asset => asset.name)).toEqual(['base-usdc', 'solana-usdc', 'tempo-pathusd']);
    expect(findAsset(config, 'tempo-pathusd')).toMatchObject({
      network: { id: 'eip155:42431', chain: 'tempo', testnet: true }, address: '0x20c0000000000000000000000000000000000000', decimals: 6, minPrice: 0n,
    });
    expect(config.ownHosts).toEqual(['anyfare.test', 'api.anyfare.test', 'pay.anyfare.test']);
    // Secrets by name only
    expect(findFacilitator(config, 'eip155:84532')?.auth).toEqual({ type: 'cdp', apiKeyId: 'CDP_API_KEY_ID', apiKeySecret: 'CDP_API_KEY_SECRET' });
    expect(findFacilitator(config, 'eip155:42431')).toBeUndefined();
    expect(config.mpp.network.chain).toBe('tempo');
    expect(config.routingFeeBps).toBe(0);
  });

  it('enables a facilitator unless it says enabled: false', () => {
    const unset = loadExamplePlatformDocument() as MutableDocument;
    delete unset.facilitators[0]!['enabled'];
    const disabled = loadExamplePlatformDocument() as MutableDocument;
    disabled.facilitators[0]!['enabled'] = false;
    const notBoolean = loadExamplePlatformDocument() as MutableDocument;
    notBoolean.facilitators[0]!['enabled'] = 'no';

    expect(buildPlatformConfig(unset as never).facilitators.map(facilitator => [facilitator.name, facilitator.enabled])).toEqual([['cdp', true]]);
    expect(buildPlatformConfig(disabled as never).facilitators.map(facilitator => [facilitator.name, facilitator.enabled])).toEqual([['cdp', false]]);
    expect(issues(() => assertValidPlatformConfigDocument(notBoolean)).map(issue => issue.path)).toEqual(['/facilitators/0/enabled']);
  });

  it('applies the documented defaults', () => {
    const config = buildPlatformConfig(document(minimalOptionalFields));

    expect(config.logger.level).toBe('info');
    expect(config.paymentKeyDefaults.dailyBudget).toBe(5_000_000n);
    expect(config.timeouts).toEqual(platformDefaults.timeouts);
    expect(findAsset(config, 'base-usdc')?.minPrice).toBe(0n);
    expect(config.sizeLimits).toEqual({ requestBodyBytes: 1_048_576, bufferedResponseBytes: 10_485_760 });
    expect(config.rateLimits.documents).toEqual({ requests: 120, windowSeconds: 60 });
    expect(config.rateLimits.probeIp).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.signer).toEqual({
      maxPerCall: 1_000_000n, maxPerNetworkPerHour: undefined, maxPerNetworkPerDay: 100_000_000n,
      wallets: { base: undefined, tempo: undefined, solana: undefined },
    });
  });

  it('takes the limits from the document when it sets them', () => {
    const config = buildPlatformConfig(document({
      rateLimits: { documents: { requests: 5, windowSeconds: 10 }, probeIp: { requests: 50, windowSeconds: 30 } },
      sizeLimits: { requestBodyBytes: 100 },
      signer: { maxPerCall: '0.1', maxPerNetworkPerHour: '5', maxPerNetworkPerDay: '20' },
    }));

    expect(config.rateLimits.documents).toEqual({ requests: 5, windowSeconds: 10 });
    expect(config.rateLimits.probeIp).toEqual({ requests: 50, windowSeconds: 30 });
    expect(config.rateLimits.paymentKey).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.sizeLimits).toEqual({ requestBodyBytes: 100, bufferedResponseBytes: 10_485_760 });
    expect(config.signer).toMatchObject({ maxPerCall: 100_000n, maxPerNetworkPerHour: 5_000_000n, maxPerNetworkPerDay: 20_000_000n });
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
    expect(Object.isFrozen(config.facilitators[0]!.auth)).toBe(true);
    expect(Object.isFrozen(config.signer.wallets)).toBe(true);
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
    ['a mainnet in staging', { mpp: { network: 'eip155:4217' } }, '/mpp/network'],
    ['an unsupported facilitator network', { facilitators: [{ name: 'x', url: 'https://x.example.com', networks: ['eip155:1'] }] }, '/facilitators/0/networks/0'],
    ['a non-Tempo MPP network', { mpp: { network: 'eip155:84532' } }, '/mpp/network'],
    ['an invalid MPP recipient', { mpp: { recipient: '0x12' } }, '/mpp/recipient'],
    ['a Signer wallet that isn\'t an address', { signer: { wallets: { tempo: '0x12' } } }, '/signer/wallets/tempo'],
    ['a Solana Signer wallet that isn\'t a base58 address', { signer: { wallets: { solana: '0x4444444444444444444444444444444444444444' } } }, '/signer/wallets/solana'],
    ['a Signer limit that overflows', { signer: { maxPerCall: '99999999999999' } }, '/signer/maxPerCall'],
    ['an amount that overflows', { paymentKeyDefaults: { dailyBudget: '99999999999999' } }, '/paymentKeyDefaults/dailyBudget'],
    ['an amount that overflows in an asset', { assets: [{ name: 'x', network: 'eip155:84532', address: '0x1111111111111111111111111111111111111111', decimals: 6, peg: 'usd', minPrice: '99999999999999' }] }, '/assets/0/minPrice'],
  ])('rejects %s', (_name, changes, path) => {
    expect(issues(() => buildPlatformConfig(document(changes))).map(issue => issue.path)).toContain(path);
  });

  it('rejects mainnets in staging and testnets in production', () => {
    const production = issues(() => buildPlatformConfig(document({ environment: 'production' })));

    expect(production).toContainEqual({ path: '/assets/0/network', message: 'Base Sepolia is a testnet; production uses mainnets' });
    expect(production).toContainEqual({ path: '/facilitators/0/networks/0', message: 'Base Sepolia is a testnet; production uses mainnets' });
    expect(production).toContainEqual({ path: '/mpp/network', message: 'Tempo Moderato is a testnet; production uses mainnets' });

    const staging = loadExamplePlatformDocument();
    (staging['assets'] as Record<string, unknown>[])[2]!['network'] = 'eip155:4217';

    expect(issues(() => buildPlatformConfig(staging as never))).toEqual([
      { path: '/assets/2/network', message: 'Tempo is a mainnet; staging uses testnets' },
      { path: '/assets/2/network', message: 'is a Tempo network other than mpp.network (eip155:42431). Tempo assets serve MPP, on its network only' },
    ]);
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

describe('MPP', () => {
  it('is offered by default, can be turned off, and takes an optional RPC URL', () => {
    const config = buildPlatformConfig(document());
    const disabled = buildPlatformConfig(document({ mpp: { enabled: false, rpcUrl: 'https://tempo-rpc.example.com/v1' } }));

    expect(config.mpp).toMatchObject({ network: { id: 'eip155:42431', chain: 'tempo' }, enabled: true, rpcUrl: undefined });
    expect(disabled.mpp).toMatchObject({ enabled: false, rpcUrl: 'https://tempo-rpc.example.com/v1' });
    expect(issues(() => assertValidPlatformConfigDocument(patch(loadExamplePlatformDocument(), { mpp: { rpcUrl: 'http://rpc.moderato.tempo.xyz' } }))))
      .toEqual([{ path: '/mpp/rpcUrl', message: 'must be an HTTPS URL without credentials or a fragment' }]);
    expect(issues(() => assertValidPlatformConfigDocument(patch(loadExamplePlatformDocument(), { mpp: { rpcUrl: 'https://user:key@rpc.example.com' } }))).map(issue => issue.path))
      .toEqual(['/mpp/rpcUrl']);
    expect(issues(() => assertValidPlatformConfigDocument(patch(loadExamplePlatformDocument(), { mpp: { enabled: 'no' } }))).map(issue => issue.path))
      .toEqual(['/mpp/enabled']);
  });

  it('builds without a recipient, and the summary says MPP is not offered', () => {
    const config = buildPlatformConfig(document({ mpp: { recipient: undefined } }));

    expect(config.mpp.recipient).toBeUndefined();
    expect(platformSummary(config).rails.mpp).toBe(false);
  });

  it('takes a Tempo asset without a facilitator, paid to the MPP recipient', () => {
    const config = buildPlatformConfig(document());

    expect(findAsset(config, 'tempo-pathusd')).toMatchObject({
      network: { id: 'eip155:42431', chain: 'tempo', testnet: true }, address: '0x20c0000000000000000000000000000000000000', decimals: 6, minPrice: 0n,
      payTo: config.mpp.recipient,
    });
    expect(findFacilitator(config, 'eip155:42431')).toBeUndefined();
  });

  it('rejects a Tempo asset on another Tempo network, or paid to another address', () => {
    const value = loadExamplePlatformDocument();
    const assets = value['assets'] as Record<string, unknown>[];
    const tempo = assets[2]!;
    assets[2] = { ...tempo, payTo: '0x3333333333333333333333333333333333333333' };
    // Upper case is the same EVM address
    assets.push({ ...tempo, name: 'tempo-pathusd-upper', payTo: (tempo['payTo'] as string).toUpperCase().replace('0X', '0x'), address: '0x20C0000000000000000000000000000000000001' });
    assets.push({ ...tempo, name: 'tempo-mainnet', network: 'eip155:4217' });
    assertValidPlatformConfigDocument(value);

    expect(issues(() => buildPlatformConfig(value))).toEqual([
      { path: '/assets/4/network', message: 'Tempo is a mainnet; staging uses testnets' },
      { path: '/assets/2/payTo', message: 'must be the MPP recipient (mpp.recipient): Tempo assets are paid through MPP' },
      { path: '/assets/4/network', message: 'is a Tempo network other than mpp.network (eip155:42431). Tempo assets serve MPP, on its network only' },
    ]);
  });
});

describe('facilitators', () => {
  it('requires exactly one facilitator for each asset network', () => {
    const value = loadExamplePlatformDocument();
    const facilitators = value['facilitators'] as Record<string, unknown>[];
    // Base only, twice: Solana is left without one. The Tempo asset needs none
    const baseOnly = { ...facilitators[0], networks: ['eip155:84532'] };
    value['facilitators'] = [baseOnly, { ...baseOnly }];
    assertValidPlatformConfigDocument(value);

    expect(issues(() => buildPlatformConfig(value))).toEqual([
      { path: '/facilitators/1/name', message: 'duplicate facilitator name "cdp"' },
      { path: '/facilitators/1/networks/0', message: 'facilitator "cdp" already serves this network' },
      { path: '/assets/1/network', message: 'no facilitator serves this network' },
    ]);
  });

  it('takes no flat fee: that field does not exist', () => {
    const value = loadExamplePlatformDocument() as MutableDocument;
    value.facilitators[0]!['feePerPayment'] = '0.0005';

    expect(issues(() => assertValidPlatformConfigDocument(value))).toEqual([{ path: '/facilitators/0/feePerPayment', message: 'unknown field' }]);
  });
});

describe('the Signer', () => {
  it('takes the hot wallets by their public addresses, each optional, Solana\'s in base58', () => {
    const wallets = { base: '0x3333333333333333333333333333333333333333', tempo: '0x4444444444444444444444444444444444444444', solana: '11111111111111111111111111111111' };

    expect(buildPlatformConfig(document({ signer: { wallets } })).signer.wallets).toEqual(wallets);
    expect(buildPlatformConfig(document({ signer: { wallets: { tempo: wallets.tempo } } })).signer.wallets).toEqual({ base: undefined, tempo: wallets.tempo, solana: undefined });
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
      rails: {
        credits: true,
        x402: [{ facilitator: 'cdp', networks: ['eip155:84532', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'] }],
        mpp: { network: 'eip155:42431' },
      },
      fees: { routingFeeBps: 0 },
    });
    expect(JSON.stringify(summary)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it('leaves out a disabled facilitator and a disabled MPP', () => {
    const value = loadExamplePlatformDocument() as MutableDocument;
    value.facilitators[0]!['enabled'] = false;
    const summary = platformSummary(buildPlatformConfig(patch(value, { mpp: { enabled: false } }) as never));

    expect(summary.rails).toEqual({ credits: true, x402: [], mpp: false });
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
    ['a secret value instead of its name', { facilitators: [{ auth: { apiKeySecret: 'hunter2' } }] }, '/facilitators/0/auth/apiKeySecret', 'must name the environment variable that holds the secret, such as CDP_API_KEY_SECRET. Never put the value here'],
    ['a routing fee above 100%', { routingFeeBps: 10_001 }, '/routingFeeBps', 'must be at most 10000'],
    ['a missing routing fee', { routingFeeBps: undefined }, '', 'missing required field "routingFeeBps"'],
    ['no facilitator', { facilitators: [] }, '/facilitators', 'must have at least 1 item'],
    ['a facilitator without networks', { facilitators: [{ networks: [] }] }, '/facilitators/0/networks', 'must have at least 1 item'],
    ['a facilitator network listed twice', { facilitators: [{ networks: ['eip155:84532', 'eip155:84532'] }] }, '/facilitators/0/networks', 'must not contain duplicates'],
    ['a facilitator URL with credentials', { facilitators: [{ url: 'https://user:key@x402.example.com' }] }, '/facilitators/0/url', 'must be an HTTP or HTTPS URL without credentials or a fragment'],
    ['a missing MPP section', { mpp: undefined }, '', 'missing required field "mpp"'],
    ['a missing paymentKey rate limit', { rateLimits: { paymentKey: undefined } }, '/rateLimits', 'missing required field "paymentKey"'],
    ['a missing unpaidIp rate limit', { rateLimits: { unpaidIp: undefined } }, '/rateLimits', 'missing required field "unpaidIp"'],
    ['a size limit of zero', { sizeLimits: { requestBodyBytes: 0 } }, '/sizeLimits/requestBodyBytes', 'must be at least 1'],
  ])('rejects %s', (_name, changes, path, message) => {
    const value = patch(loadExamplePlatformDocument(), changes);

    expect(issues(() => assertValidPlatformConfigDocument(value))).toContainEqual({ path, message });
  });

  it('rejects unsafe objects before the schema runs', () => {
    const value: unknown = JSON.parse('{"__proto__": {"admin": true}}');

    expect(issues(() => assertValidPlatformConfigDocument(value))).toEqual([{ path: '/__proto__', message: 'the key "__proto__" is not allowed' }]);
  });
});
