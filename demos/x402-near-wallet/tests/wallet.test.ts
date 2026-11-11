// Every key here is made in the test, in memory, and holds nothing. Accounts are made up.

import { generateKeyPairSync } from 'node:crypto';
import { NEAR_RPC_URLS } from '@x402/near';
import { describe, expect, it } from 'vitest';
import { Stop } from '../src/util.ts';
import { NEAR_EXPLORER, isNearAccountId, readNearAccount, readNearWallet, readRpcUrl } from '../src/wallet.ts';
import { base58 } from './fakeNearRpc.ts';

function testKey(): { readonly secretKey: string; readonly seedOnly: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  return { secretKey: `ed25519:${base58(Buffer.concat([seed, pub]))}`, seedOnly: `ed25519:${base58(seed)}` };
}

const { secretKey, seedOnly } = testKey();
const ACCOUNT = 'alice.near';

function stopOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Stop);
    return (error as Stop).message;
  }
  throw new Error('Expected a Stop');
}

describe('isNearAccountId', () => {
  it('takes named and implicit accounts', () => {
    for (const id of ['alice.near', 'a.b.c', 'my-account_1.testnet', 'ab', 'a'.repeat(64), '0123456789abcdef'.repeat(4)]) {
      expect(isNearAccountId(id), id).toBe(true);
    }
  });

  it('refuses other shapes', () => {
    for (const id of ['', 'a', 'Alice.near', 'alice..near', '.alice', 'alice.', '-alice', 'alice-', 'al ice', 'alice@near', 'a'.repeat(65)]) {
      expect(isNearAccountId(id), id).toBe(false);
    }
  });
});

describe('readRpcUrl', () => {
  it('defaults to the SDK mainnet RPC', () => {
    expect(readRpcUrl({})).toMatchObject({ url: NEAR_RPC_URLS['near:mainnet'], own: false });
    expect(readRpcUrl({ NEAR_RPC_URL: '  ' }).own).toBe(false);
  });

  it('takes https, and http to 127.0.0.1 or localhost', () => {
    expect(readRpcUrl({ NEAR_RPC_URL: 'https://rpc.example/v1?k=made-up' })).toMatchObject({ host: 'rpc.example', own: true });
    expect(readRpcUrl({ NEAR_RPC_URL: 'http://127.0.0.1:3030' }).host).toBe('127.0.0.1:3030');
    expect(readRpcUrl({ NEAR_RPC_URL: 'http://localhost:3030' }).host).toBe('localhost:3030');
  });

  it('refuses http elsewhere, other schemes and text that is no URL', () => {
    for (const bad of ['http://rpc.example', 'ftp://rpc.example', 'rpc.example', 'http://127.0.0.1.example.com']) {
      expect(stopOf(() => readRpcUrl({ NEAR_RPC_URL: bad })), bad).toContain('NEAR_RPC_URL must be an https:// URL');
    }
  });

  it('refuses a user name or a password, and does not quote them', () => {
    for (const bad of ['https://made-up-name@rpc.example', 'https://made-up-name:made-up-secret@rpc.example']) {
      const line = stopOf(() => readRpcUrl({ NEAR_RPC_URL: bad }));
      expect(line).toContain('NEAR_RPC_URL');
      expect(line).not.toContain('made-up-secret');
      expect(line).not.toContain('made-up-name');
    }
  });
});

describe('readNearAccount', () => {
  it('works with no key set, and does not look at one', () => {
    expect(readNearAccount({ NEAR_ACCOUNT_ID: ACCOUNT })).toMatchObject({ accountId: ACCOUNT, rpc: { url: NEAR_RPC_URLS['near:mainnet'] } });
    expect(readNearAccount({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: 'garbage' }).accountId).toBe(ACCOUNT);
  });

  it('names a missing or bad NEAR_ACCOUNT_ID', () => {
    expect(stopOf(() => readNearAccount({}))).toBe('NEAR_ACCOUNT_ID is not set. Set it in .env.local or the shell, such as NEAR_ACCOUNT_ID=alice.near');
    expect(stopOf(() => readNearAccount({ NEAR_ACCOUNT_ID: '  ' }))).toContain('NEAR_ACCOUNT_ID is not set');
    expect(stopOf(() => readNearAccount({ NEAR_ACCOUNT_ID: 'Alice.NEAR' }))).toContain('NEAR_ACCOUNT_ID is not a NEAR account ID');
  });

  it('refuses a bad NEAR_RPC_URL', () => {
    expect(stopOf(() => readNearAccount({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_RPC_URL: 'http://rpc.example' }))).toContain('NEAR_RPC_URL');
  });
});

describe('readNearWallet', () => {
  it('takes a key of 64 bytes and one of 32', () => {
    for (const key of [secretKey, seedOnly]) {
      const wallet = readNearWallet({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: key });
      expect(wallet.accountId).toBe(ACCOUNT);
      expect(wallet.rpc.host).toBe(new URL(NEAR_RPC_URLS['near:mainnet']).host);
    }
  });

  it('makes the signer only when it is asked for', () => {
    const wallet = readNearWallet({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: secretKey });
    expect(typeof wallet.signer).toBe('function');
    expect(typeof wallet.signer().createSignedDelegateAction).toBe('function');
  });

  it('refuses a missing key by the variable name', () => {
    expect(stopOf(() => readNearWallet({ NEAR_ACCOUNT_ID: ACCOUNT }))).toContain('NEAR_PRIVATE_KEY is not set');
  });

  it('refuses a bad key with a line that does not hold it', () => {
    const body = secretKey.slice('ed25519:'.length);
    const bads = [
      `secp256k1:${body}`,
      body,
      'ed25519:',
      `ed25519:${body.slice(0, 20)}`,
      `ed25519:${body}0OIl`,
      `ed25519:${'1'.repeat(33)}`,
    ];
    for (const bad of bads) {
      const line = stopOf(() => readNearWallet({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: bad }));
      expect(line).toContain('NEAR_PRIVATE_KEY is not a NEAR private key');
      expect(line).not.toContain(body);
      expect(line).not.toContain(body.slice(0, 10));
    }
  });
});

describe('NEAR_EXPLORER', () => {
  it('links an address and a transaction, and knows the shape of a hash', () => {
    expect(NEAR_EXPLORER.address(ACCOUNT)).toBe('https://nearblocks.io/address/alice.near');
    expect(NEAR_EXPLORER.transaction('abc')).toBe('https://nearblocks.io/txns/abc');
    expect(NEAR_EXPLORER.hash.test(base58(new Uint8Array(32).fill(7)))).toBe(true);
    expect(NEAR_EXPLORER.hash.test('0x1234')).toBe(false);
  });
});
