import type { SiteSettings } from './config';

// One app answers two hosts: the public site (`SITE_URL`) and the console (`CONSOLE_URL`). The console will hold
// a person's master key in the browser and the public pages show text that comes from outside hosts, so each
// host serves its own pages and never the other's. Which host a request is for is decided here, from the `Host`
// header and the two settings, and nothing else.

/**
 * What a request is for. `site`: the public pages (every host that isn't the console's, such as an IP address,
 * `localhost` or a forged name, so health checks and local runs work). `console`: the console. `shared`: the two
 * settings name one host, so everything is served and the Console page also lives at `/console`.
 */
export type Surface = 'site' | 'console' | 'shared';

export type Hosts = Pick<SiteSettings, 'siteUrl' | 'consoleUrl'>;

/** The console's pages besides its Overview, which is at `/` on the console host. */
export const consolePaths: readonly string[] = ['/topup', '/keys', '/payments', '/settings', '/signin'];

/** Where the console's Overview lives when the two hosts are one. */
export const sharedConsolePath = '/console';

/** The route of the console's Overview. The other pages' routes are under it. Only the proxy leads to them, and only for the console. */
export const consolePageRoute = '/_/console';

/** The internal route of a console page: the Overview's, or `/_/console/keys` for `/keys`. */
export const consoleRouteOf = (pathname: string): string => consolePaths.includes(pathname) ? `${consolePageRoute}${pathname}` : consolePageRoute;

/** Every internal route of the console. */
export const consoleRoutes: readonly string[] = [consolePageRoute, ...consolePaths.map(path => `${consolePageRoute}${path}`)];

/** Whether a path is the console's internal route, or under it. */
export const isConsoleRoute = (pathname: string): boolean => pathname === consolePageRoute || pathname.startsWith(`${consolePageRoute}/`);

/** A path with no route, where the proxy sends what a host must not serve, so the 404 page answers. */
export const hiddenRoute = '/_/hidden';

// A host as a browser sends it: letters, digits, dots, hyphens, an IPv6 address in brackets, and a port
const hostHeaderPattern = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * A host as `host:port` in lower case, without a trailing dot, and without the port the scheme implies, so
 * `Console.Example.com.:443` and `console.example.com` are one host under `https:`. Undefined for a value
 * that isn't a host.
 */
export const hostKey = (host: string | null | undefined, protocol: string): string | undefined => {
  const value = host?.trim() ?? '';
  if (!hostHeaderPattern.test(value))
    return undefined;
  try {
    const url = new URL(`${protocol}//${value}`);

    return url.host.replace(/\.(?=$|:)/, '');
  }
  catch {
    return undefined;
  }
};

const settingKey = (origin: string): string => {
  const { protocol } = new URL(origin);

  return hostKey(new URL(origin).host, protocol)!;
};

/**
 * The host a request is for. Only the `Host` header counts. `X-Forwarded-Host` is ignored: any client can send
 * it, and a proxy that doesn't strip it would let a visitor choose the host. The stack's proxy passes the
 * original `Host` on, so a deployment needs nothing more.
 */
export const surfaceOf = (host: string | null | undefined, { siteUrl, consoleUrl }: Hosts): Surface => {
  const consoleKey = settingKey(consoleUrl);
  if (settingKey(siteUrl) === consoleKey)
    return 'shared';

  return hostKey(host, new URL(consoleUrl).protocol) === consoleKey ? 'console' : 'site';
};

/** What a path is on a surface: a public page or file, the Console page, or something the host doesn't serve. */
export type Verdict = 'public' | 'console' | 'hidden';

// What the console host serves as it is, besides the paths of the console: health, the icons and the logo, robots.txt,
// the logos of networks and tokens (Top up shows them), and the framework's files
const consoleFiles: readonly string[] = ['/_/health', '/icon', '/apple-icon', '/favicon.ico', '/logo.svg', '/robots.txt', hiddenRoute];
const consoleFilePrefixes: readonly string[] = ['/_next/', '/__nextjs', '/logos/'];

export const verdictFor = (surface: Surface, pathname: string): Verdict => {
  // The console's own routes are for the proxy's rewrite only: asked for directly, no host serves them
  if (isConsoleRoute(pathname))
    return 'hidden';
  if (surface === 'site')
    return 'public';
  if (surface === 'shared')
    return pathname === sharedConsolePath || consolePaths.includes(pathname) ? 'console' : 'public';
  if (pathname === '/' || consolePaths.includes(pathname))
    return 'console';

  return consoleFiles.includes(pathname) || consoleFilePrefixes.some(prefix => pathname.startsWith(prefix)) ? 'public' : 'hidden';
};

/** Whether the two settings name one host. */
export const isOneHost = ({ siteUrl, consoleUrl }: Hosts): boolean => settingKey(siteUrl) === settingKey(consoleUrl);

/** The console's address, with `path` after it (such as `/topup`). When the hosts are one, the Overview is `/console`. */
export const consoleLink = (hosts: Hosts, path = ''): string =>
  path === '' && isOneHost(hosts) ? `${hosts.consoleUrl}${sharedConsolePath}` : `${hosts.consoleUrl}${path}`;

/** The path of the console's Overview on its host: `/`, or `/console` when the hosts are one. */
export const consoleOverviewPath = (hosts: Hosts): string => isOneHost(hosts) ? sharedConsolePath : '/';

// The host a request is for travels to the pages in a request header. The proxy sets it on every request and
// drops any value the client sent, so a visitor can't choose it.
export const surfaceHeader = 'x-surface';

/** The surface a header value names. Anything else is the public site. */
export const surfaceFromHeader = (value: string | null): Surface => value === 'console' || value === 'shared' ? value : 'site';

// A rewrite runs the proxy again on its target, and the host of that second request is not the visitor's. The
// proxy marks what it rewrites with a value that only this process knows, and trusts the surface of a request
// that carries it, on the two routes it rewrites to. A visitor can't guess the value.
export const passHeader = 'x-surface-pass';
export const passSecret = crypto.randomUUID();
