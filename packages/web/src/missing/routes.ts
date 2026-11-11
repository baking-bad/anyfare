import { consolePageRoute, hiddenRoute } from '../hosts';
import { llmsFullPath, llmsPath } from '../agents/links';
import { listingPath, missingPath } from './pages';
import { markdownRoot } from '../markdown/negotiate';

// The paths the site answers with something other than its 404 page. A request that asks for Markdown and
// names none of them gets the Markdown 404 (see `missingMarkdown`), where the HTML 404 page would be no
// use to it. A route is added here when it is added to `app/`; a test lists `app/` and fails on one that isn't.

const exact: ReadonlySet<string> = new Set([
  '/', '/agents', '/calls', '/services', '/check',
  llmsPath, llmsFullPath, '/robots.txt', '/sitemap.xml', '/icon', '/apple-icon', '/opengraph-image', '/logo.svg', '/favicon.ico',
  '/_/health', '/dev/components', consolePageRoute, hiddenRoute, listingPath,
]);

const patterns: readonly RegExp[] = [
  /^\/calls\/[^/]+$/,
  /^\/services\/[^/]+$/,
  /^\/skills\/[^/]+\/SKILL\.md$/,
  /^\/logos\/[^/]+\/[^/]+$/,
  new RegExp(`^${markdownRoot}(/|$)`),
  new RegExp(`^${missingPath}/`),
  /^\/_next\//,
];

/** Whether the path is one the site serves, or one the proxy leads to a served route. */
export const isKnownPath = (pathname: string): boolean => exact.has(pathname) || patterns.some(pattern => pattern.test(pathname));

/** The line a missing path asked as Markdown answers. */
export const missingMarkdown = (siteUrl: string): string =>
  `# Not found\n\nThere is no page at this address. Start from [${siteUrl}/index.md](${siteUrl}/index.md), or read [${siteUrl}${llmsPath}](${siteUrl}${llmsPath}).\n`;

/**
 * Whether a request asks for Markdown at a path with no page: a `.md` address that isn't a page's twin or the
 * skill file, or any path asked with `Accept: text/markdown` that the site doesn't serve.
 */
export const asksMissingMarkdown = (pathname: string, prefersMarkdown: boolean): boolean => {
  if (isKnownPath(pathname))
    return false;

  return prefersMarkdown || pathname.endsWith('.md');
};
