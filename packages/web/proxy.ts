import { NextResponse, type NextRequest } from 'next/server';

import { readSettings } from './src/config';
import { contentSecurityPolicy, createNonce, securityHeaders } from './src/security/csp';

/**
 * Every request but static files: the Content-Security-Policy with a fresh nonce. Next.js adds the
 * nonce to its own scripts when it finds it in the request's policy.
 */
export const proxy = (request: NextRequest): NextResponse => {
  const { apiUrl, payUrl } = readSettings();
  const nonce = createNonce();
  const policy = contentSecurityPolicy({ nonce, apiUrl, payUrl, development: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  for (const [name, value] of Object.entries(securityHeaders))
    response.headers.set(name, value);

  return response;
};

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image).*)' }],
};
