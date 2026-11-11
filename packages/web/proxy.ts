import { NextResponse, type NextRequest } from 'next/server';

import { readSettings } from './src/config';
import { hasMarkdown, markdownRoute, markdownUrl, pageForMarkdownUrl, prefersMarkdown } from './src/markdown/negotiate';
import { contentSecurityPolicy, createNonce, securityHeaders } from './src/security/csp';

/**
 * Every request but static files. The Markdown twin of a page, for `<page>.md` or `Accept: text/markdown`,
 * is rewritten to its renderer. Every other request gets the Content-Security-Policy with a fresh nonce,
 * which Next.js adds to its own scripts when it finds it in the request's policy. A page that has a twin
 * answers a `Link` header that points to it, and `Vary: Accept`.
 */
export const proxy = (request: NextRequest): NextResponse => {
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
  const response = NextResponse.next({ request: { headers: requestHeaders } });
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
