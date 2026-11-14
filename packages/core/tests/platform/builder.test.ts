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
  sizeLimits: undefined, signer: undefined, rateLimits: { documents: undefined, probeIp: undefined, topups: undefined, publicReads: undefined }, callStream: undefined, freeCredits: undefined,
  topups: undefined, stats: undefined, rebalancing: undefined,
};

type MutableDocument = { facilitators: Record<string, unknown>[] };

describe('buildPlatformConfig', () => {
  it('builds the example config', () => {
    const config = buildPlatformConfig(document());

    expect(config.environment).toBe('staging');
    expect(config.assets.map(asset => asset.name)).toEqual(['base-usdc', 'solana-usdc', 'tempo-pathusd', 'near-usdc']);
    expect(findAsset(config, 'tempo-pathusd')).toMatchObject({
      network: { id: 'eip155:42431', chain: 'tempo', testnet: true }, address: '0x20c0000000000000000000000000000000000000', decimals: 6, minPrice: 0n,
    });
    expect(config.ownHosts).toEqual(['anyfare.test', 'api.anyfare.test', 'pay.anyfare.test', 'console.anyfare.test']);
    // Secrets by name only
    expect(findFacilitator(config, 'eip155:84532')?.auth).toEqual({ type: 'cdp', apiKeyId: 'CDP_API_KEY_ID', apiKeySecret: 'CDP_API_KEY_SECRET' });
    expect(findFacilitator(config, 'near:testnet')).toMatchObject({ name: 'near', url: 'http://127.0.0.1:8084', auth: { type: 'api-key', apiKey: 'FACILITATOR_SECRET' } });
    expect(findAsset(config, 'near-usdc')).toMatchObject({
      network: { id: 'near:testnet', namespace: 'near', chain: 'near', testnet: true },
      address: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af', decimals: 6, payTo: 'pay.anyfare.testnet',
    });
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

    expect(buildPlatformConfig(unset as never).facilitators.map(facilitator => [facilitator.name, facilitator.enabled])).toEqual([['cdp', true], ['near', true]]);
    expect(buildPlatformConfig(disabled as never).facilitators.map(facilitator => [facilitator.name, facilitator.enabled])).toEqual([['cdp', false], ['near', true]]);
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
    expect(config.rateLimits.topups).toEqual({ requests: 20, windowSeconds: 3_600 });
    expect(config.rateLimits.publicReads).toEqual({ requests: 120, windowSeconds: 60 });
    expect(config.callStream).toEqual({ maxPerIp: 20, maxTotal: 1_000 });
    expect(config.stats).toEqual({ intervalSeconds: 300, allIntervalSeconds: 3_600, maxServices: 1_000 });
    expect(config.signer).toEqual({
      maxPerCall: 1_000_000n, maxPerNetworkPerHour: undefined, maxPerNetworkPerDay: 100_000_000n,
      wallets: { base: undefined, tempo: undefined, solana: undefined, near: undefined },
    });
    expect(config.freeCredits).toEqual({ enabled: false, amount: 100_000n, perIp: { requests: 3, windowSeconds: 86_400 }, maxPerDay: undefined });
    expect(config.topups).toMatchObject({ enabled: false, url: 'https://1click.chaindefuser.com', asset: undefined, networks: [] });
    expect(config.rebalancing).toEqual({
      enabled: false, source: undefined, sourceFloor: 0n, leastPerRefill: 1_000_000n, mostPerRefill: 10_000_000n, mostPerAssetPerDay: 20_000_000n, maxFeeBps: 200,
      slippageBps: 50, deadlineMinutes: 30, intervalSeconds: 300, targets: [],
    });
  });

  it('takes the limits from the document when it sets them', () => {
    const config = buildPlatformConfig(document({
      rateLimits: {
        documents: { requests: 5, windowSeconds: 10 }, probeIp: { requests: 50, windowSeconds: 30 }, topups: { requests: 3, windowSeconds: 60 },
        publicReads: { requests: 7, windowSeconds: 20 },
      },
      callStream: { maxPerIp: 2 },
      stats: { intervalSeconds: 60, maxServices: 5 },
      sizeLimits: { requestBodyBytes: 100 },
      signer: { maxPerCall: '0.1', maxPerNetworkPerHour: '5', maxPerNetworkPerDay: '20' },
    }));

    expect(config.rateLimits.documents).toEqual({ requests: 5, windowSeconds: 10 });
    expect(config.rateLimits.probeIp).toEqual({ requests: 50, windowSeconds: 30 });
    expect(config.rateLimits.topups).toEqual({ requests: 3, windowSeconds: 60 });
    expect(config.rateLimits.publicReads).toEqual({ requests: 7, windowSeconds: 20 });
    expect(config.callStream).toEqual({ maxPerIp: 2, maxTotal: 1_000 });
    expect(config.stats).toEqual({ intervalSeconds: 60, allIntervalSeconds: 3_600, maxServices: 5 });
    expect(config.rateLimits.paymentKey).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.sizeLimits).toEqual({ requestBodyBytes: 100, bufferedResponseBytes: 10_485_760 });
    expect(config.signer).toMatchObject({ maxPerCall: 100_000n, maxPerNetworkPerHour: 5_000_000n, maxPerNetworkPerDay: 20_000_000n });
  });

  it('takes the public numbers\' intervals and services cap in whole numbers within their ranges', () => {
    for (const [field, value] of [
      ['intervalSeconds', 9], ['intervalSeconds', 86_401], ['intervalSeconds', 30.5], ['intervalSeconds', '300'], ['allIntervalSeconds', 59],
      ['allIntervalSeconds', 604_801], ['maxServices', 0], ['maxServices', 10_001],
    ] as const) {
      expect(issues(() => assertValidPlatformConfigDocument(patch(loadExamplePlatformDocument(), { stats: { [field]: value } }))).map(issue => issue.path), `${field} ${value}`)
        .toEqual([`/stats/${field}`]);
    }
    expect(buildPlatformConfig(document({ stats: { intervalSeconds: 10, allIntervalSeconds: 60, maxServices: 1 } })).stats)
      .toEqual({ intervalSeconds: 10, allIntervalSeconds: 60, maxServices: 1 });
  });

  it('merges partial overrides with defaults and normalizes own hosts', () => {
    const config = buildPlatformConfig(document({ timeouts: { connectMs: 1_000 }, ownHosts: ['Edge.Anyfare.test', '203.0.113.7'] }));

    expect(config.timeouts).toEqual({ connectMs: 1_000, requestMs: 30_000, settleMs: 30_000 });
    expect(config.ownHosts).toContain('edge.anyfare.test');
    expect(config.ownHosts).toContain('203.0.113.7');
  });

  it('takes the console\'s origin, optional, whose host is one of the own hosts', () => {
    const elsewhere = buildPlatformConfig(document({ urls: { console: 'https://console.elsewhere.test' } }));
    const without = buildPlatformConfig(document({ urls: { console: undefined } }));

    expect(buildPlatformConfig(document()).urls.console).toBe('https://console.anyfare.test');
    expect(elsewhere.urls.console).toBe('https://console.elsewhere.test');
    expect(elsewhere.ownHosts).toEqual(['anyfare.test', 'api.anyfare.test', 'pay.anyfare.test', 'console.elsewhere.test']);
    expect(without.urls).toEqual({ website: 'https://anyfare.test', api: 'https://api.anyfare.test', pay: 'https://pay.anyfare.test' });
    expect(without.ownHosts).toEqual(['anyfare.test', 'api.anyfare.test', 'pay.anyfare.test']);
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
    expect(Object.isFrozen(config.freeCredits.perIp)).toBe(true);
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
    ['a NEAR Signer wallet that isn\'t an account ID', { signer: { wallets: { near: 'Pay.Anyfare.testnet' } } }, '/signer/wallets/near'],
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
      { path: '/assets/4/name', message: 'duplicate asset name "base-usdc"' },
      { path: '/assets/4/address', message: 'another asset already uses this token on the same network' },
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
    const assets = [{ name: 'base-usdc', network: 'eip155:84532', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, peg: 'usd', payTo: '0x12' }];

    expect(issues(() => buildPlatformConfig(document({ assets, topups: undefined, rebalancing: undefined }))))
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
      { path: '/assets/5/network', message: 'Tempo is a mainnet; staging uses testnets' },
      { path: '/assets/2/payTo', message: 'must be the MPP recipient (mpp.recipient): Tempo assets are paid through MPP' },
      { path: '/assets/5/network', message: 'is a Tempo network other than mpp.network (eip155:42431). Tempo assets serve MPP, on its network only' },
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
      { path: '/assets/3/network', message: 'no facilitator serves this network' },
    ]);
  });

  it('takes no flat fee: that field does not exist', () => {
    const value = loadExamplePlatformDocument() as MutableDocument;
    value.facilitators[0]!['feePerPayment'] = '0.0005';

    expect(issues(() => assertValidPlatformConfigDocument(value))).toEqual([{ path: '/facilitators/0/feePerPayment', message: 'unknown field' }]);
  });
});

