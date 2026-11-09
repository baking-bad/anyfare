import { generateKeyPairSync } from 'node:crypto';

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { loadPlatformConfig } from '@anyfare/core';
import { encodeBase58, generateNearKey } from '@anyfare/testing';

import { readNearWallet, readSolanaWallet, readWallet } from '../src/start.js';

const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });

/** A Solana secret key as its 64 bytes, the seed then the public key, made in the test. */
const solanaKeyBytes = (): Uint8Array => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

  return Uint8Array.from([...seed, ...raw]);
};

describe('reading the hot wallets\' keys', () => {
  it.each(['SIGNER_BASE_KEY', 'SIGNER_TEMPO_KEY'] as const)('takes %s out of the environment once it has read it', name => {
    const key = generatePrivateKey();
    const env: Record<string, string | undefined> = { [name]: key, OTHER: 'stays' };

    expect(readWallet(env, name)?.address).toBe(privateKeyToAccount(key).address);
    expect(env).toEqual({ OTHER: 'stays' });
  });

  it('takes a key out of the environment when it isn\'t one too', () => {
    const env: Record<string, string | undefined> = { SIGNER_BASE_KEY: '0x12' };

    expect(() => readWallet(env, 'SIGNER_BASE_KEY')).toThrow('SIGNER_BASE_KEY must be 0x and 64 hex characters');
    expect(env['SIGNER_BASE_KEY']).toBeUndefined();
  });

  it.each([
    ['SIGNER_BASE_KEY', 'signer.wallets.base'],
    ['SIGNER_TEMPO_KEY', 'signer.wallets.tempo'],
  ] as const)('refuses %s when its address isn\'t %s, and takes it out of the environment', (name, wallet) => {
    const key = generatePrivateKey();
    const configured = privateKeyToAccount(generatePrivateKey()).address;
    const env: Record<string, string | undefined> = { [name]: key };

    expect(() => readWallet(env, name, configured))
      .toThrow(`${name}'s address, ${privateKeyToAccount(key).address}, isn't ${wallet}, ${configured}`);
    expect(env[name]).toBeUndefined();
  });

  it('takes a key whose address is the configured wallet, in any letter case', () => {
    const key = generatePrivateKey();
    const { address } = privateKeyToAccount(key);

    expect(readWallet({ SIGNER_BASE_KEY: key }, 'SIGNER_BASE_KEY', address.toLowerCase())?.address).toBe(address);
    expect(readWallet({ SIGNER_TEMPO_KEY: key }, 'SIGNER_TEMPO_KEY', address)?.address).toBe(address);
  });

  it('reads no wallet when the key isn\'t set', () => {
    expect(readWallet({}, 'SIGNER_BASE_KEY')).toBeUndefined();
    expect(readWallet({ SIGNER_TEMPO_KEY: ' ' }, 'SIGNER_TEMPO_KEY')).toBeUndefined();
  });

  it.each([
    ['base58', (bytes: Uint8Array) => encodeBase58(bytes)],
    ['a JSON array', (bytes: Uint8Array) => JSON.stringify([...bytes])],
  ])('takes SIGNER_SOLANA_KEY in %s out of the environment once it has read it', async (_name, write) => {
    const bytes = solanaKeyBytes();
    const env: Record<string, string | undefined> = { SIGNER_SOLANA_KEY: write(bytes) };

    const wallet = await readSolanaWallet(env, config);

    expect(wallet?.address).toBe((await createKeyPairSignerFromBytes(Uint8Array.from(bytes))).address);
    expect(env['SIGNER_SOLANA_KEY']).toBeUndefined();
    expect('SIGNER_SOLANA_KEY' in env).toBe(false);
  });

  it('takes SIGNER_SOLANA_KEY out of the environment when it isn\'t a key too', async () => {
    const env: Record<string, string | undefined> = { SIGNER_SOLANA_KEY: '[1,2,3]' };

    await expect(readSolanaWallet(env, config)).rejects.toThrow(/^SIGNER_SOLANA_KEY must be a 64-byte Solana secret key/);
    expect(env['SIGNER_SOLANA_KEY']).toBeUndefined();
  });
});

