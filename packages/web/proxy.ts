import { NextResponse, type NextRequest } from 'next/server';

import { logApiFailure } from './src/api/failures';
import { createReader } from './src/api/reader';
import { visitorAddress } from './src/api/server';
import { readSettings, type SiteSettings } from './src/config';
import { hasMarkdown, markdownRoute, markdownUrl, pageForMarkdownUrl, prefersMarkdown } from './src/markdown/negotiate';
import { isReceiptId } from './src/receipt/content';
import { loadReceipt, missingHeader } from './src/receipt/data';
import { contentSecurityPolicy, createNonce, securityHeaders } from './src/security/csp';

// A page one level under /calls is a receipt, whatever its id
const receiptPage = /^\/calls\/([^/]+)$/;

// Where an unknown call is shown: a path with no page, so the site's 404 page answers with status 404 and
// server-rendered HTML. A page that throws notFound() streams its 404 as a bare shell that only scripts
// fill in. The 404 page says "No call with this id" when it sees the header the proxy sets for this path.
const missingReceipt = '/_/receipt-missing';

// How long the proxy waits for the API when it checks that a call exists. A slow API is not a missing call.
const existenceTimeoutMs = 3_000;

/**
 * The answer for a receipt page, when the proxy has one: the 404 page for an id that isn't one (no API
 * request is made) and for a call the API says doesn't exist. Anything else, the API being down or slow
 * included, is the page's to show. It runs only for `/calls/<id>`.
 */
const receiptResponse = async (request: NextRequest, requestHeaders: Headers, settings: SiteSettings): Promise<NextResponse | undefined> => {
  const id = receiptPage.exec(request.nextUrl.pathname)?.[1];
  if (id === undefined || (request.method !== 'GET' && request.method !== 'HEAD'))
    return undefined;
  const missing = (): NextResponse => NextResponse.rewrite(new URL(missingReceipt, request.url), { request: { headers: requestHeaders } });
  if (!isReceiptId(id))
    return missing();
  const read = createReader({ apiUrl: settings.apiInternalUrl, forwardedFor: visitorAddress(request.headers), timeoutMs: existenceTimeoutMs, onFailure: logApiFailure() });
  const result = await loadReceipt(read, id);

  return !result.ok && result.error.status === 404 ? missing() : undefined;
};

/**
 * Every request but static files. The Markdown twin of a page, for `<page>.md` or `Accept: text/markdown`,
 * is rewritten to its renderer. Every other request gets the Content-Security-Policy with a fresh nonce,
 * which Next.js adds to its own scripts when it finds it in the request's policy. A page that has a twin
 * answers a `Link` header that points to it, and `Vary: Accept`.
 *
 * The header that makes the 404 page say "No call with this id" is cleared from every incoming request,
 * so a visitor can't set it.
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
  // The rewrite to the missing receipt's path runs the proxy again: that pass tells the 404 page
  requestHeaders.delete(missingHeader);
  if (pathname === missingReceipt)
    requestHeaders.set(missingHeader, '1');
  const response = await receiptResponse(request, requestHeaders, readSettings()) ?? NextResponse.next({ request: { headers: requestHeaders } });
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
