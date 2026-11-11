import { describe, expect, it } from 'vitest';

import type { ApiResult, Reader } from '../src/api/reader';
import type { ServicesPage } from '../src/api/types';
import { markSvg } from '../src/brand/mark';
import { readSettings } from '../src/config';
import { footerProfiles, jsonLdText, organizationJsonLd, websiteJsonLd } from '../src/seo/jsonld';
import { canonicalUrl, linkHeader, pageLinks, sharedLinks } from '../src/seo/links';
import { robotsRules } from '../src/seo/robots';
import { sitemapEntries, sitemapServices } from '../src/seo/sitemap';
import { socialTags } from '../src/seo/social';

// Custom hosts: nothing in the output may name the production defaults or the internal address
const settings = readSettings({
  SITE_URL: 'https://site.test.example',
  API_URL: 'https://api.test.example',
  PAY_URL: 'https://pay.test.example',
  CONSOLE_URL: 'https://console.test.example',
  API_INTERNAL_URL: 'http://10.1.2.3:4000',
  PAY_INTERNAL_URL: 'http://10.1.2.3:4001',
});

const noDefaultsOrInternal = (text: string): void => {
  expect(text).not.toContain('bakingbad.dev');
  expect(text).not.toContain('10.1.2.3');
  expect(text).not.toContain('localhost');
};

describe('the links of a page', () => {
  it('has the Markdown twin, llms.txt and the OpenAPI file, from the settings', () => {
    const links = pageLinks(settings, '/services');

    expect(links).toEqual([
      { href: 'https://site.test.example/services.md', rel: 'alternate', type: 'text/markdown' },
      { href: 'https://site.test.example/llms.txt', rel: 'alternate', type: 'text/plain', title: 'llms.txt: a guide for agents' },
      { href: 'https://api.test.example/openapi.json', rel: 'service-desc', type: 'application/openapi+json' },
    ]);
  });

  it('writes the same three links as a Link header', () => {
    const header = linkHeader(settings, '/')!;

    expect(header.split(', <')).toHaveLength(3);
    expect(header).toContain('<https://site.test.example/index.md>; rel="alternate"; type="text/markdown"');
    expect(header).toContain('<https://site.test.example/llms.txt>; rel="alternate"; type="text/plain"; title="llms.txt: a guide for agents"');
    expect(header).toContain('<https://api.test.example/openapi.json>; rel="service-desc"; type="application/openapi+json"');
    noDefaultsOrInternal(header);
  });

  it.each(['/', '/services', '/services/api.example.com', '/calls', '/calls/pay_abc', '/agents', '/check'])('answers the header for %s', path => {
    expect(linkHeader(settings, path)).toContain('rel="service-desc"');
  });

  it.each(['/robots.txt', '/icon', '/nothing', '/md/services'])('has no header for %s, which is not a public page', path => {
    expect(linkHeader(settings, path)).toBeUndefined();
  });

  it('has llms.txt and the OpenAPI file for the layout, the same on every page', () => {
    expect(sharedLinks(settings).map(link => link.rel)).toEqual(['alternate', 'service-desc']);
  });

  it('gives the canonical URL without a query', () => {
    expect(canonicalUrl(settings, '/')).toBe('https://site.test.example');
    expect(canonicalUrl(settings, '/check')).toBe('https://site.test.example/check');
  });
});

describe('the Open Graph and Twitter tags', () => {
  it('carry the page\'s own title and description, and the large card', () => {
    const tags = socialTags({ siteUrl: 'https://site.test.example', title: 'Calls | Anyfare', description: 'Every call.', url: 'https://site.test.example/calls' });

    expect(tags.openGraph).toMatchObject({ title: 'Calls | Anyfare', description: 'Every call.', url: 'https://site.test.example/calls' });
    expect(tags.twitter).toMatchObject({ card: 'summary_large_image', title: 'Calls | Anyfare', description: 'Every call.' });
    expect(JSON.stringify(tags)).toContain('"https://site.test.example/opengraph-image"');
  });
});

