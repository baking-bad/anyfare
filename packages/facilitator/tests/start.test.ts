import { describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@anyfare/common';
import { findNetwork, loadPlatformConfig } from '@anyfare/core';
import { generateNearKey } from '@anyfare/testing';

import { createApp, nearRpcUrlOf, nearSetupOf } from '../src/app.js';
import { InvalidRelayerKeyError } from '../src/relayer.js';
import { readNearRpcUrls, readRecipients, readRelayer } from '../src/start.js';

const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
const testnet = findNetwork('near:testnet')!;
const relayerId = 'relayer.anyfare.testnet';

describe('the platform config\'s NEAR network', () => {
  it('is the network of the NEAR assets, with their token contracts and payTo', () => {
    const asset = config.assets.find(item => item.name === 'near-usdc')!;

    expect(nearSetupOf(config)).toEqual({ network: testnet, assets: [asset.address], payTo: ['pay.anyfare.testnet'] });
  });

  it('must be exactly one', () => {
    const near = config.assets.find(item => item.network.namespace === 'near')!;
    const mainnet = { ...near, name: 'near-mainnet-usdc', network: findNetwork('near:mainnet')! };

    expect(() => nearSetupOf({ assets: config.assets.filter(item => item !== near) })).toThrow('exactly one network, not 0');
    expect(() => nearSetupOf({ assets: [...config.assets, mainnet] })).toThrow('exactly one network, not 2');
  });

  it('has the SDK\'s public RPC unless one is given', () => {
    expect(nearRpcUrlOf('near:testnet')).toBe('https://rpc.testnet.fastnear.com');
    expect(nearRpcUrlOf('near:testnet', { 'near:testnet': 'https://near.rpc.test' })).toBe('https://near.rpc.test');
  });
});

describe('reading the relayer', () => {
  it('takes FACILITATOR_NEAR_KEY out of the environment once it has read it', () => {
    const key = generateNearKey();
    const env: Record<string, string | undefined> = { FACILITATOR_NEAR_ACCOUNT: relayerId, FACILITATOR_NEAR_KEY: key.secretKey, OTHER: 'stays' };

    const relayer = readRelayer(env, testnet);

    expect(relayer.accountId).toBe(relayerId);
    expect(relayer.secretKey.expose()).toBe(key.secretKey);
    expect(env).toEqual({ FACILITATOR_NEAR_ACCOUNT: relayerId, OTHER: 'stays' });
  });

  it.each([
    ['without the curve', (key: string) => key.slice('ed25519:'.length)],
    ['on another curve', (key: string) => key.replace('ed25519:', 'secp256k1:')],
    ['not in base58', (key: string) => `${key.slice(0, -1)}0`],
  ])('refuses a key %s without echoing it, and takes it out of the environment too', (_name, change) => {
    const key = change(generateNearKey().secretKey);
    const env: Record<string, string | undefined> = { FACILITATOR_NEAR_ACCOUNT: relayerId, FACILITATOR_NEAR_KEY: key };

    expect(() => readRelayer(env, testnet)).toThrow(/^FACILITATOR_NEAR_KEY must be ed25519: and a base58 key$/);
    expect('FACILITATOR_NEAR_KEY' in env).toBe(false);
  });

  it('needs the key and a NEAR account ID', () => {
    expect(() => readRelayer({ FACILITATOR_NEAR_ACCOUNT: relayerId }, testnet)).toThrow('Secret FACILITATOR_NEAR_KEY is not set');
    expect(() => readRelayer({ FACILITATOR_NEAR_ACCOUNT: 'Not An Account', FACILITATOR_NEAR_KEY: generateNearKey().secretKey }, testnet))
      .toThrow('FACILITATOR_NEAR_ACCOUNT must be a NEAR account ID');
  });

  it('reports a key the SDK can\'t read as invalid relayer key only', () => {
    // A key made in the test, cut too short for an ed25519 seed
    const key = generateNearKey().secretKey.slice(0, 'ed25519:'.length + 20);
    const create = () => createApp({
      config, logger: createLogger({ level: 'silent' }), secret: undefined, relayer: { accountId: relayerId, secretKey: Secret.from(key) }, recipients: [],
    });

    expect(create).toThrow(InvalidRelayerKeyError);
    try {
      create();
    }
    catch (error) {
      expect(error).toMatchObject({ message: 'invalid relayer key', code: 'invalid_relayer_key' });
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('reading the recipients', () => {
  it('takes FACILITATOR_RECIPIENTS, else the NEAR assets\' payTo', () => {
    expect(readRecipients({ FACILITATOR_RECIPIENTS: ' pay.anyfare.testnet, other.anyfare.testnet,pay.anyfare.testnet ' }, testnet, ['payto.anyfare.testnet']))
      .toEqual(['pay.anyfare.testnet', 'other.anyfare.testnet']);
    expect(readRecipients({}, testnet, ['payto.anyfare.testnet'])).toEqual(['payto.anyfare.testnet']);
    expect(readRecipients({ FACILITATOR_RECIPIENTS: ' ' }, testnet, [])).toEqual([]);
  });

  it('refuses anything that isn\'t a NEAR account ID', () => {
    expect(() => readRecipients({ FACILITATOR_RECIPIENTS: 'pay.anyfare.testnet,Pay Us' }, testnet, []))
      .toThrow('FACILITATOR_RECIPIENTS must be NEAR account IDs, separated by commas');
  });
});

describe('reading NEAR_RPC_URLS', () => {
  it('takes network=URL items for the config\'s NEAR network', () => {
    expect(readNearRpcUrls({ NEAR_RPC_URLS: ' near:testnet=https://near.rpc.test/v1/key ' }, testnet)).toEqual({ 'near:testnet': 'https://near.rpc.test/v1/key' });
    expect(readNearRpcUrls({}, testnet)).toEqual({});
  });

  it('refuses a URL with a username or password, without echoing it', () => {
    for (const value of ['near:testnet=https://user:pass@near.rpc.test', 'near:testnet=https://key@near.rpc.test/v1']) {
      expect(() => readNearRpcUrls({ NEAR_RPC_URLS: value }, testnet))
        .toThrow(/^NEAR_RPC_URLS can't carry a username or password: put a key in the path or the query string$/);
    }
    expect(readNearRpcUrls({ NEAR_RPC_URLS: 'near:testnet=https://near.rpc.test/v1/key?apiKey=other' }, testnet))
      .toEqual({ 'near:testnet': 'https://near.rpc.test/v1/key?apiKey=other' });
  });

  it('refuses another network, or an item that isn\'t one, without echoing it', () => {
    expect(() => readNearRpcUrls({ NEAR_RPC_URLS: 'near:mainnet=https://near.rpc.test' }, testnet))
      .toThrow('NEAR_RPC_URLS names near:mainnet, but the platform config\'s NEAR network is near:testnet');
    for (const value of ['https://near.rpc.test/key', 'near:testnet=ftp://near.rpc.test/key', 'eip155:8453=https://near.rpc.test/key']) {
      expect(() => readNearRpcUrls({ NEAR_RPC_URLS: value }, testnet)).toThrow(/^NEAR_RPC_URLS must be near:<network>=<HTTP\(S\) URL> items, separated by commas$/);
    }
  });
});
