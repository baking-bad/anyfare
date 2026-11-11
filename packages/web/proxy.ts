import { NextResponse, type NextRequest } from 'next/server';

import { logApiFailure } from './src/api/failures';
import { createReader } from './src/api/reader';
import { visitorAddress } from './src/api/server';
import { readSettings, type SiteSettings } from './src/config';
import { hasMarkdown, markdownRoute, markdownUrl, pageForMarkdownUrl, prefersMarkdown } from './src/markdown/negotiate';
import { isMissing, maxMissingName, missingKindHeader, missingNameHeader, missingPageFor, missingPageOfKind, missingPath } from './src/missing/pages';
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
  if (!await isMissing(page, read, name))
    return undefined;
  const target = new URL(`${missingPath}/${page.kind}`, request.url);
  target.searchParams.set('name', name.slice(0, maxMissingName));

  return NextResponse.rewrite(target, { request: { headers: requestHeaders } });
};

/**
 * Every request but static files. The Markdown twin of a page, for `<page>.md` or `Accept: text/markdown`,
 * is rewritten to its renderer. Every other request gets the Content-Security-Policy with a fresh nonce,
 * which Next.js adds to its own scripts when it finds it in the request's policy. A page that has a twin
 * answers a `Link` header that points to it, and `Vary: Accept`.
 *
 * The headers that make the 404 page say what is missing are cleared from every incoming request, so a
 * visitor can't set them.
 */
export const proxy = async (request: NextRequest): Promise<NextResponse> => {
  const { pathname } = request.nextUrl;
  const { siteUrl, apiUrl, payUrl } = readSettings();
  const page = pageForMarkdownUrl(pathname) ?? (hasMarkdown(pathname) && prefersMarkdown(request.headers.get('accept')) ? pathname : undefined);
  if (page !== undefined) {
    const url = request.nextUrl.clone();
    url.pathname = markdownRoute(page);
    const response = NextResponse.rewrite(url);
    response.headers.set('vary', 'Accept');
    for (const [name, value] of Object.entries(securityHeaders))
      response.headers.set(name, value);

    return response;
  }

  const nonce = createNonce();
  const policy = contentSecurityPolicy({ nonce, apiUrl, payUrl, development: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
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
  const response = await missingResponse(request, requestHeaders, readSettings()) ?? NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  if (hasMarkdown(pathname)) {
    response.headers.set('vary', 'Accept');
    response.headers.set('link', `<${siteUrl}${markdownUrl(pathname)}>; rel="alternate"; type="text/markdown"`);
  }
  for (const [name, value] of Object.entries(securityHeaders))
    response.headers.set(name, value);

  return response;
};

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image).*)' }],
};
