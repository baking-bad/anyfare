import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadPlatformConfig, platformSummary } from '../../src/index.js';

// config/production.yaml: mainnets only, with the receiving addresses, the MPP recipient and the hot
// wallets still to be added
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
};

/** The config with a `payTo` added under each asset, after its `peg` line. */
const withPayTo = (yaml: string, payToFor: (asset: string) => string): string => {
  let asset = '';

  return yaml.split('\n').flatMap(line => {
    asset = /^\s+- name: (\S+)/.exec(line)?.[1] ?? asset;

    return /^\s+peg: usd$/.test(line) ? [line, `    payTo: ${payToFor(asset)}`] : [line];
  }).join('\n');
};

describe('config/production.yaml', () => {
  it('loads: mainnets only, live key prefixes, the production URLs, and no receiving addresses yet', async () => {
    const config = await loadText(text);

    expect(config.environment).toBe('production');
    expect(config.assets.map(asset => [asset.name, asset.network.id, asset.decimals, asset.payTo])).toEqual([
      ['base-usdc', 'eip155:8453', 6, undefined],
      ['solana-usdc', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 6, undefined],
      ['tempo-usdce', 'eip155:4217', 6, undefined],
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
    expect(config.routingFeeBps).toBe(0);
    expect(config.sizeLimits).toEqual({ requestBodyBytes: 1_048_576, bufferedResponseBytes: 10_485_760 });
  });

  it('settles x402 through the CDP facilitator on both mainnets, with its key named by environment variable', async () => {
    const config = await loadText(text);

    expect(config.facilitators).toEqual([{
      name: 'cdp',
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      networks: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      auth: { type: 'cdp', apiKeyId: 'CDP_API_KEY_ID', apiKeySecret: 'CDP_API_KEY_SECRET' },
      enabled: true,
    }]);
  });

  it('has MPP on Tempo with no recipient yet, so it is not offered', async () => {
    const config = await loadText(text);

    expect(config.mpp).toMatchObject({ network: { id: 'eip155:4217', chain: 'tempo', testnet: false }, recipient: undefined, enabled: true, rpcUrl: undefined });
    expect(platformSummary(config).rails).toEqual({
      credits: true,
      x402: [{ facilitator: 'cdp', networks: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] }],
      mpp: false,
    });
  });

  it('offers MPP once the recipient and the Tempo asset\'s payTo are added', async () => {
    const recipient = '"0x2222222222222222222222222222222222222222"';
    const config = await loadText(withPayTo(text, asset => samples[asset]!).replace('\nmpp:\n  network: eip155:4217\n', `\nmpp:\n  network: eip155:4217\n  recipient: ${recipient}\n`));

    expect(config.mpp.recipient).toBe('0x2222222222222222222222222222222222222222');
    expect(platformSummary(config).rails.mpp).toEqual({ network: 'eip155:4217' });
  });

  it('caps what one routed call and one network can cost us, and has no hot wallet yet', async () => {
    const config = await loadText(text);

    expect(config.signer).toEqual({
      maxPerCall: 100_000n,
      maxPerNetworkPerHour: 5_000_000n,
      maxPerNetworkPerDay: 20_000_000n,
      wallets: { base: undefined, tempo: undefined, solana: undefined },
    });
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
    ]);
  });
});
