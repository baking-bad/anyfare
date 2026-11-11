import type { SiteSettings } from '../config';
import { llmsPath } from '../agents/links';
import { hasMarkdown } from '../markdown/negotiate';
import { twinHref, type QuerySource } from './twin';

// The links every public HTML page carries, as `<link>` tags and as a `Link` header. This is the one place
// that builds them, so the tags and the header say the same. Hosts always come from the settings.

type Hosts = Pick<SiteSettings, 'siteUrl' | 'apiUrl'>;

export interface PageLink {
  readonly href: string;
  readonly rel: string;
  readonly type?: string;
  readonly title?: string;
}

/** The API host's OpenAPI file, by the registered `service-desc` relation. */
export const serviceDescLink = ({ apiUrl }: Pick<SiteSettings, 'apiUrl'>): PageLink => ({ href: `${apiUrl}/openapi.json`, rel: 'service-desc', type: 'application/openapi+json' });

/** The short guide for agents. */
export const llmsLink = ({ siteUrl }: Pick<SiteSettings, 'siteUrl'>): PageLink => ({ href: `${siteUrl}${llmsPath}`, rel: 'alternate', type: 'text/plain', title: 'llms.txt: a guide for agents' });

/** A page's Markdown twin, when it has one. `query` is the page's own query: the twin carries what its data depends on (see twin.ts). */
export const twinLink = ({ siteUrl }: Pick<SiteSettings, 'siteUrl'>, pathname: string, query: QuerySource = ''): PageLink | undefined =>
  hasMarkdown(pathname) ? { href: `${siteUrl}${twinHref(pathname, query)}`, rel: 'alternate', type: 'text/markdown' } : undefined;

/** The links of a public page: its twin (when it has one), llms.txt and the OpenAPI file. */
export const pageLinks = (hosts: Hosts, pathname: string, query: QuerySource = ''): readonly PageLink[] =>
  [twinLink(hosts, pathname, query), llmsLink(hosts), serviceDescLink(hosts)].filter((link): link is PageLink => link !== undefined);

const quoted = (value: string): string => `"${value.replace(/["\\]/g, '\\$&')}"`;

/** One link as a `Link` header value. */
export const linkHeaderValue = (link: PageLink): string =>
  [`<${link.href}>`, `rel=${quoted(link.rel)}`, ...link.type === undefined ? [] : [`type=${quoted(link.type)}`], ...link.title === undefined ? [] : [`title=${quoted(link.title)}`]].join('; ');

/** The `Link` header value for a page, or undefined for a path that isn't a public page. */
export const linkHeader = (hosts: Hosts, pathname: string, query: QuerySource = ''): string | undefined =>
  hasMarkdown(pathname) ? pageLinks(hosts, pathname, query).map(linkHeaderValue).join(', ') : undefined;

/** `<link>` attributes for the layout: llms.txt and the OpenAPI file, the same on every page. */
export const sharedLinks = (hosts: Hosts): readonly PageLink[] => [llmsLink(hosts), serviceDescLink(hosts)];

/** The canonical URL of a page: its own path on the site, without a query. */
export const canonicalUrl = ({ siteUrl }: Pick<SiteSettings, 'siteUrl'>, pathname: string): string => pathname === '/' ? siteUrl : `${siteUrl}${pathname}`;
