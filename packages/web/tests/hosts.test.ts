import { describe, expect, it } from 'vitest';

import { linkAmount, maxTopupAmount, topupAmount } from '../src/console/amount';
import { consoleLink, consoleOverviewPath, consolePageRoute, consoleRouteOf, consoleRoutes, hostKey, isConsoleRoute, surfaceFromHeader, surfaceOf, verdictFor } from '../src/hosts';
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
  const consolePages = ['/', '/topup', '/keys', '/payments', '/settings', '/signin'];
  const internal = [...consoleRoutes, `${consolePageRoute}/`, `${consolePageRoute}/x`, `${consolePageRoute}/keys/1`];

  it.each(consolePages)('serves a console page at %s on the console host', path => {
    expect(verdictFor('console', path)).toBe('console');
  });

  it.each(['/_/health', '/icon', '/apple-icon', '/logo.svg', '/robots.txt', '/_next/static/chunks/a.js', '/_next/image', '/logos/networks/near.svg', '/logos/tokens/usdc.svg'])('serves the file %s on the console host', path => {
    expect(verdictFor('console', path)).toBe('public');
  });

  it('serves the logos of networks and tokens on the console host, for Top up, and nothing else under that name', () => {
    expect(verdictFor('console', '/logos/networks/base.svg')).toBe('public');
    for (const path of ['/logos', '/logosx/a.svg', '/Logos/tokens/usdc.svg'])
      expect(verdictFor('console', path), path).toBe('hidden');
  });

  it.each(['/services', '/services/api.example.com', '/calls', '/calls/pay_x', '/agents', '/check', '/index.md', '/agents.md', '/llms.txt', '/llms-full.txt', '/skills/anyfare-buyer/SKILL.md', '/sitemap.xml', '/opengraph-image', '/md/agents', '/dev/components', '/console', '/topup/x', '/keys/', '/Topup', '/signin/', '/settings.md', '/nothing', ...internal])('serves nothing at %s on the console host', path => {
    expect(verdictFor('console', path)).toBe('hidden');
  });

  it('never serves a console page on the public host, under any path', () => {
    for (const path of [...consolePages, '/console'])
      expect(verdictFor('site', path), path).toBe('public');
    for (const path of internal)
      expect(verdictFor('site', path), path).toBe('hidden');
  });

  it('serves the Overview at /console and the console paths when the hosts are one, and the home page at /', () => {
    expect(verdictFor('shared', '/console')).toBe('console');
    for (const path of consolePages.slice(1))
      expect(verdictFor('shared', path), path).toBe('console');
    expect(verdictFor('shared', '/')).toBe('public');
    expect(verdictFor('shared', '/services')).toBe('public');
    expect(verdictFor('shared', '/console/keys')).toBe('public');
    for (const path of internal)
      expect(verdictFor('shared', path), path).toBe('hidden');
  });

  it('never serves a console route asked for directly, on any host', () => {
    for (const surface of ['site', 'console', 'shared'] as const) {
      for (const path of internal)
        expect(verdictFor(surface, path), `${surface} ${path}`).toBe('hidden');
    }
    expect(isConsoleRoute('/_/consoles')).toBe(false);
    expect(isConsoleRoute('/_/console')).toBe(true);
  });

  it('leads each console path to its own internal route, and the Overview to the console route itself', () => {
    expect(consoleRouteOf('/')).toBe('/_/console');
    expect(consoleRouteOf('/console')).toBe('/_/console');
    expect(consoleRouteOf('/keys')).toBe('/_/console/keys');
    expect(consoleRouteOf('/topup')).toBe('/_/console/topup');
    expect(consoleRouteOf('/payments')).toBe('/_/console/payments');
    expect(consoleRouteOf('/settings')).toBe('/_/console/settings');
    expect(consoleRouteOf('/signin')).toBe('/_/console/signin');
    expect(consoleRoutes).toEqual(['/_/console', '/_/console/topup', '/_/console/keys', '/_/console/payments', '/_/console/settings', '/_/console/signin']);
  });
});

describe('the links into the console', () => {
  it('are on the console\'s settings, and /console when the hosts are one', () => {
    expect(consoleLink(hosts)).toBe('https://console.example.com');
    expect(consoleLink(hosts, '/topup')).toBe('https://console.example.com/topup');
    expect(consoleLink({ siteUrl: 'http://localhost:3000', consoleUrl: 'http://localhost:3000' })).toBe('http://localhost:3000/console');
    expect(consoleLink({ siteUrl: 'http://localhost:3000', consoleUrl: 'http://localhost:3000' }, '/keys')).toBe('http://localhost:3000/keys');
  });

  it('put the Overview at / on the console host, and at /console when the hosts are one', () => {
    expect(consoleOverviewPath(hosts)).toBe('/');
    expect(consoleOverviewPath(local)).toBe('/');
    expect(consoleOverviewPath({ siteUrl: 'http://localhost:3000', consoleUrl: 'http://localhost:3000' })).toBe('/console');
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
  it('is at most 1,000', () => {
    expect(maxTopupAmount).toBe(1000);
  });

  it.each([
    ['5', 5], ['5.50', 5.5], ['5.5', 5.5], ['1', 1], ['1.00', 1], ['1000', 1000], ['1000.00', 1000], ['0123', 123], ['99.99', 99.99], ['999.99', 999.99],
  ])('reads %j as %d', (value, amount) => {
    expect(topupAmount(value)).toBe(amount);
  });

  it.each([
    '0', '0.99', '-1', '1e9', '1E2', '<script>', '5abc', '', ' 5', '5 ', '+5', '5.', '.5', '5.555', '1000.01', '1001', '10000', '1,5', '0x10', 'NaN', 'Infinity', '٥', '5\n', '1'.repeat(30),
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

  it('tells a link with no amount from one whose amount was not used', () => {
    expect(linkAmount([])).toEqual({ kind: 'none' });
    expect(linkAmount(['5'])).toEqual({ kind: 'used', amount: 5 });
    expect(linkAmount(['7.25', 'x'])).toEqual({ kind: 'used', amount: 7.25 });
    for (const values of [[''], ['abc'], ['%3Cscript%3E'], ['1001'], ['0'], ['x', '5']])
      expect(linkAmount(values), values.join()).toEqual({ kind: 'unused' });
  });
});
