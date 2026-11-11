import { describe, expect, it } from 'vitest';

import { topupAmount } from '../src/console/amount';
import { todayCards } from '../src/console/content';
import { consoleLink, consolePageRoute, hostKey, surfaceFromHeader, surfaceOf, verdictFor } from '../src/hosts';
import { consoleRobotsRules } from '../src/seo/robots';
import { contentSecurityPolicy } from '../src/security/csp';

const hosts = { siteUrl: 'https://anyfare.example.com', consoleUrl: 'https://console.example.com' };
const local = { siteUrl: 'http://localhost:3000', consoleUrl: 'http://127.0.0.1:3000' };

describe('which host a request is for', () => {
  it.each([
    ['console.example.com', 'console'],
    ['console.example.com:443', 'console'],
    ['CONSOLE.Example.COM', 'console'],
    ['console.example.com.', 'console'],
    ['Console.Example.com.:443', 'console'],
    ['anyfare.example.com', 'site'],
    ['anyfare.example.com:8443', 'site'],
    ['console.example.com:8443', 'site'],
    ['other.example.com', 'site'],
    ['console.example.com.evil.test', 'site'],
    ['evil.test/console.example.com', 'site'],
    ['console.example.com@evil.test', 'site'],
    ['203.0.113.7', 'site'],
    ['localhost:3000', 'site'],
    ['', 'site'],
  ])('reads the Host %j as the %s host', (host, surface) => {
    expect(surfaceOf(host, hosts)).toBe(surface);
  });

  it('reads a missing Host as the public host', () => {
    expect(surfaceOf(null, hosts)).toBe('site');
    expect(surfaceOf(undefined, hosts)).toBe('site');
  });

  it('tells two hosts of one machine apart by name and by port', () => {
    expect(surfaceOf('127.0.0.1:3000', local)).toBe('console');
    expect(surfaceOf('localhost:3000', local)).toBe('site');
    expect(surfaceOf('127.0.0.1:3001', local)).toBe('site');
    expect(surfaceOf('127.0.0.1', local)).toBe('site');
    expect(surfaceOf('127.0.0.1:3000', { siteUrl: 'http://localhost:3000', consoleUrl: 'http://localhost:3100' })).toBe('site');
    expect(surfaceOf('localhost:3100', { siteUrl: 'http://localhost:3000', consoleUrl: 'http://localhost:3100' })).toBe('console');
  });

  it('serves everything when the two settings name one host, whatever the Host says', () => {
    const one = { siteUrl: 'http://localhost:3000', consoleUrl: 'http://localhost:3000/' };

    expect(surfaceOf('localhost:3000', one)).toBe('shared');
    expect(surfaceOf('evil.test', one)).toBe('shared');
    expect(surfaceOf('LOCALHOST:3000.', { siteUrl: 'http://localhost:3000', consoleUrl: 'http://LOCALHOST:3000' })).toBe('shared');
    expect(surfaceOf('anyfare.example.com', { siteUrl: 'https://anyfare.example.com', consoleUrl: 'https://anyfare.example.com:443' })).toBe('shared');
  });

  it('has no input for X-Forwarded-Host: a forged one changes nothing', () => {
    // surfaceOf takes the Host alone; the proxy passes it nothing else
    expect(surfaceOf.length).toBe(2);
    expect(surfaceOf('anyfare.example.com', hosts)).toBe('site');
  });

  it('normalizes a host to lower case without a trailing dot or the scheme\'s own port', () => {
    expect(hostKey('A.B.', 'https:')).toBe('a.b');
    expect(hostKey('a.b:443', 'https:')).toBe('a.b');
    expect(hostKey('a.b:443', 'http:')).toBe('a.b:443');
    expect(hostKey('a.b:80', 'http:')).toBe('a.b');
    expect(hostKey('[::1]:3000', 'http:')).toBe('[::1]:3000');
    expect(hostKey('a b', 'https:')).toBeUndefined();
    expect(hostKey('a/b', 'https:')).toBeUndefined();
    expect(hostKey('a:b', 'https:')).toBeUndefined();
  });

  it('reads the surface a header names, and anything else as the public site', () => {
    expect(surfaceFromHeader('console')).toBe('console');
    expect(surfaceFromHeader('shared')).toBe('shared');
    expect(surfaceFromHeader('site')).toBe('site');
    expect(surfaceFromHeader('forged')).toBe('site');
    expect(surfaceFromHeader(null)).toBe('site');
  });
});

