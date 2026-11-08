import { describe, expect, it } from 'vitest';

import {
  createRoutingLinkRewriter, filterResponseHeaders, rewriteLinkHeader, routedRequestHeaders, routedResponseHeaders,
} from '../../src/routing/headers.js';

const payUrl = 'https://pay.anyfare.test';
const target = { host: 'api.target.test', url: 'https://api.target.test/v1/pools?limit=10' };

describe('the request to the target', () => {
  it('keeps the allowlisted headers and the buyer\'s own X- headers, drops ours, the credentials, and the conditional ones, and sets our request ID', () => {
    const headers = routedRequestHeaders({
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'content-type': 'application/json',
      'content-length': '12',
      'idempotency-key': 'k-1',
      range: 'bytes=0-99',
      'if-none-match': '"v1"',
      'if-modified-since': 'Sun, 08 Nov 2026 10:00:00 GMT',
      'if-match': '"v1"',
      'if-range': '"v1"',
      'if-unmodified-since': 'Sun, 08 Nov 2026 10:00:00 GMT',
      'x-api-key': 'buyer-own-key',
      'x-client-version': '3',
      authorization: 'Bearer af_test_buyer',
      cookie: 'session=1',
      'payment-signature': 'sig',
      'x-payment': 'paid',
      'x-payment-response': 'echo',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-host': 'pay.anyfare.test',
      'x-real-ip': '203.0.113.7',
      'x-internal-secret': 'guess',
      'x-signer-secret': 'guess',
      'x-request-id': 'spoofed',
      host: 'pay.anyfare.test',
      origin: 'https://evil.example',
    }, 'req-1');

    expect(headers).toEqual({
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'content-type': 'application/json',
      'idempotency-key': 'k-1',
      range: 'bytes=0-99',
      'x-api-key': 'buyer-own-key',
      'x-client-version': '3',
      'x-request-id': 'req-1',
    });
  });

  it('keeps a header sent more than once as a list', () => {
    expect(routedRequestHeaders({ 'x-tag': ['a', 'b'] }, 'req-2')).toEqual({ 'x-tag': ['a', 'b'], 'x-request-id': 'req-2' });
  });
});

describe('the target\'s links in its answer', () => {
  const rewrite = createRoutingLinkRewriter({ payUrl, target });

  it.each([
    ['an absolute URL on the target', 'https://api.target.test/v1/pools/next?page=2#top', 'https://pay.anyfare.test/api.target.test/v1/pools/next?page=2#top'],
    ['a path on the target', '/v1/jobs/7', 'https://pay.anyfare.test/api.target.test/v1/jobs/7'],
    ['a relative reference', 'next', 'https://pay.anyfare.test/api.target.test/v1/next'],
    ['the target on its default port', 'https://api.target.test:443/v2', 'https://pay.anyfare.test/api.target.test/v2'],
    ['another origin, kept as it is', 'https://cdn.example.net/file.png', 'https://cdn.example.net/file.png'],
    ['the target over plain HTTP, kept: another origin', 'http://api.target.test/v1/x', 'http://api.target.test/v1/x'],
    ['the target on another port, kept: another origin', 'https://api.target.test:8443/v1/x', 'https://api.target.test:8443/v1/x'],
    ['something that isn\'t a URL, dropped', 'https://[::1', undefined],
  ])('handles %s', (_case, value, expected) => {
    expect(rewrite(value)).toBe(expected);
  });

  it('builds links from the canonical pay URL, and keeps the target\'s port', () => {
    const withPort = createRoutingLinkRewriter({ payUrl: `${payUrl}/`, target: { host: 'api.target.test:8443', url: 'https://api.target.test:8443/v1/' } });

    expect(withPort('/v1/x')).toBe('https://pay.anyfare.test/api.target.test:8443/v1/x');
  });

  it('rewrites each link in a Link header and keeps their parameters', () => {
    const value = '<https://api.target.test/v1/items?page=2>; rel="next", <https://docs.example.net/a,b>; rel="help"; title="x, y", <https://[::1>; rel="broken"';

    expect(rewriteLinkHeader(value, rewrite)).toBe('<https://pay.anyfare.test/api.target.test/v1/items?page=2>; rel="next", '
      + '<https://docs.example.net/a,b>; rel="help"; title="x, y"');
    expect(rewriteLinkHeader('<https://[::1>; rel="x"', rewrite)).toBeUndefined();
  });

  it('passes only the allowlisted headers, never Set-Cookie or the target\'s payment headers, with its links through the routing link', () => {
    const headers = routedResponseHeaders({
      'content-type': 'application/json',
      'content-length': '12',
      etag: '"v1"',
      'set-cookie': ['session=target'],
      server: 'nginx/1.2.3',
      'x-powered-by': 'Express',
      'access-control-allow-origin': 'https://evil.example',
      'payment-required': 'e30=',
      'payment-response': 'e30=',
      'x-payment-response': 'e30=',
      'payment-receipt': 'receipt',
      'www-authenticate': 'Payment id="1"',
      location: 'https://api.target.test/v1/pools/next',
      'content-location': '/v1/pools?limit=10',
      link: '<https://api.target.test/v1/a>; rel="next"',
    }, { payUrl, target });

    expect(headers).toEqual({
      'content-type': 'application/json',
      'content-length': '12',
      etag: '"v1"',
      location: 'https://pay.anyfare.test/api.target.test/v1/pools/next',
      'content-location': 'https://pay.anyfare.test/api.target.test/v1/pools?limit=10',
      link: '<https://pay.anyfare.test/api.target.test/v1/a>; rel="next"',
    });
  });

  it('keeps a header the target sent more than once, and drops a Location that isn\'t a URL', () => {
    expect(filterResponseHeaders({ vary: ['accept', 'origin'], location: 'https://[::1' }, rewrite)).toEqual({ vary: ['accept', 'origin'] });
  });
});
