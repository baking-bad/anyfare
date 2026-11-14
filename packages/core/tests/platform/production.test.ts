import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findAsset, loadPlatformConfig, paymentMethodsFor, platformSummary, treasuryWallets } from '../../src/index.js';

// config/production.yaml: mainnets only. On each chain our receiving address is the Signer's hot wallet
// too: pay.anyfare.near on NEAR, one EVM address on Base and Tempo (the MPP recipient), one on Solana
const evmWallet = '0xf82B4B95a063CFd5F56B3395978d02278E583550';
const solanaWallet = 'AzG7Gmu8t6r54JbdAxZBNHNvCzbf5QDZcdKe7Aho78Xj';
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
  // A Tempo asset's payTo is the MPP recipient
  'tempo-usdce': `"${evmWallet}"`,
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
  it('loads: mainnets only, live key prefixes, the production URLs, and a receiving address on each chain', async () => {
    const config = await loadText(text);

    expect(config.environment).toBe('production');
    expect(config.assets.map(asset => [asset.name, asset.network.id, asset.decimals, asset.payTo])).toEqual([
      ['base-usdc', 'eip155:8453', 6, evmWallet],
      ['solana-usdc', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 6, solanaWallet],
      ['tempo-usdce', 'eip155:4217', 6, evmWallet],
      ['near-usdc', 'near:mainnet', 6, 'pay.anyfare.near'],
    ]);
    expect(config.keyPrefixes).toEqual({ master: 'afm_live_', payment: 'af_live_' });
    expect(config.urls).toEqual({
      website: 'https://anyfare.agents.bakingbad.dev',
      api: 'https://api.anyfare.agents.bakingbad.dev',
      pay: 'https://pay.anyfare.agents.bakingbad.dev',
      console: 'https://console.anyfare.agents.bakingbad.dev',
    });
    expect(config.ownHosts).toContain('console.anyfare.agents.bakingbad.dev');
    expect(config.rateLimits.signup).toEqual({ requests: 200, windowSeconds: 3600 });
    expect(config.rateLimits.paymentKey).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.rateLimits.unpaidIp).toEqual({ requests: 60, windowSeconds: 60 });
    expect(config.rateLimits.documents).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.rateLimits.probeIp).toEqual({ requests: 600, windowSeconds: 60 });
    expect(config.rateLimits.publicReads).toEqual({ requests: 300, windowSeconds: 60 });
    expect(config.callStream).toEqual({ maxPerIp: 200, maxTotal: 1_000 });
    expect(config.routingFeeBps).toBe(0);
    expect(config.sizeLimits).toEqual({ requestBodyBytes: 1_048_576, bufferedResponseBytes: 10_485_760 });
  });

  it('settles Base and Solana through the CDP facilitator and NEAR through our own, with keys named by environment variable', async () => {
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

  it('offers every rail: Credits, x402 on Base, Solana and NEAR, and MPP on Tempo paid to our EVM address', async () => {
    const config = await loadText(text);

    expect(config.mpp).toMatchObject({ network: { id: 'eip155:4217', chain: 'tempo', testnet: false }, recipient: evmWallet, enabled: true, rpcUrl: undefined });
    expect(platformSummary(config).rails).toEqual({
      credits: true,
      x402: [
        { facilitator: 'cdp', networks: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] },
        { facilitator: 'near', networks: ['near:mainnet'] },
      ],
      mpp: { network: 'eip155:4217' },
    });
    expect(paymentMethodsFor(1_000n, config)).toEqual(['credits', 'x402', 'mpp']);
  });

  it('takes top-ups: any token on six networks, swapped to USDC on NEAR and delivered to the treasury, refunds held for it', async () => {
    const { topups } = await loadText(text);

    expect(topups).toMatchObject({ enabled: true, recipient: 'treasury.anyfare.near', refundTo: 'treasury.anyfare.near', apiKey: undefined });
    expect(topups.asset).toMatchObject({ name: 'near-usdc', network: { id: 'near:mainnet' } });
    expect(topups.networks.map(network => [network.name, network.blockchain, network.minimum])).toEqual([
      ['base', 'base', 1_000_000n], ['arbitrum', 'arb', 1_000_000n], ['solana', 'sol', 1_000_000n], ['near', 'near', 1_000_000n],
      ['ethereum', 'eth', 5_000_000n], ['bitcoin', 'btc', 10_000_000n],
    ]);
  });

  it('has rebalancing off, paid with near-usdc, refilling the Base and Solana hot wallets within $1 to $10 a refill and $20 a day each', async () => {
    const config = await loadText(text);
    const { rebalancing } = config;

    expect(rebalancing).toMatchObject({
      enabled: false, sourceFloor: 1_000_000n, leastPerRefill: 1_000_000n, mostPerRefill: 10_000_000n, mostPerAssetPerDay: 20_000_000n, maxFeeBps: 200, slippageBps: 50,
      deadlineMinutes: 30, intervalSeconds: 300,
    });
    expect(rebalancing.source).toBe(findAsset(config, 'near-usdc'));
    expect(rebalancing.targets.map(target => [target.asset.name, target.asset.network.id, target.blockchain, target.floor, target.target])).toEqual([
      ['base-usdc', 'eip155:8453', 'base', 5_000_000n, 10_000_000n],
      ['solana-usdc', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'sol', 3_000_000n, 6_000_000n],
    ]);
    // Turned on, it needs nothing more: the Signer's wallets on NEAR, Base and Solana are named, and 1Click is at the default URL
    const on = await loadText(text.replace('rebalancing:\n  enabled: false', 'rebalancing:\n  enabled: true'));
    expect(on.rebalancing.enabled).toBe(true);
    expect(on.topups.url).toBe('https://1click.chaindefuser.com');
  });

  it('caps what one routed call and one network can cost us, and lists each hot wallet once, as the payTo it is', async () => {
    const config = await loadText(text);

    expect(config.signer).toEqual({
      maxPerCall: 100_000n,
      maxPerNetworkPerHour: 5_000_000n,
      maxPerNetworkPerDay: 20_000_000n,
      wallets: { base: evmWallet, tempo: evmWallet, solana: solanaWallet, near: 'pay.anyfare.near' },
    });
    // Each hot wallet is the address buyers pay on its chain: the treasury lists it once, noted as the
    // Signer's, so its balance is counted once. The top-up recipient is watched too.
    expect(treasuryWallets(config).map(wallet => [wallet.name, wallet.role, wallet.signer, wallet.addresses])).toEqual([
      ['payTo:base-usdc', 'pay_to', 'signer:base', [evmWallet]],
      ['payTo:solana-usdc', 'pay_to', 'signer:solana', [solanaWallet]],
      ['payTo:tempo-usdce', 'pay_to', 'signer:tempo', [evmWallet]],
      ['payTo:near-usdc', 'pay_to', 'signer:near', ['pay.anyfare.near']],
      ['treasury:near', 'treasury', undefined, ['treasury.anyfare.near']],
    ]);
  });

  it('has the sign-up gift on, at $0.10 for three new accounts a day per client IP, with a daily cap of $5', async () => {
    const config = await loadText(text);

    expect(config.freeCredits).toEqual({ enabled: true, amount: 100_000n, perIp: { requests: 3, windowSeconds: 86_400 }, maxPerDay: 5_000_000n });
    expect(platformSummary(config).freeCredits).toEqual({ enabled: true, amount: '0.1' });
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
      evmWallet,
      'pay.anyfare.testnet',
    ]);
  });

  it('offers USDC on NEAR mainnet at its contract, paid to pay.anyfare.near', async () => {
    const config = await loadText(text);

    expect(findAsset(config, 'near-usdc')).toMatchObject({
      network: { id: 'near:mainnet', namespace: 'near', testnet: false }, address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6,
      payTo: 'pay.anyfare.near',
    });
  });

  it('keeps Base\'s and Solana\'s hot wallets apart from their payTo when they differ, so each balance is watched', async () => {
    // Made-up hot wallets, other than the payTo addresses
    const wallets = text.replace(`    base: "${evmWallet}"\n`, '    base: "0x3333333333333333333333333333333333333333"\n')
      .replace(`    solana: ${solanaWallet}\n`, '    solana: "11111111111111111111111111111111"\n');
    const config = await loadText(wallets);

    expect(treasuryWallets(config).map(wallet => [wallet.name, wallet.signer, wallet.addresses])).toEqual([
      ['payTo:base-usdc', undefined, [evmWallet]],
      ['payTo:solana-usdc', undefined, [solanaWallet]],
      ['payTo:tempo-usdce', 'signer:tempo', [evmWallet]],
      ['payTo:near-usdc', 'signer:near', ['pay.anyfare.near']],
      ['signer:base', undefined, ['0x3333333333333333333333333333333333333333']],
      ['signer:solana', undefined, ['11111111111111111111111111111111']],
      ['treasury:near', undefined, ['treasury.anyfare.near']],
    ]);
  });
});
