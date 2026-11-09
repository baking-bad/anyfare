import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findAsset, loadPlatformConfig, paymentMethodsFor, platformSummary, treasuryWallets } from '../../src/index.js';

// config/production.yaml: mainnets only. NEAR's receiving address and hot wallet are ours,
// pay.anyfare.near; the other receiving addresses, the MPP recipient and the other hot wallets are still
// to be added
const productionConfigPath = fileURLToPath(new URL('../../../../config/production.yaml', import.meta.url));

let directory: string;
let text: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'anyfare-production-config-'));
  text = await readFile(productionConfigPath, 'utf8');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const loadText = async (yaml: string) => {
  await writeFile(path.join(directory, 'production.yaml'), yaml);

  return loadPlatformConfig({ env: { CONFIG_PATH: 'production.yaml' }, cwd: directory });
};

const samples: Readonly<Record<string, string>> = {
  'base-usdc': '"0x1111111111111111111111111111111111111111"',
  'solana-usdc': '"11111111111111111111111111111111"',
  'tempo-usdce': '"0x2222222222222222222222222222222222222222"',
  'near-usdc': 'pay.anyfare.testnet',
};

/** The config with its own `payTo` lines removed, and one added under each asset it names one for, after its `peg` line. */
const withPayTo = (yaml: string, payToFor: (asset: string) => string | undefined): string => {
  let asset = '';

  return yaml.split('\n').flatMap(line => {
    asset = /^\s+- name: (\S+)/.exec(line)?.[1] ?? asset;
    const payTo = payToFor(asset);
    if (/^\s+payTo: /.test(line))
      return [];

    return /^\s+peg: usd$/.test(line) && payTo !== undefined ? [line, `    payTo: ${payTo}`] : [line];
  }).join('\n');
};