describe('robots.txt', () => {
  it('allows everyone, keeps out what is not a page, and names the sitemap', () => {
    const robots = robotsRules(settings);

    expect(robots.rules).toEqual([{ userAgent: '*', allow: '/', disallow: ['/_/', '/md/', '/dev/'] }]);
    expect(robots.sitemap).toBe('https://site.test.example/sitemap.xml');
    expect(JSON.stringify(robots)).not.toMatch(/GPTBot|ClaudeBot|CCBot|Google-Extended/);
    noDefaultsOrInternal(JSON.stringify(robots));
  });
});

const row = (host: string) => ({ host, status: 'paid' as const, listedAt: null, checkedAt: null, paidEndpoints: 1, priceFrom: '0.01', currency: 'USD', calls: 1, buyers: 1, volume: '0.01', successRate: 1, p50Ms: 100, trend: [] });
const page = (hosts: readonly string[]): ServicesPage => ({ services: hosts.map(row), page: 1, size: 100, total: hosts.length, totalCapped: false, totals: { services: hosts.length, paidServices: hosts.length, paidEndpoints: hosts.length, calls30d: hosts.length }, updatedAt: null });

const readerOf = (result: ApiResult<ServicesPage>, paths: string[] = []): Reader => (async (path: string) => {
  paths.push(path);

  return result;
}) as Reader;

const staticUrls = ['https://site.test.example', 'https://site.test.example/services', 'https://site.test.example/calls', 'https://site.test.example/agents'];

describe('the sitemap', () => {
  it('lists the pages and a service each, asking for the first 100 by calls', async () => {
    const paths: string[] = [];
    const entries = await sitemapEntries(settings, readerOf({ ok: true, value: page(['a.example.com', 'b.example.com']) }, paths));

    expect(entries.map(entry => entry.url)).toEqual([...staticUrls, 'https://site.test.example/services/a.example.com', 'https://site.test.example/services/b.example.com']);
    expect(paths).toEqual([`/v1/services?sort=calls&page=1&size=${sitemapServices}`]);
    expect(sitemapServices).toBe(100);
    noDefaultsOrInternal(JSON.stringify(entries));
  });

  it('lists the static pages alone when there are no services', async () => {
    expect((await sitemapEntries(settings, readerOf({ ok: true, value: page([]) }))).map(entry => entry.url)).toEqual(staticUrls);
  });

  it('lists the static pages alone when the API is down, and does not throw', async () => {
    const down = readerOf({ ok: false, error: { status: 503, code: 'api_unavailable', message: 'down' } });

    expect((await sitemapEntries(settings, down)).map(entry => entry.url)).toEqual(staticUrls);
  });

  it('never lists the check page or a receipt, and never more than 100 services', async () => {
    const hosts = Array.from({ length: 150 }, (_, index) => `s${index}.example.com`);
    const urls = (await sitemapEntries(settings, readerOf({ ok: true, value: page(hosts) }))).map(entry => entry.url);

    expect(urls).toHaveLength(104);
    expect(urls.some(url => url.includes('/check') || url.includes('/calls/'))).toBe(false);
  });
});

describe('the home page\'s structured data', () => {
  it('says the real name, address and logo, and the footer\'s links, and nothing else', () => {
    const organization = organizationJsonLd(settings);

    expect(organization).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': 'https://site.test.example/#organization',
      name: 'Anyfare',
      url: 'https://site.test.example',
      logo: 'https://site.test.example/logo.svg',
      sameAs: footerProfiles,
    });
    expect(footerProfiles).toEqual(['https://x.com/3route_io', 'https://github.com/baking-bad/anyfare']);
    expect(Object.keys(websiteJsonLd(settings)).sort()).toEqual(['@context', '@id', '@type', 'description', 'name', 'publisher', 'url']);
    const text = JSON.stringify([organization, websiteJsonLd(settings)]);
    expect(text).not.toMatch(/rating|price|foundingDate|aggregate/i);
    noDefaultsOrInternal(text);
  });

  it('can\'t close its own script tag', () => {
    expect(jsonLdText({ name: '</script><b>' })).not.toContain('<');
  });
});

describe('the mark', () => {
  it('is an SVG of the brand green square with two eyes', () => {
    const svg = markSvg();

    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('fill="#00ec97"');
    expect(svg.match(/<circle/g)).toHaveLength(2);
  });
});
