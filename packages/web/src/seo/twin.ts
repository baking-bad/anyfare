import { checkQuery, parseCheckParams } from '../check/content';
import { parseFilters, filtersQuery } from '../calls/filters';
import { defaultPeriod, parsePeriod } from '../services/content';
import { parseServicesFilters, servicesQuery } from '../services/filters';

// The address of a page's Markdown twin for the page's own query. The one place that builds it: the
// `Link` header, the `<link>` tag, the Agent view and the tests all call it, so they say the same. It
// holds no server code, so the browser runs it too.

/** A query as a page receives it: the URL's parameters, or the framework's object, or the text after `?`. */
export type QuerySource = URLSearchParams | string | Readonly<Record<string, string | readonly string[] | undefined>>;

const asParams = (source: QuerySource): URLSearchParams => {
  if (source instanceof URLSearchParams)
    return source;
  if (typeof source === 'string')
    return new URLSearchParams(source);
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(source)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string')
      params.set(name, first);
  }

  return params;
};

/** The twin's path for a page's path, without a query: `/` is `/index.md`, `/services` is `/services.md`. */
export const twinPathOf = (pathname: string): string => pathname === '/' ? '/index.md' : `${pathname}.md`;

/**
 * The query a page's twin carries for the page's query: only what the page's data depends on, in a fixed order, the
 * default left out. Calls: the filters and the page. Services: the search, the sort and the page. A service:
 * the period. The check: the link, the method, the period and the page (the tab changes nothing the twin
 * says). Every other page has none. It is empty or starts with `?`.
 */
export const twinQuery = (pathname: string, source: QuerySource = ''): string => {
  const params = asParams(source);
  if (pathname === '/calls')
    return filtersQuery(parseFilters(params));
  if (pathname === '/services')
    return servicesQuery(parseServicesFilters(params));
  if (/^\/services\/[^/]+$/.test(pathname)) {
    const period = parsePeriod(params.get('period'));

    return period === defaultPeriod ? '' : `?period=${period}`;
  }
  if (pathname === '/check')
    return checkQuery({ ...parseCheckParams(params), tab: 'overview' });

  return '';
};

/** A page's twin as a path with its query, such as `/calls.md?paidWith=near&page=2`. */
export const twinHref = (pathname: string, source: QuerySource = ''): string => `${twinPathOf(pathname)}${twinQuery(pathname, source)}`;
