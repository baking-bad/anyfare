import { generateKeyPairSync } from 'node:crypto';

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { loadPlatformConfig } from '@anyfare/core';
import { encodeBase58 } from '@anyfare/testing';

import { readSolanaWallet, readWallet } from '../src/start.js';

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
