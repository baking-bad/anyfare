// The Content-Security-Policy every page gets. Scripts run only from the site with this request's
// nonce, nothing third-party loads, and the browser talks only to the site, the Platform API and the
// pay host.

export interface CspOptions {
  readonly nonce: string;
  // The public Platform API and pay host, as the browser reaches them
  readonly apiUrl: string;
  readonly payUrl: string;
  // `next dev` needs eval, inline styles and its websocket
  readonly development: boolean;
  // The console host's pages talk only to the site itself and the Platform API
  readonly console?: boolean;
}

export const contentSecurityPolicy = ({ nonce, apiUrl, payUrl, development, console: forConsole = false }: CspOptions): string => {
  const origins = [...new Set(forConsole ? [new URL(apiUrl).origin] : [new URL(apiUrl).origin, new URL(payUrl).origin])];

  return [
    'default-src \'self\'',
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? ' \'unsafe-eval\'' : ''}`,
    `style-src 'self'${development ? ' \'unsafe-inline\'' : ''}`,
    'img-src \'self\' data:',
    'font-src \'self\'',
    `connect-src ${['\'self\'', ...origins, ...development ? ['ws:'] : []].join(' ')}`,
    'frame-ancestors \'none\'',
    'base-uri \'self\'',
    'form-action \'self\'',
    'object-src \'none\'',
  ].join('; ');
};

/** A fresh nonce for one response: 128 random bits, base64. */
export const createNonce = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

/** Headers every response carries, beside the policy. */
export const securityHeaders: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
