import { listServices } from '../api/endpoints';
import type { Reader } from '../api/reader';
import type { SiteSettings } from '../config';

// The sitemap: the public pages, and one entry per service, the first 100 by calls. Not /check, not receipts.

export const sitemapServices = 100;

export const staticPages: readonly string[] = ['/', '/services', '/calls', '/agents'];

export interface SitemapEntry {
  readonly url: string;
}

/** The entries. When the API is down or answers something else, the static pages alone. */
export const sitemapEntries = async ({ siteUrl }: Pick<SiteSettings, 'siteUrl'>, read: Reader): Promise<readonly SitemapEntry[]> => {
  const result = await listServices(read, { sort: 'calls', page: 1, size: sitemapServices });
  const hosts = result.ok ? result.value.services.slice(0, sitemapServices).map(service => service.host) : [];

  return [
    ...staticPages.map(path => ({ url: path === '/' ? siteUrl : `${siteUrl}${path}` })),
    ...hosts.map(host => ({ url: `${siteUrl}/services/${encodeURIComponent(host)}` })),
  ];
};
