import { NextResponse, type NextRequest } from 'next/server';

import { logApiFailure } from './src/api/failures';
import { createReader } from './src/api/reader';
import { visitorAddress } from './src/api/server';
import { amountParam, amountUnusedParam, linkAmount } from './src/console/amount';
import { readSettings, type SiteSettings } from './src/config';
import { consoleRouteOf, consoleRoutes, hiddenRoute, passHeader, passSecret, surfaceFromHeader, surfaceHeader, surfaceOf, verdictFor, type Surface } from './src/hosts';
import { hasMarkdown, markdownRoute, pageForMarkdownUrl, prefersMarkdown } from './src/markdown/negotiate';
import { fromCheckName, fromCheckValue } from './src/services/content';
import { asksMissingMarkdown, missingMarkdown } from './src/missing/routes';
import { listingPath, maxMissingName, missingKindHeader, missingNameHeader, missingPageFor, missingPageOfKind, missingPath, missingState } from './src/missing/pages';
import { linkHeader } from './src/seo/links';
import { contentSecurityPolicy, createNonce, securityHeaders } from './src/security/csp';

// How long the proxy waits for the API when it checks that a thing exists. A slow API is not a missing thing.
const existenceTimeoutMs = 3_000;

/**
 * The answer for a page whose address names a thing that may not exist (see src/missing/pages.ts), when the
 * proxy has one: the 404 page for a name that can't be a thing (no API request is made) and for a thing the
 * API says doesn't exist, with the wording of that page. Anything else, the API being down or slow
 * included, is the page's to show. It runs only for GET and HEAD of those pages.
 */
const missingResponse = async (request: NextRequest, requestHeaders: Headers, settings: SiteSettings): Promise<NextResponse | undefined> => {
  const entry = missingPageFor(request.nextUrl.pathname);
  if (entry === undefined || (request.method !== 'GET' && request.method !== 'HEAD'))
    return undefined;
  const { page, name } = entry;
  const read = createReader({ apiUrl: settings.apiInternalUrl, forwardedFor: visitorAddress(request.headers), timeoutMs: existenceTimeoutMs, onFailure: logApiFailure() });
  const state = await missingState(page, read, name, { afterCheck: request.nextUrl.searchParams.get(fromCheckName) === fromCheckValue });
  if (state === 'found')
    return undefined;
  if (state === 'listing') {
    // Too many are waiting for a just-checked service: the page says it is being listed, with a 200 that no search engine keeps
    const waiting = request.nextUrl.clone();
    waiting.pathname = listingPath;
    waiting.search = '';
    waiting.searchParams.set('name', name.slice(0, maxMissingName));

    return NextResponse.rewrite(waiting, { request: { headers: requestHeaders } });
  }
  // Built from the request's own address with only the path changed: no host of the request is a target
  const target = request.nextUrl.clone();
  target.pathname = `${missingPath}/${page.kind}`;
  target.search = '';
  target.searchParams.set('name', name.slice(0, maxMissingName));

  return NextResponse.rewrite(target, { request: { headers: requestHeaders } });
};

/**
 * Where a request that isn't a public page goes: the 404 page for what the host doesn't serve, or the console page's
 * internal route. The address is the request's own with only the path (and, for a top-up link, the amount) changed:
 * no other part of the visitor's query goes on.
 */
const rewriteTarget = (request: NextRequest, verdict: 'console' | 'hidden'): URL => {
  const { pathname, searchParams } = request.nextUrl;
  const target = request.nextUrl.clone();
  target.search = '';
  if (verdict === 'hidden') {
    target.pathname = hiddenRoute;

    return target;
  }
  target.pathname = consoleRouteOf(pathname);
  // A top-up link's amount is read here from the path the visitor asked for, and travels as a number, or as
  // the flag that the link's amount was not used
  const link = pathname === '/topup' ? linkAmount(searchParams.getAll(amountParam)) : { kind: 'none' as const };
  if (link.kind === 'used')
    target.searchParams.set(amountParam, String(link.amount));
  else if (link.kind === 'unused')
    target.searchParams.set(amountUnusedParam, '1');

  return target;
};