describe('the Signer', () => {
  it('takes the hot wallets by their public addresses, each optional, Solana\'s in base58 and NEAR\'s as an account ID', () => {
    const wallets = {
      base: '0x3333333333333333333333333333333333333333', tempo: '0x4444444444444444444444444444444444444444', solana: '11111111111111111111111111111111',
      near: 'pay.anyfare.testnet',
    };

    expect(buildPlatformConfig(document({ signer: { wallets } })).signer.wallets).toEqual(wallets);
    expect(buildPlatformConfig(document({ signer: { wallets: { tempo: wallets.tempo } } })).signer.wallets).toEqual({
      base: undefined, tempo: wallets.tempo, solana: undefined, near: undefined,
    });
    expect(buildPlatformConfig(document({ signer: { wallets: { near: wallets.near } } })).signer.wallets).toMatchObject({ base: undefined, near: wallets.near });
  });

  it('says a NEAR wallet must be an account ID', () => {
    expect(issues(() => buildPlatformConfig(document({ signer: { wallets: { near: 'pay anyfare' } } })))).toContainEqual({
      path: '/signer/wallets/near', message: 'is not a NEAR account ID',
    });
  });
});

describe('free credits', () => {
  it('are off by default, at $0.10 for three new accounts a day per client IP, with no daily cap', () => {
    const config = buildPlatformConfig(document({ freeCredits: undefined }));

    expect(config.freeCredits).toEqual({ enabled: false, amount: 100_000n, perIp: { requests: 3, windowSeconds: 86_400 }, maxPerDay: undefined });
    expect(platformDefaults.freeCredits).toEqual({ enabled: false, amount: '0.1', perIp: { requests: 3, windowSeconds: 86_400 } });
  });

  it('take the values the document sets', () => {
    const config = buildPlatformConfig(document({
      freeCredits: { enabled: true, amount: '0.25', perIp: { requests: 5, windowSeconds: 3_600 }, maxPerDay: '12.5' },
    }));

    expect(config.freeCredits).toEqual({ enabled: true, amount: 250_000n, perIp: { requests: 5, windowSeconds: 3_600 }, maxPerDay: 12_500_000n });
  });

  it('fill what the document leaves out with the defaults', () => {
    const config = buildPlatformConfig(document({ freeCredits: { enabled: true } }));

    expect(config.freeCredits).toEqual({ enabled: true, amount: 100_000n, perIp: { requests: 3, windowSeconds: 86_400 }, maxPerDay: undefined });
  });

  it('take the largest gift, $10, and a daily cap of exactly one gift', () => {
    const config = buildPlatformConfig(document({ freeCredits: { enabled: true, amount: '10', maxPerDay: '10' } }));

    expect(config.freeCredits).toMatchObject({ amount: 10_000_000n, maxPerDay: 10_000_000n });
  });

  it.each([
    ['a zero amount', { amount: '0' }, '/freeCredits/amount', 'must be more than 0. To give nothing, set freeCredits.enabled to false'],
    ['an amount above $10', { amount: '10.000001' }, '/freeCredits/amount', 'must be at most 10 USD, the most one new account may get'],
    ['a daily cap below the amount', { amount: '0.5', maxPerDay: '0.4' }, '/freeCredits/maxPerDay', 'must be at least freeCredits.amount (0.5 USD): a smaller daily cap would give nothing'],
    ['a daily cap below the default amount', { maxPerDay: '0.05' }, '/freeCredits/maxPerDay', 'must be at least freeCredits.amount (0.1 USD): a smaller daily cap would give nothing'],
    ['a daily cap that overflows', { maxPerDay: '99999999999999' }, '/freeCredits/maxPerDay', 'The USD amount is too large'],
  ])('refuse %s, even while the gift is off', (_name, freeCredits, path, message) => {
    expect(issues(() => buildPlatformConfig(document({ freeCredits })))).toEqual([{ path, message }]);
    expect(issues(() => buildPlatformConfig(document({ freeCredits: { ...freeCredits, enabled: true } })))).toEqual([{ path, message }]);
  });

  it.each([
    ['a numeric amount', { amount: 0.1 }, '/freeCredits/amount', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['a negative amount', { amount: '-1' }, '/freeCredits/amount', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['an enabled that isn\'t a boolean', { enabled: 'yes' }, '/freeCredits/enabled', 'must be true or false'],
    ['a per-IP limit of zero', { perIp: { requests: 0, windowSeconds: 86_400 } }, '/freeCredits/perIp/requests', 'must be at least 1'],
    ['a per-IP limit without its window', { perIp: { requests: 3 } }, '/freeCredits/perIp', 'missing required field "windowSeconds"'],
    ['a per-IP window over 30 days', { perIp: { requests: 3, windowSeconds: 2_592_001 } }, '/freeCredits/perIp/windowSeconds', 'must be at most 2592000'],
    ['an unknown field', { perDay: 10 }, '/freeCredits/perDay', 'unknown field'],
  ])('refuse %s in the schema', (_name, freeCredits, path, message) => {
    expect(issues(() => assertValidPlatformConfigDocument(patch(loadExamplePlatformDocument(), { freeCredits })))).toContainEqual({ path, message });
  });
});

describe('top-ups', () => {
  const exampleNetworks = [
    { name: 'base', blockchain: 'base', minimum: 1_000_000n },
    { name: 'arbitrum', blockchain: 'arb', minimum: 1_000_000n },
    { name: 'solana', blockchain: 'sol', minimum: 1_000_000n },
    { name: 'near', blockchain: 'near', minimum: 1_000_000n },
    { name: 'ethereum', blockchain: 'eth', minimum: 5_000_000n },
    { name: 'bitcoin', blockchain: 'btc', minimum: 10_000_000n },
  ];

  it('are off without the section, with the defaults and no networks', () => {
    const config = buildPlatformConfig(document({ topups: undefined }));

    expect(config.topups).toEqual({
      enabled: false,
      url: 'https://1click.chaindefuser.com',
      apiKey: undefined,
      asset: undefined,
      recipient: undefined,
      refundTo: undefined,
      slippageBps: 100,
      deadlineMinutes: { stablecoin: 1_440, other: 120 },
      stablecoins: ['USDC', 'USDT', 'USDT0', 'DAI', 'USD1'],
      timeoutMs: 15_000,
      networks: [],
    });
    expect(platformSummary(config).topups).toEqual({ enabled: false, networks: [] });
  });

  it('take the example\'s section: off, the registry\'s NEAR asset, and six networks with their minimums in micro-USD', () => {
    const config = buildPlatformConfig(document());

    expect(config.topups).toMatchObject({
      enabled: false, url: 'http://127.0.0.1:8085', apiKey: undefined, recipient: 'treasury.anyfare.testnet', refundTo: 'treasury.anyfare.testnet', networks: exampleNetworks,
    });
    expect(config.topups.asset).toBe(findAsset(config, 'near-usdc'));
    expect(Object.isFrozen(config.topups.networks[0])).toBe(true);
  });

  it('turn on with an override, and the summary names the networks', () => {
    const config = buildPlatformConfig(document({ topups: { enabled: true } }));

    expect(config.topups.enabled).toBe(true);
    expect(config.topups.asset).toMatchObject({ name: 'near-usdc', network: { id: 'near:testnet' }, address: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af' });
    expect(platformSummary(config).topups).toEqual({ enabled: true, networks: ['base', 'arbitrum', 'solana', 'near', 'ethereum', 'bitcoin'] });
  });

  it('take the values the document sets, and fill a partial deadline with the default', () => {
    const config = buildPlatformConfig(document({
      topups: {
        enabled: true, url: 'https://oneclick.example.com', apiKey: 'ONECLICK_API_KEY', slippageBps: 50, deadlineMinutes: { other: 60 }, stablecoins: ['usdc', 'PYUSD'],
        timeoutMs: 5_000, networks: [{ name: 'base', blockchain: 'base', minimum: '0.5' }],
      },
    }));

    expect(config.topups).toMatchObject({
      url: 'https://oneclick.example.com', apiKey: 'ONECLICK_API_KEY', slippageBps: 50, deadlineMinutes: { stablecoin: 1_440, other: 60 }, stablecoins: ['usdc', 'PYUSD'],
      timeoutMs: 5_000, networks: [{ name: 'base', blockchain: 'base', minimum: 500_000n }],
    });
  });

  it.each([
    ['a missing recipient', { recipient: undefined }, [{ path: '/topups', message: 'missing required field "recipient": top-ups are enabled' }]],
    ['a missing asset', { asset: undefined }, [{ path: '/topups', message: 'missing required field "asset": top-ups are enabled' }]],
    ['a missing refundTo', { refundTo: undefined }, [{ path: '/topups', message: 'missing required field "refundTo": top-ups are enabled' }]],
    ['no networks', { networks: undefined }, [{ path: '/topups', message: 'missing required field "networks": top-ups are enabled' }]],
    ['an empty network list', { networks: [] }, [{ path: '/topups/networks', message: 'must have at least 1 item: top-ups are enabled' }]],
  ])('refuse %s when enabled, and take it while off', (_name, changes, expected) => {
    expect(issues(() => buildPlatformConfig(document({ topups: { ...changes, enabled: true } })))).toEqual(expected);
    expect(buildPlatformConfig(document({ topups: changes })).topups.enabled).toBe(false);
  });

  it.each([
    ['an asset not on NEAR', { asset: 'base-usdc' }, '/topups/asset', 'must be an asset on a NEAR network: 1Click delivers it to a NEAR account'],
    ['an asset not in the registry', { asset: 'near-usdt' }, '/topups/asset', 'is not an asset in assets. Assets: base-usdc, solana-usdc, tempo-pathusd, near-usdc'],
    ['a recipient that isn\'t a NEAR account', { recipient: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' }, '/topups/recipient', 'is not a NEAR account ID'],
    ['a refundTo that isn\'t a NEAR account', { refundTo: 'Treasury.Anyfare.testnet' }, '/topups/refundTo', 'is not a NEAR account ID'],
    ['a minimum of 0', { networks: [{ name: 'base', blockchain: 'base', minimum: '0' }] }, '/topups/networks/0/minimum', 'must be more than 0: the least a top-up on this network must be worth'],
    ['a minimum that isn\'t whole cents', { networks: [{ name: 'base', blockchain: 'base', minimum: '1.001' }] }, '/topups/networks/0/minimum', 'must be whole cents, at most 2 decimals, such as 1 or 2.5: a top-up\'s worth is rounded to the cent'],
    ['a minimum that overflows', { networks: [{ name: 'base', blockchain: 'base', minimum: '99999999999999' }] }, '/topups/networks/0/minimum', 'The USD amount is too large'],
    ['duplicate network names', { networks: [{ name: 'base', blockchain: 'base', minimum: '1' }, { name: 'base', blockchain: 'arb', minimum: '1' }] }, '/topups/networks/1/name', 'duplicate network name "base"'],
  ])('refuse %s, even while off', (_name, changes, path, message) => {
    expect(issues(() => buildPlatformConfig(document({ topups: changes })))).toEqual([{ path, message }]);
    expect(issues(() => buildPlatformConfig(document({ topups: { ...changes, enabled: true } })))).toEqual([{ path, message }]);
  });

  it('take one blockchain under two names', () => {
    const networks = [{ name: 'ethereum', blockchain: 'eth', minimum: '5' }, { name: 'eth', blockchain: 'eth', minimum: '5' }];

    expect(buildPlatformConfig(document({ topups: { enabled: true, networks } })).topups.networks.map(network => network.name)).toEqual(['ethereum', 'eth']);
  });

  it.each([
    ['a key value instead of its name', { apiKey: 'sk-live-1234' }, '/topups/apiKey', 'must name the environment variable that holds the secret, such as CDP_API_KEY_SECRET. Never put the value here'],
    ['a URL that isn\'t HTTP', { url: 'ftp://1click.example.com' }, '/topups/url', 'must be an HTTP or HTTPS URL without credentials or a fragment'],
    ['a slippage of 0', { slippageBps: 0 }, '/topups/slippageBps', 'must be at least 1'],
    ['a slippage above 50%', { slippageBps: 5_001 }, '/topups/slippageBps', 'must be at most 5000'],
    ['a deadline under 10 minutes', { deadlineMinutes: { stablecoin: 9 } }, '/topups/deadlineMinutes/stablecoin', 'must be at least 10'],
    ['a deadline over a week', { deadlineMinutes: { other: 10_081 } }, '/topups/deadlineMinutes/other', 'must be at most 10080'],
    ['a stablecoin listed twice', { stablecoins: ['USDC', 'USDC'] }, '/topups/stablecoins', 'must not contain duplicates'],
    ['a timeout of 0', { timeoutMs: 0 }, '/topups/timeoutMs', 'must be at least 1'],
    ['a network name with capitals', { networks: [{ name: 'Base', blockchain: 'base', minimum: '1' }] }, '/topups/networks/0/name', 'must be 2–32 lowercase letters, digits, or hyphens, starting with a letter, such as base'],
    ['a blockchain that starts with a digit', { networks: [{ name: 'base', blockchain: '1base', minimum: '1' }] }, '/topups/networks/0/blockchain', 'must be 2–32 lowercase letters, digits, or hyphens, starting with a letter, such as base'],
    ['a network without a minimum', { networks: [{ name: 'base', blockchain: 'base' }] }, '/topups/networks/0', 'missing required field "minimum"'],
    ['a numeric minimum', { networks: [{ name: 'base', blockchain: 'base', minimum: 1 }] }, '/topups/networks/0/minimum', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['an unknown field', { memo: true }, '/topups/memo', 'unknown field'],
  ])('refuse %s in the schema', (_name, topups, path, message) => {
    expect(issues(() => assertValidPlatformConfigDocument(patch(loadExamplePlatformDocument(), { topups })))).toContainEqual({ path, message });
  });
});

describe('rebalancing', () => {
  // Made-up hot wallets, as an operator names them when rebalancing is on
  const wallets = { base: '0x3333333333333333333333333333333333333333', solana: '11111111111111111111111111111111', near: 'pay.anyfare.testnet' };
  const on = (changes: Record<string, unknown> = {}, signer: unknown = { wallets }) => document({ signer, rebalancing: { enabled: true, ...changes } });
  const target = (asset: string, floor = '5', level = '10', blockchain = asset.startsWith('solana') ? 'sol' : 'base') => ({ asset, blockchain, floor, target: level });

  it('take the example\'s section: off, paid with near-usdc, and two targets with their floors and targets in micro-USD', () => {
    const config = buildPlatformConfig(document());

    expect(config.rebalancing).toMatchObject({
      enabled: false, leastPerRefill: 1_000_000n, mostPerRefill: 10_000_000n, mostPerAssetPerDay: 20_000_000n, maxFeeBps: 200, slippageBps: 50, deadlineMinutes: 30,
      intervalSeconds: 300,
    });
    expect(config.rebalancing.source).toBe(findAsset(config, 'near-usdc'));
    expect(config.rebalancing.targets.map(item => [item.asset.name, item.blockchain, item.floor, item.target])).toEqual([
      ['base-usdc', 'base', 5_000_000n, 10_000_000n], ['solana-usdc', 'sol', 3_000_000n, 6_000_000n],
    ]);
    expect(config.rebalancing.targets[0]!.asset).toBe(findAsset(config, 'base-usdc'));
    expect(Object.isFrozen(config.rebalancing.targets[0])).toBe(true);
  });

  it('turn on with the Signer\'s wallets on NEAR and on each target\'s chain, and pay 1Click at topups.url, the default when it isn\'t set', () => {
    expect(buildPlatformConfig(on()).rebalancing.enabled).toBe(true);
    expect(buildPlatformConfig(on()).topups.url).toBe('http://127.0.0.1:8085');
    expect(buildPlatformConfig(patch(on(), { topups: { url: undefined } }) as PlatformConfigDocument).topups.url).toBe('https://1click.chaindefuser.com');
    // Only Base is refilled: Solana's wallet isn't needed
    expect(buildPlatformConfig(on({ targets: [target('base-usdc')] }, { wallets: { base: wallets.base, near: wallets.near } })).rebalancing.targets).toHaveLength(1);
  });

  it('take the values the document sets', () => {
    const config = buildPlatformConfig(on({
      sourceFloor: '2.5', leastPerRefill: '0.5', mostPerRefill: '0.5', mostPerAssetPerDay: '0.5', maxFeeBps: 0, slippageBps: 500, deadlineMinutes: 240,
      intervalSeconds: 60, targets: [target('solana-usdc', '0', '0.000001')],
    }));

    expect(config.rebalancing).toMatchObject({
      sourceFloor: 2_500_000n, leastPerRefill: 500_000n, mostPerRefill: 500_000n, mostPerAssetPerDay: 500_000n, maxFeeBps: 0, slippageBps: 500, deadlineMinutes: 240,
      intervalSeconds: 60,
    });
    expect(config.rebalancing.targets.map(item => [item.asset.name, item.floor, item.target])).toEqual([['solana-usdc', 0n, 1n]]);
  });

  it.each([
    ['no NEAR wallet', { base: wallets.base, solana: wallets.solana }, 'missing required field "near": rebalancing is enabled, and refills are paid from the NEAR hot wallet'],
    ['no Base wallet for base-usdc', { solana: wallets.solana, near: wallets.near }, 'missing required field "base": rebalancing is enabled, and refills go to the Signer\'s wallet there'],
    ['no Solana wallet for solana-usdc', { base: wallets.base, near: wallets.near }, 'missing required field "solana": rebalancing is enabled, and refills go to the Signer\'s wallet there'],
  ])('refuse %s when enabled, and take it while off', (_name, signerWallets, message) => {
    expect(issues(() => buildPlatformConfig(on({}, { wallets: signerWallets })))).toEqual([{ path: '/signer/wallets', message }]);
    expect(buildPlatformConfig(document({ signer: { wallets: signerWallets } })).rebalancing.enabled).toBe(false);
  });

  it.each([
    ['a missing source', { source: undefined }, [{ path: '/rebalancing', message: 'missing required field "source": rebalancing is enabled' }]],
    ['no targets', { targets: undefined }, [{ path: '/rebalancing', message: 'missing required field "targets": rebalancing is enabled' }]],
    ['an empty target list', { targets: [] }, [{ path: '/rebalancing/targets', message: 'must have at least 1 item: rebalancing is enabled' }]],
  ])('refuse %s when enabled, and take it while off', (_name, changes, expected) => {
    expect(issues(() => buildPlatformConfig(on(changes)))).toEqual(expected);
    expect(buildPlatformConfig(document({ rebalancing: changes })).rebalancing.enabled).toBe(false);
  });

  it.each([
    ['a source not in the registry', { source: 'near-usdt' }, '/rebalancing/source', 'is not an asset in assets. Assets: base-usdc, solana-usdc, tempo-pathusd, near-usdc'],
    ['a source not on NEAR', { source: 'base-usdc' }, '/rebalancing/source', 'must be an asset on a NEAR network: refills are paid from the NEAR hot wallet'],
    ['a target not in the registry', { targets: [target('base-usdt')] }, '/rebalancing/targets/0/asset', 'is not an asset in assets. Assets: base-usdc, solana-usdc, tempo-pathusd, near-usdc'],
    ['a target on NEAR', { targets: [target('near-usdc')] }, '/rebalancing/targets/0/asset', 'must be an asset on Base or Solana: 1Click delivers refills there, and not on Tempo'],
    ['a target on Tempo', { targets: [target('tempo-pathusd')] }, '/rebalancing/targets/0/asset', 'must be an asset on Base or Solana: 1Click delivers refills there, and not on Tempo'],
    ['a target listed twice', { targets: [target('base-usdc'), target('base-usdc', '1', '2')] }, '/rebalancing/targets/1/asset', 'duplicate target asset "base-usdc"'],
    ['a Base target on another blockchain', { targets: [target('base-usdc', '5', '10', 'arb')] }, '/rebalancing/targets/0/blockchain', 'must be "base", 1Click\'s name for the asset\'s chain'],
    ['a Solana target named as the chain is', { targets: [target('solana-usdc', '3', '6', 'solana')] }, '/rebalancing/targets/0/blockchain', 'must be "sol", 1Click\'s name for the asset\'s chain'],
    ['a Solana target on Base', { targets: [target('solana-usdc', '3', '6', 'base')] }, '/rebalancing/targets/0/blockchain', 'must be "sol", 1Click\'s name for the asset\'s chain'],
    ['a floor equal to its target', { targets: [target('base-usdc', '10', '10')] }, '/rebalancing/targets/0/floor', 'must be less than target (10 USD)'],
    ['a floor above its target', { targets: [target('base-usdc', '10.000001', '10')] }, '/rebalancing/targets/0/floor', 'must be less than target (10 USD)'],
    ['a least per refill of 0', { leastPerRefill: '0' }, '/rebalancing/leastPerRefill', 'must be more than 0'],
    ['a least above the most per refill', { leastPerRefill: '10.000001' }, '/rebalancing/mostPerRefill', 'must be at least leastPerRefill (10.000001 USD)'],
    ['a most per refill above the most per day', { mostPerRefill: '20.000001', mostPerAssetPerDay: '20' }, '/rebalancing/mostPerAssetPerDay', 'must be at least mostPerRefill (20.000001 USD)'],
    ['a most per refill above the default most per day', { mostPerRefill: '21', mostPerAssetPerDay: undefined }, '/rebalancing/mostPerAssetPerDay', 'must be at least mostPerRefill (21 USD)'],
    ['a target that overflows', { targets: [target('base-usdc', '1', '99999999999999')] }, '/rebalancing/targets/0/target', 'The USD amount is too large'],
  ])('refuse %s, even while off', (_name, changes, path, message) => {
    expect(issues(() => buildPlatformConfig(document({ rebalancing: { ...changes, enabled: false } })))).toEqual([{ path, message }]);
    expect(issues(() => buildPlatformConfig(on(changes)))).toContainEqual({ path, message });
  });

  it.each([
    ['a fee bound above 10%', { maxFeeBps: 1_001 }, '/rebalancing/maxFeeBps', 'must be at most 1000'],
    ['a negative fee bound', { maxFeeBps: -1 }, '/rebalancing/maxFeeBps', 'must be at least 0'],
    ['a slippage above 5%', { slippageBps: 501 }, '/rebalancing/slippageBps', 'must be at most 500'],
    ['a deadline under 5 minutes', { deadlineMinutes: 4 }, '/rebalancing/deadlineMinutes', 'must be at least 5'],
    ['a deadline over 4 hours', { deadlineMinutes: 241 }, '/rebalancing/deadlineMinutes', 'must be at most 240'],
    ['an interval under a minute', { intervalSeconds: 59 }, '/rebalancing/intervalSeconds', 'must be at least 60'],
    ['an interval over a day', { intervalSeconds: 86_401 }, '/rebalancing/intervalSeconds', 'must be at most 86400'],
    ['a fractional interval', { intervalSeconds: 300.5 }, '/rebalancing/intervalSeconds', 'must be an integer'],
    ['a numeric amount', { mostPerRefill: 10 }, '/rebalancing/mostPerRefill', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['a source name with capitals', { source: 'NEAR-USDC' }, '/rebalancing/source', 'must be lowercase letters and digits separated by single hyphens, such as base-usdc'],
    ['a target without a floor', { targets: [{ asset: 'base-usdc', blockchain: 'base', target: '10' }] }, '/rebalancing/targets/0', 'missing required field "floor"'],
    ['a target with a numeric floor', { targets: [{ asset: 'base-usdc', blockchain: 'base', floor: 5, target: '10' }] }, '/rebalancing/targets/0/floor', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['a blockchain with capitals', { targets: [{ asset: 'base-usdc', blockchain: 'Base', floor: '5', target: '10' }] }, '/rebalancing/targets/0/blockchain', 'must be 2–32 lowercase letters, digits, or hyphens, starting with a letter, such as base'],
    ['an unknown field', { recipient: 'pay.anyfare.testnet' }, '/rebalancing/recipient', 'unknown field'],
  ])('refuse %s in the schema', (_name, rebalancing, path, message) => {
    expect(issues(() => assertValidPlatformConfigDocument(patch(loadExamplePlatformDocument(), { rebalancing })))).toContainEqual({ path, message });
  });
});

describe('platformSummary', () => {
  it('names the environment, URLs, asset names and networks, and no address', () => {
    const summary = platformSummary(buildPlatformConfig(document()));

    expect(summary).toEqual({
      environment: 'staging',
      urls: { website: 'https://anyfare.test', api: 'https://api.anyfare.test', pay: 'https://pay.anyfare.test', console: 'https://console.anyfare.test' },
      assets: [
        { name: 'base-usdc', network: 'eip155:84532' },
        { name: 'solana-usdc', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
        { name: 'tempo-pathusd', network: 'eip155:42431' },
        { name: 'near-usdc', network: 'near:testnet' },
      ],
      rails: {
        credits: true,
        x402: [
          { facilitator: 'cdp', networks: ['eip155:84532', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'] },
          { facilitator: 'near', networks: ['near:testnet'] },
        ],
        mpp: { network: 'eip155:42431' },
      },
      fees: { routingFeeBps: 0 },
      freeCredits: { enabled: false, amount: '0.1' },
      topups: { enabled: false, networks: ['base', 'arbitrum', 'solana', 'near', 'ethereum', 'bitcoin'] },
    });
    expect(JSON.stringify(summary)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it('says whether the sign-up gift is on, and its amount as a USD string', () => {
    const summary = platformSummary(buildPlatformConfig(document({ freeCredits: { enabled: true, amount: '0.25', maxPerDay: '5' } })));

    expect(summary.freeCredits).toEqual({ enabled: true, amount: '0.25' });
  });

  it('leaves out a disabled facilitator and a disabled MPP', () => {
    const value = loadExamplePlatformDocument() as MutableDocument;
    value.facilitators[0]!['enabled'] = false;
    const summary = platformSummary(buildPlatformConfig(patch(value, { mpp: { enabled: false } }) as never));

    expect(summary.rails).toEqual({ credits: true, x402: [{ facilitator: 'near', networks: ['near:testnet'] }], mpp: false });
  });
});

describe('assertValidPlatformConfigDocument', () => {
  it.each([
    ['an unknown field', { colour: 'blue' }, '/colour', 'unknown field'],
    ['a missing field', { keyPrefixes: undefined }, '', 'missing required field "keyPrefixes"'],
    ['an unknown version', { version: 2 }, '/version', 'must be 1'],
    ['a URL with a path', { urls: { api: 'https://api.anyfare.test/v1' } }, '/urls/api', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['an HTTP origin', { urls: { pay: 'http://pay.anyfare.test' } }, '/urls/pay', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['a console URL with a trailing slash', { urls: { console: 'https://console.anyfare.test/' } }, '/urls/console', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['an HTTP console origin', { urls: { console: 'http://console.anyfare.test' } }, '/urls/console', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['a console origin with capitals', { urls: { console: 'https://Console.anyfare.test' } }, '/urls/console', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['a console host without a scheme', { urls: { console: 'console.anyfare.test' } }, '/urls/console', 'must be an HTTPS origin, such as https://example.com, without a path or a trailing slash'],
    ['a key prefix with capitals', { keyPrefixes: { master: 'AFM_' } }, '/keyPrefixes/master', 'must be 2–32 lowercase letters, digits, or underscores, such as af_live_'],
    ['a numeric amount', { paymentKeyDefaults: { dailyBudget: 5 } }, '/paymentKeyDefaults/dailyBudget', 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"'],
    ['an empty asset registry', { assets: [] }, '/assets', 'must have at least 1 item'],
    ['an unknown peg', { assets: [{ name: 'x', network: 'eip155:84532', address: '0x0', decimals: 6, peg: 'eur', payTo: '0x0' }] }, '/assets/0/peg', 'must be "usd"'],
    ['a numeric payTo', { assets: [{ name: 'x', network: 'eip155:84532', address: '0x0', decimals: 6, peg: 'usd', payTo: 1 }] }, '/assets/0/payTo', 'must be a string: put the address in quotes, since YAML reads an unquoted 0x… as a number'],
    ['an unknown log level', { logger: { level: 'verbose' } }, '/logger/level', 'must be one of: "trace", "debug", "info", "warn", "error", "fatal"'],
    ['a missing signup rate limit', { rateLimits: { signup: undefined } }, '/rateLimits', 'missing required field "signup"'],
    ['a removed section', { feeBps: 100 }, '/feeBps', 'unknown field'],
    ['a secret value instead of its name', { facilitators: [{ name: 'x', url: 'https://x.example.com', networks: ['eip155:84532'], auth: { type: 'cdp', apiKeyId: 'CDP_API_KEY_ID', apiKeySecret: 'hunter2' } }] }, '/facilitators/0/auth/apiKeySecret', 'must name the environment variable that holds the secret, such as CDP_API_KEY_SECRET. Never put the value here'],
    ['an API key value instead of its name', { facilitators: [{ name: 'x', url: 'https://x.example.com', networks: ['near:testnet'], auth: { type: 'api-key', apiKey: 'hunter2' } }] }, '/facilitators/0/auth/apiKey', 'must name the environment variable that holds the secret, such as CDP_API_KEY_SECRET. Never put the value here'],
    ['an API key auth without its key', { facilitators: [{ name: 'x', url: 'https://x.example.com', networks: ['near:testnet'], auth: { type: 'api-key' } }] }, '/facilitators/0/auth', 'missing required field "apiKey"'],
    ['an unknown auth type', { facilitators: [{ name: 'x', url: 'https://x.example.com', networks: ['near:testnet'], auth: { type: 'basic', apiKey: 'X' } }] }, '/facilitators/0/auth/type', 'must be one of: "cdp", "api-key"'],
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