describe('what each host serves', () => {
  it.each(['/', '/topup', '/keys', '/payments', '/settings', '/signin'])('serves the Console page at %s on the console host', path => {
    expect(verdictFor('console', path)).toBe('console');
  });

  it.each(['/_/health', '/icon', '/apple-icon', '/logo.svg', '/robots.txt', '/_next/static/chunks/a.js', '/_next/image'])('serves the file %s on the console host', path => {
    expect(verdictFor('console', path)).toBe('public');
  });

  it.each(['/services', '/services/api.example.com', '/calls', '/calls/pay_x', '/agents', '/check', '/index.md', '/agents.md', '/llms.txt', '/llms-full.txt', '/skills/anyfare-buyer/SKILL.md', '/sitemap.xml', '/opengraph-image', '/md/agents', '/dev/components', '/console', '/topup/x', '/keys/', '/Topup', consolePageRoute, '/nothing'])('serves nothing at %s on the console host', path => {
    expect(verdictFor('console', path)).toBe('hidden');
  });

  it('never serves the Console page on the public host, under any path', () => {
    for (const path of ['/', '/topup', '/keys', '/payments', '/settings', '/signin', '/console'])
      expect(verdictFor('site', path)).toBe('public');
    expect(verdictFor('site', consolePageRoute)).toBe('hidden');
  });

  it('serves the Console page at /console and at the console paths when the hosts are one, and the home page at /', () => {
    expect(verdictFor('shared', '/console')).toBe('console');
    expect(verdictFor('shared', '/topup')).toBe('console');
    expect(verdictFor('shared', '/')).toBe('public');
    expect(verdictFor('shared', '/services')).toBe('public');
    expect(verdictFor('shared', consolePageRoute)).toBe('hidden');
  });
});

describe('the links into the console', () => {
  it('are on the console\'s settings, and /console when the hosts are one', () => {
    expect(consoleLink(hosts)).toBe('https://console.example.com');
    expect(consoleLink(hosts, '/topup')).toBe('https://console.example.com/topup');
    expect(consoleLink({ siteUrl: 'http://localhost:3000', consoleUrl: 'http://localhost:3000' })).toBe('http://localhost:3000/console');
    expect(consoleLink({ siteUrl: 'http://localhost:3000', consoleUrl: 'http://localhost:3000' }, '/keys')).toBe('http://localhost:3000/keys');
  });
});

describe('the console host\'s policy and robots.txt', () => {
  const options = { nonce: 'abc123==', apiUrl: 'https://api.example.test', payUrl: 'https://pay.example.test', development: false };

  it('lets the browser talk only to the site itself and the API', () => {
    const policy = contentSecurityPolicy({ ...options, console: true });

    expect(policy).toContain('connect-src \'self\' https://api.example.test;');
    expect(policy).not.toContain('pay.example.test');
    expect(policy).toContain('default-src \'self\'');
    expect(policy).toContain('frame-ancestors \'none\'');
  });

  it('disallows everything and names no sitemap', () => {
    expect(consoleRobotsRules()).toEqual({ rules: [{ userAgent: '*', disallow: '/' }] });
  });
});

describe('the amount of a top-up link', () => {
  it.each([
    ['5', 5], ['5.50', 5.5], ['5.5', 5.5], ['1', 1], ['1.00', 1], ['10000', 10000], ['10000.00', 10000], ['0123', 123], ['99.99', 99.99],
  ])('reads %j as %d', (value, amount) => {
    expect(topupAmount(value)).toBe(amount);
  });

  it.each([
    '0', '0.99', '-1', '1e9', '1E2', '<script>', '5abc', '', ' 5', '5 ', '+5', '5.', '.5', '5.555', '10000.01', '10001', '1,5', '0x10', 'NaN', 'Infinity', '٥', '5\n', '1'.repeat(30),
  ])('ignores %j', value => {
    expect(topupAmount(value)).toBeUndefined();
  });

  it('ignores a missing value, and reads the first of several', () => {
    expect(topupAmount(undefined)).toBeUndefined();
    expect(topupAmount(null)).toBeUndefined();
    expect(topupAmount([])).toBeUndefined();
    expect(topupAmount(['7', '9'])).toBe(7);
    expect(topupAmount(['x', '9'])).toBeUndefined();
  });

  it('goes into the top-up example as a number, and the other examples never change', () => {
    const [account, key, topup] = todayCards({ ...hosts, apiUrl: 'https://api.example.com', payUrl: 'https://pay.example.com' }, 5.5);
    const plain = todayCards({ ...hosts, apiUrl: 'https://api.example.com', payUrl: 'https://pay.example.com' });

    expect(topup!.command).toContain('"amount":"5.5"');
    expect(plain[2]!.command).toContain('"amount":"20"');
    expect(account).toEqual(plain[0]);
    expect(key).toEqual(plain[1]);
  });
});