/**
 * Every request but static files. First, which host it is for (see src/hosts.ts): the console host serves the
 * console's pages and a few files and answers 404 to everything else, and the public host never serves a
 * console page. Then, for a public request: the Markdown twin of a page, for `<page>.md` or `Accept: text/markdown`,
 * is rewritten to its renderer. Every other request gets the Content-Security-Policy with a fresh nonce,
 * which Next.js adds to its own scripts when it finds it in the request's policy. A page that has a twin
 * answers a `Link` header that points to it, and `Vary: Accept`.
 *
 * The headers that make the 404 page say what is missing are cleared from every incoming request, so a
 * visitor can't set them.
 */
export const proxy = async (request: NextRequest): Promise<NextResponse> => {
  const { pathname } = request.nextUrl;
  const settings = readSettings();
  const { siteUrl, apiUrl, payUrl } = settings;
  // The second pass of one of this proxy's own rewrites keeps the first pass's surface; any other request is decided by its Host
  const second = (consoleRoutes.includes(pathname) || pathname === hiddenRoute) && request.headers.get(passHeader) === passSecret;
  const hostSurface: Surface = second ? surfaceFromHeader(request.headers.get(surfaceHeader)) : surfaceOf(request.headers.get('host'), settings);
  const verdict = second ? 'public' : verdictFor(hostSurface, pathname);
  // A console page is served as the console host's, with its policy and its layout, even when the two hosts are one
  const surface: Surface = verdict === 'console' ? 'console' : hostSurface;
  const onConsole = surface === 'console';
  const page = onConsole ? undefined : pageForMarkdownUrl(pathname) ?? (hasMarkdown(pathname) && prefersMarkdown(request.headers.get('accept')) ? pathname : undefined);
  if (page !== undefined) {
    const url = request.nextUrl.clone();
    url.pathname = markdownRoute(page);
    const response = NextResponse.rewrite(url);
    response.headers.set('vary', 'Accept');
    for (const [name, value] of Object.entries(securityHeaders))
      response.headers.set(name, value);

    return response;
  }

  // A path with no page, asked as Markdown: a Markdown 404, not the HTML page
  if (!onConsole && verdict === 'public' && asksMissingMarkdown(pathname, prefersMarkdown(request.headers.get('accept')))) {
    const response = new NextResponse(missingMarkdown(siteUrl), { status: 404, headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept' } });
    for (const [name, value] of Object.entries(securityHeaders))
      response.headers.set(name, value);

    return response;
  }

  const nonce = createNonce();
  const policy = contentSecurityPolicy({ nonce, apiUrl, payUrl, development: process.env.NODE_ENV === 'development', console: onConsole });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Set on every request, so a value the client sent never reaches a page
  requestHeaders.set(surfaceHeader, surface);
  requestHeaders.delete(passHeader);
  if (verdict !== 'public')
    requestHeaders.set(passHeader, passSecret);
  requestHeaders.set('content-security-policy', policy);
  // The rewrite to a missing thing's path runs the proxy again: that pass tells the 404 page what is missing
  requestHeaders.delete(missingKindHeader);
  requestHeaders.delete(missingNameHeader);
  const missingKind = pathname.startsWith(`${missingPath}/`) ? pathname.slice(missingPath.length + 1) : undefined;
  if (missingPageOfKind(missingKind ?? null) !== undefined) {
    requestHeaders.set(missingKindHeader, missingKind!);
    // A header holds ASCII only: the name travels encoded
    requestHeaders.set(missingNameHeader, encodeURIComponent((request.nextUrl.searchParams.get('name') ?? '').slice(0, maxMissingName)));
  }
  const response = verdict === 'public'
    ? await missingResponse(request, requestHeaders, settings) ?? NextResponse.next({ request: { headers: requestHeaders } })
    : NextResponse.rewrite(rewriteTarget(request, verdict), { request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  if (onConsole)
    response.headers.set('x-robots-tag', 'noindex, nofollow');
  const links = onConsole ? undefined : linkHeader({ siteUrl, apiUrl }, pathname, request.nextUrl.searchParams);
  if (links !== undefined) {
    response.headers.set('vary', 'Accept');
    // Appended: Next.js adds its own preload hints to this header
    response.headers.append('link', links);
  }
  for (const [name, value] of Object.entries(securityHeaders))
    response.headers.set(name, value);

  return response;
};

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image).*)' }],
};
