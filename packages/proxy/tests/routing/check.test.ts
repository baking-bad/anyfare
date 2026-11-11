import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BlockedAddressError, ConnectionFailedError, DnsLookupError, OutboundTimeoutError, parseIpAddress, type MicroUsd } from '@anyfare/common';
import { NotPayableError, UnsupportedPaymentError } from '@anyfare/payments';

import { HostRefusedError, UpstreamUnavailableError } from '../../src/errors.js';
import {
  addressRefusal, asksOf, boundJson, checkEntryKey, checkRefusalOf, createPayWays, exampleBodyOf, parseProbeView, probeViewOf, upstreamOf, type ProbeView,
} from '../../src/routing/check.js';

const probedAt = new Date('2026-11-12T09:30:00.000Z');
const base64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');

describe('a probe\'s view', () => {
  it('keeps the shown headers only, joins several values, and cuts each to its length', () => {
    const view = probeViewOf(402, {
      'payment-required': 'a'.repeat(20_000), 'www-authenticate': ['Payment id="1"', 'Payment id="2"'], 'content-type': 'application/json',
      'cache-control': undefined, date: 'Thu, 12 Nov 2026 09:30:00 GMT', 'set-cookie': ['session=1'], 'x-secret': 'secret', location: 'https://elsewhere.example',
    }, probedAt, 42);

    expect(view).toEqual({
      status: 402,
      headers: {
        'payment-required': 'a'.repeat(16_384), 'www-authenticate': 'Payment id="1", Payment id="2"', 'content-type': 'application/json',
        date: 'Thu, 12 Nov 2026 09:30:00 GMT',
      },
      probedAt: '2026-11-12T09:30:00.000Z',
      ms: 42,
    });
  });

  it('is read back from the cache only when well formed, its values of the answer\'s types', () => {
    const view = probeViewOf(402, { 'content-type': 'application/json' }, probedAt, 7);

    expect(parseProbeView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(parseProbeView({ ...view, ms: 7.6, headers: { ...view.headers, 'set-cookie': 'x', date: 5 } })).toEqual({ ...view, ms: 8 });
    expect(parseProbeView({ ...view, status: 'x' })).toBeUndefined();
    expect(parseProbeView({ ...view, probedAt: 'not a time' })).toBeUndefined();
    expect(parseProbeView('not a view')).toBeUndefined();
  });

  it('is cached under a key of the check\'s own, a digest of the method and URL, never the URL itself', () => {
    const key = checkEntryKey('af:', 'GET', 'https://api.example.com/v1/pools?q=secret');

    expect(key).toMatch(/^af:check:[0-9a-f]{64}$/);
    expect(key).not.toBe(checkEntryKey('af:', 'POST', 'https://api.example.com/v1/pools?q=secret'));
  });

  it('is cached for a try with a body under a key of its own, with the body\'s SHA-256', () => {
    const body = Buffer.from('{"urls":["https://example.com"]}');
    const digest = createHash('sha256').update(body).digest('hex');

    const key = checkEntryKey('af:', 'POST', 'https://api.example.com/v1/search', body);

    expect(key).toBe(`${checkEntryKey('af:', 'POST', 'https://api.example.com/v1/search')}:${digest}`);
    expect(key).not.toBe(checkEntryKey('af:', 'POST', 'https://api.example.com/v1/search', Buffer.from('{"urls":[]}')));
  });
});

describe('a 402\'s own example of a body', () => {
  const example = { urls: ['https://example.com'], text: true };
  const option = (amount: string) => ({ scheme: 'exact', network: 'eip155:84532', amount, asset: '0xabc', payTo: '0xdef', maxTimeoutSeconds: 60 });
  const input = { type: 'http', method: 'POST', bodyType: 'json', body: example };
  const viewOf = (required: unknown, status = 402): ProbeView => ({
    status, headers: { 'payment-required': base64(required) }, probedAt: probedAt.toISOString(), ms: 1,
  });
  const zeroPriced = (overrides: Record<string, unknown> = {}, accepts = [option('0'), option('000')]) => viewOf({
    x402Version: 2, accepts, extensions: { bazaar: { info: { input: { ...input, ...overrides }, output: { type: 'json' } } } },
  });

  it('is the body of a bazaar `http` input of the same method, in any case, when every option asks 0', () => {
    const found = exampleBodyOf(zeroPriced(), 'POST');

    expect(found?.value).toEqual(example);
    expect(found?.bytes.toString('utf8')).toBe(JSON.stringify(example));
    expect(exampleBodyOf(zeroPriced({ method: 'put' }), 'PUT')?.value).toEqual(example);
    expect(exampleBodyOf(zeroPriced({ method: 'Patch' }), 'PATCH')?.value).toEqual(example);
  });

  it('is none for a price that isn\'t 0 in every option, for another method, body type or status, or a body over 8 KB', () => {
    expect(exampleBodyOf(zeroPriced({}, [option('0'), option('1000')]), 'POST')).toBeUndefined();
    expect(exampleBodyOf(zeroPriced({}, []), 'POST')).toBeUndefined();
    expect(exampleBodyOf(zeroPriced({ method: 'GET' }), 'POST')).toBeUndefined();
    expect(exampleBodyOf(zeroPriced({ method: 'DELETE' }), 'DELETE')).toBeUndefined();
    expect(exampleBodyOf(zeroPriced({ method: 'GET' }), 'GET')).toBeUndefined();
    expect(exampleBodyOf(zeroPriced({ bodyType: 'form-data' }), 'POST')).toBeUndefined();
    expect(exampleBodyOf(zeroPriced({ type: 'mcp' }), 'POST')).toBeUndefined();
    expect(exampleBodyOf(zeroPriced({ body: null }), 'POST')).toBeUndefined();
    expect(exampleBodyOf({ ...zeroPriced(), status: 200 }, 'POST')).toBeUndefined();
    expect(exampleBodyOf(viewOf({ x402Version: 2, accepts: [option('0')] }), 'POST')).toBeUndefined();
    expect(exampleBodyOf({ ...zeroPriced(), headers: {} }, 'POST')).toBeUndefined();
    // 8 KB of JSON at most: the quotes of a string count
    expect(exampleBodyOf(zeroPriced({ body: 'x'.repeat(8_190) }), 'POST')?.bytes.length).toBe(8_192);
    expect(exampleBodyOf(zeroPriced({ body: 'x'.repeat(8_191) }), 'POST')).toBeUndefined();
  });
});

describe('a decoded challenge', () => {
  it('is kept as sent when it is of a sane shape', () => {
    const challenge = { x402Version: 2, resource: { url: 'https://api.example.com/v1' }, accepts: [{ scheme: 'exact', amount: '1000', extra: { name: 'USDC' } }] };

    expect(boundJson(challenge)).toEqual(challenge);
  });

  it('is cut at 8 levels, 64 entries, and strings of 4,096 characters', () => {
    let deep: unknown = 'bottom';
    for (let level = 0; level < 5_000; level++)
      deep = { next: deep };
    const bounded = boundJson({ deep, list: Array.from({ length: 1_000 }, (_, index) => index), text: 'x'.repeat(10_000), odd: Number.NaN });
    let depth = 0;
    for (let item = (bounded as { deep: unknown }).deep; item !== null; item = (item as { next: unknown }).next)
      depth++;

    expect(depth).toBe(7);
    expect((bounded as { list: unknown[] }).list).toHaveLength(64);
    expect((bounded as { text: string }).text).toHaveLength(4_096);
    expect((bounded as { odd: unknown }).odd).toBeNull();
  });

  it('is left out when even its bounded form is too large', () => {
    const wide = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${index}`, Array.from({ length: 64 }, () => 'y'.repeat(20))]));

    expect(boundJson(wide)).toBeUndefined();
  });

  it('of x402 and of MPP is decoded from the shown headers; anything else decodes to nothing', () => {
    const required = { x402Version: 2, error: 'Payment required', accepts: [] };
    const mpp = 'Payment id="abc", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwIn0"';
    const view: ProbeView = { status: 402, headers: { 'payment-required': base64(required), 'www-authenticate': mpp }, probedAt: probedAt.toISOString(), ms: 1 };

    const upstream = upstreamOf(view);

    expect(upstream.x402).toEqual(required);
    expect(upstream.mpp).toEqual([{ id: 'abc', realm: 'api.example.com', method: 'tempo', intent: 'charge', request: { amount: '1000' } }]);
    expect(upstreamOf({ ...view, headers: { 'payment-required': 'not base64!', 'www-authenticate': 'Bearer realm="x"' } })).toEqual({
      status: 402, headers: { 'payment-required': 'not base64!', 'www-authenticate': 'Bearer realm="x"' },
    });
    expect(upstreamOf({ ...view, headers: { 'payment-required': base64([1, 2]) } })).not.toHaveProperty('x402');
  });
});

describe('what a target asks', () => {
  const paidWithOf = (protocol: 'x402' | 'mpp', network: string) => `${protocol}@${network}`;

  it('reads an x402 option and its resource, cut, and leaves out fields of the wrong type', () => {
    const asks = asksOf({
      protocol: 'x402', network: 'eip155:84532', asset: 'base-usdc', price: 1_000n as MicroUsd, x402Version: 2,
      requirement: { scheme: 'exact', network: 'eip155:84532', amount: '1000', asset: '0xabc', payTo: '0xdef', maxTimeoutSeconds: 60.5, extra: {} } as never,
      resource: { url: 'https://api.example.com', description: 'd'.repeat(5_000), mimeType: 7 },
    }, paidWithOf);

    expect(asks).toEqual({
      amount: '0.001', asset: 'USDC', network: 'eip155:84532', paidWith: 'x402@eip155:84532', payTo: '0xdef', scheme: 'exact', x402Version: 2, description: 'd'.repeat(2_000),
    });
  });

  it('reads an MPP challenge as the target sent it', () => {
    const challenge = 'Payment id="abc", realm="api.example.com", method="tempo", intent="charge", description="Quotes", expires="2026-11-12T10:00:00.000Z", '
      + `request="${Buffer.from(JSON.stringify({ amount: '2000', recipient: '0x55' })).toString('base64url')}"`;

    expect(asksOf({ protocol: 'mpp', network: 'eip155:42431', asset: 'tempo-pathusd', price: 2_000n as MicroUsd, challenge }, paidWithOf)).toEqual({
      amount: '0.002', asset: 'pathUSD', network: 'eip155:42431', paidWith: 'mpp@eip155:42431', method: 'tempo', intent: 'charge', realm: 'api.example.com',
      recipient: '0x55', expires: '2026-11-12T10:00:00.000Z', description: 'Quotes',
    });
  });
});

describe('the ways we take a quote', () => {
  const config = {
    assets: [
      { name: 'base-usdc', network: { id: 'eip155:84532', chain: 'base' } },
      { name: 'solana-usdc', network: { id: 'solana:devnet', chain: 'solana' } },
      { name: 'near-usdc', network: { id: 'near:testnet', chain: 'near' } },
      { name: 'tempo-pathusd', network: { id: 'eip155:42431', chain: 'tempo' } },
    ],
    mpp: { network: { id: 'eip155:42431', chain: 'tempo' } },
  } as never;

  it('lists the offered assets whose minimum the quote reaches, near first and credits last, at the quote', () => {
    const ways = createPayWays(config, {
      x402: [
        { name: 'base-usdc', network: 'eip155:84532', minPrice: 0n as MicroUsd },
        { name: 'solana-usdc', network: 'solana:devnet', minPrice: 10_000n as MicroUsd },
        { name: 'near-usdc', network: 'near:testnet', minPrice: 0n as MicroUsd },
      ],
      mpp: { network: 'eip155:42431', assets: [{ name: 'tempo-pathusd', minPrice: 0n as MicroUsd }] },
    });

    expect(ways(1_100n as MicroUsd).map(way => [way.paidWith, way.protocol, way.asset, way.amount])).toEqual([
      ['near', 'x402', 'USDC', '0.0011'], ['base', 'x402', 'USDC', '0.0011'], ['tempo', 'mpp', 'pathUSD', '0.0011'], ['credits', 'credits', 'Credits', '0.0011'],
    ]);
    expect(ways(10_000n as MicroUsd).map(way => way.paidWith)).toEqual(['near', 'base', 'solana', 'tempo', 'credits']);
  });

  it('lists credits alone when no other rail takes payments', () => {
    expect(createPayWays(config, { x402: [], mpp: undefined })(1n as MicroUsd)).toEqual([
      { paidWith: 'credits', protocol: 'credits', asset: 'Credits', amount: '0.000001', currency: 'USD' },
    ]);
  });
});

describe('a check\'s refusal', () => {
  const own = [parseIpAddress('203.0.113.7')!];

  it('tells a private or reserved address, one of ours, and any other address apart', () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '[::1]', '169.254.169.254', '[fd00::1]', '0.0.0.0'])
      expect(addressRefusal(address, own), address).toMatchObject({ reason: 'host_not_allowed', detail: 'private_address' });
    expect(addressRefusal('203.0.113.7', own)).toMatchObject({ reason: 'host_not_allowed', detail: 'own_host' });
    expect(addressRefusal('8.8.8.8', own)).toMatchObject({ reason: 'invalid_target', detail: 'ip_address' });
    expect(addressRefusal('api.example.com', own)).toBeUndefined();
  });

  it('names why a host is refused, why a probe didn\'t quote, and why a link is dead', () => {
    const view: ProbeView = { status: 200, headers: {}, probedAt: probedAt.toISOString(), ms: 1 };
    const unreachable = (cause: Error) => checkRefusalOf(new UpstreamUnavailableError({ cause }), undefined);

    expect(checkRefusalOf(new HostRefusedError('blocklisted'), undefined)).toMatchObject({ reason: 'host_not_allowed', detail: 'blocklisted' });
    expect(checkRefusalOf(new HostRefusedError('own_address'), undefined)).toMatchObject({ reason: 'host_not_allowed', detail: 'own_host' });
    expect(checkRefusalOf(new HostRefusedError('opted_out'), undefined)).toMatchObject({ reason: 'host_not_allowed', detail: 'opted_out' });
    expect(checkRefusalOf(new NotPayableError(), view)).toEqual({
      reason: 'not_payable', detail: 'no_payment_asked', status: 200, message: 'The link answered 200 without asking for a payment. Anyfare routes paid calls only.',
    });
    expect(checkRefusalOf(new UnsupportedPaymentError(), { ...view, status: 402 })).toMatchObject({ detail: 'no_challenge', status: 402 });
    expect(checkRefusalOf(new UnsupportedPaymentError(), { ...view, status: 402, headers: { 'payment-required': base64({ x402Version: 1, accepts: [] }) } }))
      .toMatchObject({ detail: 'no_option' });
    // A name that resolves only to addresses we never call reads as one that doesn't resolve
    expect(unreachable(new BlockedAddressError('a.example.com', '10.0.0.1', 'a private address'))).toEqual(unreachable(new DnsLookupError('a.example.com')));
    expect(unreachable(new DnsLookupError('a.example.com'))).toMatchObject({ reason: 'upstream_unavailable', detail: 'dns' });
    expect(unreachable(new ConnectionFailedError('a.example.com', { cause: Object.assign(new Error('Headers Overflow Error'), { code: 'UND_ERR_HEADERS_OVERFLOW' }) })))
      .toMatchObject({ reason: 'upstream_unavailable', detail: 'headers_too_large' });
    expect(unreachable(new OutboundTimeoutError('a.example.com', 'total', 5_000))).toMatchObject({ detail: 'timeout' });
    expect(unreachable(new ConnectionFailedError('a.example.com', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })))
      .toMatchObject({ detail: 'refused' });
    expect(unreachable(new ConnectionFailedError('a.example.com', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })))
      .toMatchObject({ detail: 'unreachable' });
    expect(checkRefusalOf(new Error('anything else'), view)).toBeUndefined();
    // A message names no address
    expect(JSON.stringify(unreachable(new BlockedAddressError('a.example.com', '10.0.0.1', 'a private address')))).not.toContain('10.0.0.1');
  });
});
