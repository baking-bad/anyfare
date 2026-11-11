import type { SiteSettings } from '../config';
import { homeDescription, siteName } from '../content/home';

// schema.org data for the home page, from the settings. Only what is true and shown on the site: the name,
// the address, the logo, the one-line description and the footer's own links.

export const footerProfiles: readonly string[] = ['https://x.com/3route_io', 'https://github.com/baking-bad/anyfare'];

export const organizationJsonLd = ({ siteUrl }: Pick<SiteSettings, 'siteUrl'>): Record<string, unknown> => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${siteUrl}/#organization`,
  name: siteName,
  url: siteUrl,
  logo: `${siteUrl}/logo.svg`,
  sameAs: footerProfiles,
});

export const websiteJsonLd = ({ siteUrl }: Pick<SiteSettings, 'siteUrl'>): Record<string, unknown> => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${siteUrl}/#website`,
  name: siteName,
  url: siteUrl,
  description: homeDescription,
  publisher: { '@id': `${siteUrl}/#organization` },
});

/** JSON for a `<script type="application/ld+json">`: nothing in it can close the tag. */
export const jsonLdText = (data: Record<string, unknown>): string => JSON.stringify(data).replace(/</g, '\\u003c');
