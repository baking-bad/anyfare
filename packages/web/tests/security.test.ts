import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, createNonce, securityHeaders } from '../src/security/csp';

const directives = (policy: string): Record<string, string> =>
  Object.fromEntries(policy.split('; ').map(directive => [directive.slice(0, directive.indexOf(' ')), directive.slice(directive.indexOf(' ') + 1)]));

const options = { nonce: 'abc123==', apiUrl: 'https://api.example.test/', payUrl: 'https://pay.example.test', development: false };

describe('the Content-Security-Policy', () => {
  it('lets scripts run only with this response\'s nonce, and the browser talk only to the site, the API and the pay host', () => {
    const policy = directives(contentSecurityPolicy(options));

    expect(policy['script-src']).toBe('\'self\' \'nonce-abc123==\' \'strict-dynamic\'');
    expect(policy['connect-src']).toBe('\'self\' https://api.example.test https://pay.example.test');
    expect(policy['default-src']).toBe('\'self\'');
    expect(policy['style-src']).toBe('\'self\'');
    expect(policy['font-src']).toBe('\'self\'');
    expect(policy['img-src']).toBe('\'self\' data:');
    expect(policy['frame-ancestors']).toBe('\'none\'');
    expect(policy['object-src']).toBe('\'none\'');
    expect(policy['base-uri']).toBe('\'self\'');
    expect(policy['form-action']).toBe('\'self\'');
  });

  it('names no origin but the API and the pay host', () => {
    const policy = contentSecurityPolicy(options);

    expect([...policy.matchAll(/https?:\/\/[^\s;]+/g)].map(match => match[0])).toEqual(['https://api.example.test', 'https://pay.example.test']);
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('*');
  });

  it('names an origin once when the API and the pay host share it', () => {
    const policy = directives(contentSecurityPolicy({ ...options, payUrl: 'https://api.example.test/pay' }));

    expect(policy['connect-src']).toBe('\'self\' https://api.example.test');
  });

  it('adds eval, inline styles and the websocket only for next dev', () => {
    const policy = directives(contentSecurityPolicy({ ...options, apiUrl: 'http://localhost:8081', development: true }));

    expect(policy['script-src']).toContain('\'unsafe-eval\'');
    expect(policy['style-src']).toBe('\'self\' \'unsafe-inline\'');
    expect(policy['connect-src']).toBe('\'self\' http://localhost:8081 https://pay.example.test ws:');
  });

  it('makes a fresh 128-bit nonce for every response', () => {
    const nonces = new Set(Array.from({ length: 100 }, createNonce));

    expect(nonces.size).toBe(100);
    expect([...nonces].every(nonce => Buffer.from(nonce, 'base64').length === 16)).toBe(true);
  });

  it('sends the other security headers with every response', () => {
    expect(securityHeaders).toMatchObject({
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    });
    expect(securityHeaders['permissions-policy']).toContain('camera=()');
  });
});
