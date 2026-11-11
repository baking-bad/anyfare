import type { SiteSettings } from '../config';

// Every crawler and agent may read the public pages and files. Only what is not a page stays out.
export const disallowed: readonly string[] = ['/_/', '/md/', '/dev/'];

/** The console host's robots.txt: nothing to index, and no sitemap. */
export const consoleRobotsRules = () => ({ rules: [{ userAgent: '*', disallow: '/' }] });

export const robotsRules = ({ siteUrl }: Pick<SiteSettings, 'siteUrl'>) => ({
  rules: [{ userAgent: '*', allow: '/', disallow: [...disallowed] }],
  sitemap: `${siteUrl}/sitemap.xml`,
});