describe('reading the NEAR hot wallet', () => {
  const key = generateNearKey();
  const failureOf = (env: Record<string, string | undefined>, using = config): Error | undefined => {
    try {
      readNearWallet(env, using);
    }
    catch (error) {
      return error as Error;
    }

    return undefined;
  };

  it('takes SIGNER_NEAR_KEY out of the environment once it has read it, on the config\'s NEAR network', () => {
    const env: Record<string, string | undefined> = { SIGNER_NEAR_ACCOUNT: 'hot.anyfare.testnet', SIGNER_NEAR_KEY: key.secretKey, OTHER: 'stays' };

    const wallet = readNearWallet(env, config);

    expect(wallet).toMatchObject({ accountId: 'hot.anyfare.testnet', publicKey: key.publicKey, network: { id: 'near:testnet' } });
    expect(wallet?.secretKey.expose()).toBe(key.secretKey);
    expect(JSON.stringify(wallet)).not.toContain(key.secretKey.slice('ed25519:'.length));
    expect(env).toEqual({ SIGNER_NEAR_ACCOUNT: 'hot.anyfare.testnet', OTHER: 'stays' });
  });

  it('reads no wallet when neither variable is set', () => {
    expect(readNearWallet({}, config)).toBeUndefined();
    expect(readNearWallet({ SIGNER_NEAR_ACCOUNT: ' ', SIGNER_NEAR_KEY: '' }, config)).toBeUndefined();
  });

  it.each([
    ['only the account', { SIGNER_NEAR_ACCOUNT: 'hot.anyfare.testnet', SIGNER_NEAR_KEY: '' }],
    ['only the key', { SIGNER_NEAR_KEY: generateNearKey().secretKey }],
  ])('refuses %s', (_name, env) => {
    expect(failureOf(env)?.message).toBe('SIGNER_NEAR_ACCOUNT and SIGNER_NEAR_KEY must be set together, or not at all');
  });

  it.each(['ed25519:abc', 'secp256k1:abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789', 'ed25519:0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl', key.secretKey.slice('ed25519:'.length)])(
    'refuses a key that isn\'t ed25519: and base58, without echoing it, and takes it out of the environment: %s',
    invalid => {
      const env: Record<string, string | undefined> = { SIGNER_NEAR_ACCOUNT: 'hot.anyfare.testnet', SIGNER_NEAR_KEY: invalid };
      const failure = failureOf(env);

      expect(failure?.message).toBe('SIGNER_NEAR_KEY must be ed25519: and a base58 key');
      expect(failure?.message).not.toContain(invalid);
      expect('SIGNER_NEAR_KEY' in env).toBe(false);
    },
  );

  it('refuses an account that isn\'t a NEAR account ID', () => {
    expect(failureOf({ SIGNER_NEAR_ACCOUNT: 'Hot Wallet', SIGNER_NEAR_KEY: key.secretKey })?.message).toBe('SIGNER_NEAR_ACCOUNT must be a NEAR account ID');
  });

  it('refuses an account that isn\'t signer.wallets.near, naming both', async () => {
    const named = await loadPlatformConfig({
      env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ signer: { wallets: { near: 'pay.anyfare.testnet' } } })).toString('base64') },
    });

    expect(failureOf({ SIGNER_NEAR_ACCOUNT: 'hot.anyfare.testnet', SIGNER_NEAR_KEY: key.secretKey }, named)?.message)
      .toBe('SIGNER_NEAR_ACCOUNT, hot.anyfare.testnet, isn\'t signer.wallets.near, pay.anyfare.testnet');
    expect(readNearWallet({ SIGNER_NEAR_ACCOUNT: 'pay.anyfare.testnet', SIGNER_NEAR_KEY: key.secretKey }, named)?.accountId).toBe('pay.anyfare.testnet');
  });

  it('refuses a NEAR key when the config has no NEAR asset', () => {
    const withoutNear = { ...config, assets: config.assets.filter(asset => asset.network.namespace !== 'near') };

    expect(failureOf({ SIGNER_NEAR_ACCOUNT: 'hot.anyfare.testnet', SIGNER_NEAR_KEY: key.secretKey }, withoutNear)?.message)
      .toBe('SIGNER_NEAR_KEY is set, but the platform config has no NEAR asset to pay in');
  });
});