describe('config/production.yaml', () => {
  it('loads: mainnets only, live key prefixes, the production URLs, and NEAR\'s receiving address alone', async () => {
    const config = await loadText(text);

    expect(config.environment).toBe('production');
    expect(config.assets.map(asset => [asset.name, asset.network.id, asset.decimals, asset.payTo])).toEqual([
      ['base-usdc', 'eip155:8453', 6, undefined],
      ['solana-usdc', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 6, undefined],
      ['tempo-usdce', 'eip155:4217', 6, undefined],
      ['near-usdc', 'near:mainnet', 6, 'pay.anyfare.near'],
    ]);
    expect(config.keyPrefixes).toEqual({ master: 'afm_live_', payment: 'af_live_' });
    expect(config.urls).toEqual({
      website: 'https://anyfare.agents.bakingbad.dev',
      api: 'https://api.anyfare.agents.bakingbad.dev',
      pay: 'https://pay.anyfare.agents.bakingbad.dev',
    });
    expect(config.rateLimits.signup).toEqual({ requests: 200, windowSeconds: 3600 });
    expect(config.rateLimits.paymentKey).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.rateLimits.unpaidIp).toEqual({ requests: 60, windowSeconds: 60 });
    expect(config.rateLimits.documents).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.rateLimits.probeIp).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.routingFeeBps).toBe(0);
    expect(config.sizeLimits).toEqual({ requestBodyBytes: 1_048_576, bufferedResponseBytes: 10_485_760 });
  });

  it('settles x402 through the CDP facilitator on both mainnets and our own on NEAR, with keys named by environment variable', async () => {
    const config = await loadText(text);

    expect(config.facilitators).toEqual([{
      name: 'cdp',
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      networks: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      auth: { type: 'cdp', apiKeyId: 'CDP_API_KEY_ID', apiKeySecret: 'CDP_API_KEY_SECRET' },
      enabled: true,
    }, {
      name: 'near',
      url: 'http://facilitator:8084',
      networks: ['near:mainnet'],
      auth: { type: 'api-key', apiKey: 'FACILITATOR_SECRET' },
      enabled: true,
    }]);
  });

  it('has MPP on Tempo with no recipient yet, so it is not offered', async () => {
    const config = await loadText(text);

    expect(config.mpp).toMatchObject({ network: { id: 'eip155:4217', chain: 'tempo', testnet: false }, recipient: undefined, enabled: true, rpcUrl: undefined });
    expect(platformSummary(config).rails).toEqual({
      credits: true,
      x402: [
        { facilitator: 'cdp', networks: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] },
        { facilitator: 'near', networks: ['near:mainnet'] },
      ],
      mpp: false,
    });
  });

  it('offers MPP once the recipient and the Tempo asset\'s payTo are added', async () => {
    const recipient = '"0x2222222222222222222222222222222222222222"';
    const config = await loadText(withPayTo(text, asset => samples[asset]!).replace('\nmpp:\n  network: eip155:4217\n', `\nmpp:\n  network: eip155:4217\n  recipient: ${recipient}\n`));

    expect(config.mpp.recipient).toBe('0x2222222222222222222222222222222222222222');
    expect(platformSummary(config).rails.mpp).toEqual({ network: 'eip155:4217' });
  });

  it('caps what one routed call and one network can cost us, and names the NEAR hot wallet alone', async () => {
    const config = await loadText(text);

    expect(config.signer).toEqual({
      maxPerCall: 100_000n,
      maxPerNetworkPerHour: 5_000_000n,
      maxPerNetworkPerDay: 20_000_000n,
      wallets: { base: undefined, tempo: undefined, solana: undefined, near: 'pay.anyfare.near' },
    });
    // The NEAR hot wallet is the account buyers pay there: the treasury lists it once, noted as the Signer's
    expect(treasuryWallets(config).map(wallet => [wallet.name, wallet.role, wallet.signer, wallet.addresses])).toEqual([
      ['payTo:near-usdc', 'pay_to', 'signer:near', ['pay.anyfare.near']],
    ]);
  });

  it('refuses an unquoted 0x… address, which YAML reads as a number, and says to quote it', async () => {
    const unquoted = withPayTo(text, () => '0x4444444444444444444444444444444444444444');

    await expect(loadText(unquoted)).rejects.toThrow(/assets\/0\/payTo: must be a string: put the address in quotes, since YAML reads an unquoted 0x… as a number/);
  });

  it('keeps valid addresses added as payTo', async () => {
    const config = await loadText(withPayTo(text, asset => samples[asset]!));

    expect(config.assets.map(asset => asset.payTo)).toEqual([
      '0x1111111111111111111111111111111111111111',
      '11111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      'pay.anyfare.testnet',
    ]);
  });

  it('offers USDC on NEAR mainnet to buyers once its payTo is added, alone among the assets, with the Signer\'s hot wallets beside it', async () => {
    // Made-up: our NEAR account, and the hot wallets the deployment adds
    const nearOnly = withPayTo(text, asset => asset === 'near-usdc' ? 'pay.anyfare.test.near' : undefined);
    // The signer section is the file's last, and its wallets block names the NEAR hot wallet alone
    const ownWallets = '  wallets:\n    near: pay.anyfare.near\n';
    const wallets = '  wallets:\n    base: "0x3333333333333333333333333333333333333333"\n    tempo: "0x3333333333333333333333333333333333333333"\n    solana: "11111111111111111111111111111111"\n'
      + '    near: pay.anyfare.test.near\n';
    expect(text.endsWith(ownWallets)).toBe(true);
    const config = await loadText(nearOnly.replace(ownWallets, wallets));

    expect(findAsset(config, 'near-usdc')).toMatchObject({
      network: { id: 'near:mainnet', namespace: 'near', testnet: false }, address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6,
      payTo: 'pay.anyfare.test.near',
    });
    expect(config.assets.filter(asset => asset.payTo !== undefined).map(asset => asset.name)).toEqual(['near-usdc']);
    // Routed endpoints list x402: NEAR's facilitator is ours, and enabled
    expect(paymentMethodsFor(1_000n, config)).toEqual(['credits', 'x402']);
    expect(config.signer.wallets).toEqual({
      base: '0x3333333333333333333333333333333333333333', tempo: '0x3333333333333333333333333333333333333333', solana: '11111111111111111111111111111111',
      near: 'pay.anyfare.test.near',
    });
    // The treasury watches the NEAR payTo, which is the NEAR hot wallet too: one row, so its balance is
    // counted once. The relayer's account isn't in the platform config: the facilitator reports its NEAR.
    expect(treasuryWallets(config).map(wallet => [wallet.name, wallet.role, wallet.signer, wallet.addresses])).toEqual([
      ['payTo:near-usdc', 'pay_to', 'signer:near', ['pay.anyfare.test.near']],
      ['signer:base', 'signer', undefined, ['0x3333333333333333333333333333333333333333']],
      ['signer:tempo', 'signer', undefined, ['0x3333333333333333333333333333333333333333']],
      ['signer:solana', 'signer', undefined, ['11111111111111111111111111111111']],
    ]);
  });
});
