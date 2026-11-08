import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { Secret } from '@anyfare/common';

import {
  encodeBase62, generateApiKey, hashApiKey, isWellFormedKey, keyKindOf, type KeyPrefixes, type RandomSource,
} from '../../src/index.js';

const prefixes: KeyPrefixes = { master: 'afm_test_', payment: 'af_test_' };

// Hands out the given bytes, so a test knows the key in advance
const fixedRandom = (bytes: Uint8Array): RandomSource => ({ bytes: () => Uint8Array.from(bytes) });
const counting = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('generateApiKey', () => {
  it('is the prefix from platform config, then 32 random bytes in 43 base62 characters', () => {
    const master = generateApiKey('master', prefixes).expose();
    const payment = generateApiKey('payment', prefixes).expose();

    expect(master).toMatch(/^afm_test_[0-9A-Za-z]{43}$/);
    expect(payment).toMatch(/^af_test_[0-9A-Za-z]{43}$/);
  });

  it('encodes the bytes from the random source', () => {
    const key = generateApiKey('master', prefixes, fixedRandom(counting));

    expect(key.expose()).toBe('afm_test_003aUlTJC7tjlCTQj2uNU3MFagCXG9LRKRcwGkBIDlf');
  });

  it('differs every time with the default random source', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey('master', prefixes).expose()));

    expect(keys.size).toBe(100);
  });

  it('returns a Secret that prints only the redaction marker', () => {
    const key = generateApiKey('master', prefixes);

    expect(key).toBeInstanceOf(Secret);
    expect(`${String(key)} ${JSON.stringify({ key })} ${inspect(key)}`).not.toContain('afm_test_');
  });

  it('refuses a random source that returns the wrong number of bytes', () => {
    expect(() => generateApiKey('master', prefixes, fixedRandom(new Uint8Array(16)))).toThrow('returned 16 bytes instead of 32');
  });
});

describe('encodeBase62', () => {
  it.each([
    ['zero', new Uint8Array(32), '0'.repeat(43)],
    ['one', Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0), `${'0'.repeat(42)}1`],
    ['the largest value', new Uint8Array(32).fill(0xff), 'yhjskwdA6OZ1AL1YmHWZWm8LLG7HjnuCA2j5rOw8Xp1'],
  ])('encodes %s at a fixed width', (_case, bytes, expected) => {
    expect(encodeBase62(bytes, 43)).toBe(expected);
  });
});

describe('hashApiKey', () => {
  it('is the SHA-256 of the whole key, prefix included, in hex', () => {
    const key = Secret.from('afm_test_003aUlTJC7tjlCTQj2uNU3MFagCXG9LRKRcwGkBIDlf');

    expect(hashApiKey(key)).toBe('9af6aa08d3bbc3c7e899cf92f2f7f067372728d299775882836d77dc2fa42434');
  });

  it('differs for the same body under another prefix', () => {
    const body = '003aUlTJC7tjlCTQj2uNU3MFagCXG9LRKRcwGkBIDlf';

    expect(hashApiKey(Secret.from(`afm_test_${body}`))).not.toBe(hashApiKey(Secret.from(`af_test_${body}`)));
  });
});

describe('key kind from the prefix', () => {
  it('tells the kind from the prefix alone', () => {
    expect(keyKindOf('afm_test_anything', prefixes)).toBe('master');
    expect(keyKindOf('af_test_anything', prefixes)).toBe('payment');
    expect(keyKindOf('afm_live_anything', prefixes)).toBeUndefined();
    expect(keyKindOf('sk-anything', prefixes)).toBeUndefined();
  });

  it.each([
    ['a generated master key', generateApiKey('master', prefixes).expose(), true],
    ['a short body', 'afm_test_abc', false],
    ['a long body', `afm_test_${'a'.repeat(44)}`, false],
    ['a body with -', `afm_test_${'a'.repeat(42)}-`, false],
    ['a payment key', generateApiKey('payment', prefixes).expose(), false],
  ])('checks the shape of %s', (_case, value, expected) => {
    expect(isWellFormedKey(value, 'master', prefixes)).toBe(expected);
  });
});
