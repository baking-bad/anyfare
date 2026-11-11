import { beforeAll, describe, expect, it } from 'vitest';

import type { MicroUsd } from '@anyfare/common';
import { loadPlatformConfig, paymentMethodsFor, type PlatformConfig } from '@anyfare/core';

import { catalogEntryOf, decodeCursor, encodeCursor, maxCursorLength } from '../../src/catalog/entries.js';

// The catalog's entries and cursors, without a database

let config: PlatformConfig;
const createdAt = new Date('2026-11-20T12:00:00.123Z');

beforeAll(async () => {
  config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
});

describe('an endpoint of the catalog', () => {
  it('shows one only a check listed as checked, unverified, at its last quote, linked on the pay host', () => {
    const entry = catalogEntryOf({ host: 'api.example.com', path: '/v1/pools', lastPrice: 1_100n as MicroUsd, createdAt, status: 'checked' }, { payUrl: 'https://pay.anyfare.test/', config });

    expect(entry).toEqual({
      id: 'routed:api.example.com/v1/pools', host: 'api.example.com', path: '/v1/pools', title: 'api.example.com/v1/pools',
      summary: 'A paid API a check found payable, that Anyfare routes payments to. No paid call has reached it yet. Unverified: its owner hasn\'t registered it.',
      priceFrom: '0.0011', currency: 'USD', methods: paymentMethodsFor(1_100n as MicroUsd, config), verified: false, status: 'checked',
      updatedAt: createdAt.toISOString(), link: 'https://pay.anyfare.test/api.example.com/v1/pools',
    });
  });

  it('shows one a paid call reached as paid, and one with no quote at "0"', () => {
    const entry = catalogEntryOf({ host: 'api.example.com', path: '/v1/x', lastPrice: undefined, createdAt, status: 'paid' }, { payUrl: 'https://pay.anyfare.test', config });

    expect(entry).toMatchObject({
      status: 'paid', priceFrom: '0', methods: paymentMethodsFor(0n as MicroUsd, config),
      summary: 'A paid API that Anyfare routes payments to. Unverified: its owner hasn\'t registered it.',
    });
  });
});

describe('a cursor of the catalog', () => {
  it('gives back the endpoint it was made from, at the bounds of a key too', () => {
    const longest = { createdAt, host: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}:65535`, path: `/${'"\\'.repeat(1_023)}a` };

    for (const cursor of [{ createdAt, host: 'api.example.com', path: '/v1/pools' }, longest]) {
      const text = encodeCursor(cursor);

      expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(text)).toEqual(cursor);
    }
    expect(encodeCursor(longest).length).toBeLessThanOrEqual(maxCursorLength);
  });

  it('is none for the offsets pages gave before, nor for any text a page didn\'t give', () => {
    const made = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

    for (const text of ['20', '10000', 'abc', made(['2026-11-20T12:00:00.123Z', 'h', 'no-slash']), made(['yesterday', 'h', '/x']), made(['2026-11-20T12:00:00.123Z', '', '/x']),
      made({ createdAt: '2026-11-20T12:00:00.123Z' }), made(['2026-11-20T12:00:00.123Z', 'h', '/x', 'more']), made(['2026-11-20T12:00:00Z', 'h', '/x'])])
      expect(decodeCursor(text), text).toBeUndefined();
  });

  it('is none for a key no endpoint could have: a NUL, a space or a capital in the host, a path not of printable ASCII, either too long', () => {
    const made = (host: string, pathname: string) => Buffer.from(JSON.stringify(['2026-11-20T12:00:00.123Z', host, pathname])).toString('base64url');
    const forged = [
      made('api.example.com\u0000', '/x'), made('api.example.com', '/x\u0000'), made('api example.com', '/x'), made('API.example.com', '/x'), made('api.example.com', '/x y'),
      made('api.example.com', '/é'), made('localhost', '/x'), made(`${'a'.repeat(250)}.com`, '/x'), made('api.example.com', `/${'p'.repeat(2_048)}`),
      made('api.example.com:123456', '/x'), made('-api.example.com', '/x'),
    ];

    for (const text of forged)
      expect(decodeCursor(text), Buffer.from(text, 'base64url').toString()).toBeUndefined();
    expect(decodeCursor(made('api.example.com:8443', `/${'p'.repeat(2_047)}`))).toBeDefined();
  });
});
