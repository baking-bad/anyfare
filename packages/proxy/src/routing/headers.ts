import type { IncomingHttpHeaders } from 'node:http';

import { requestIdHeader } from '@anyfare/common';

type ResponseHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

// The only standard buyer request headers a target sees. Everything else is dropped, including
// Authorization, Cookie, and the payment headers. content-length is computed again from the body.
// A paid call is never conditional: a target's 304 would keep our payment while the buyer pays
// nothing, so If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since, and If-Range stay out.
export const forwardedRequestHeaders: ReadonlySet<string> = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'content-digest', 'content-encoding', 'content-language',
  'content-length', 'content-type', 'digest', 'idempotency-key', 'prefer', 'range', 'repr-digest', 'want-content-digest', 'want-digest',
  'want-repr-digest',
]);

// The only target response headers a buyer sees. Never Set-Cookie: every target shares the pay origin.
export const forwardedResponseHeaders: ReadonlySet<string> = new Set([
  'accept-ranges', 'age', 'allow', 'cache-control', 'content-digest', 'content-disposition', 'content-encoding', 'content-language',
  'content-length', 'content-range', 'content-type', 'deprecation', 'digest', 'etag', 'expires', 'last-modified', 'preference-applied',
  'ratelimit', 'ratelimit-policy', 'repr-digest', 'retry-after', 'sunset', 'vary', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'x-ratelimit-reset', 'location', 'content-location', 'link',
]);

// The target's payment headers. They answer our payment, never the buyer's, so they never reach the buyer.
export const targetPaymentHeaders: ReadonlySet<string> = new Set([
  'payment-required', 'payment-response', 'www-authenticate', 'x-payment-response', 'payment-receipt',
]);

// A buyer's own `X-…` headers reach the target, such as `X-Api-Key`, but none of ours, the proxies' in
// front, or the payment protocols'
const reservedXHeaders = /^x-(?:forwarded|real-ip|request-id|internal|signer|payment)/;

/**
 * The headers a routed request sends the target: the allowlist, the buyer's own `X-…` headers, and our
 * request ID. Never Authorization or Cookie: the buyer's credential pays us, not the target.
 */
export const routedRequestHeaders = (headers: IncomingHttpHeaders, requestId: string): Record<string, string | readonly string[]> => {
  const result: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || lower === 'content-length')
      continue;
    if (forwardedRequestHeaders.has(lower) || (lower.startsWith('x-') && !reservedXHeaders.test(lower)))
      result[lower] = value;
  }
  result[requestIdHeader] = requestId;

  return result;
};

// Splits a Link header on the commas between links, not those inside a URI or a quoted parameter
const splitLinks = (value: string): string[] => {
  const links: string[] = [];
  let current = '';
  let inUri = false;
  let inQuotes = false;
  for (const character of value) {
    if (character === '"' && !inUri)
      inQuotes = !inQuotes;
    else if (character === '<' && !inQuotes)
      inUri = true;
    else if (character === '>' && !inQuotes)
      inUri = false;
    else if (character === ',' && !inUri && !inQuotes) {
      links.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  links.push(current.trim());

  return links.filter(link => link !== '');
};

/** Rewrites each link's URI in a Link header, dropping those the rewriter drops. Undefined when none is left. */
export const rewriteLinkHeader = (value: string, rewrite: (url: string) => string | undefined): string | undefined => {
  const links = splitLinks(value).flatMap(link => {
    const parts = /^<([^>]*)>(.*)$/s.exec(link);
    const target = parts ? rewrite(parts[1]!) : undefined;

    return target === undefined ? [] : [`<${target}>${parts![2]}`];
  });

  return links.length > 0 ? links.join(', ') : undefined;
};

/**
 * The target response headers a buyer may see: the allowlist, with `Location`, `Content-Location`, and
 * `Link` rewritten, and the target's payment headers dropped.
 */
export const filterResponseHeaders = (headers: ResponseHeaders, rewrite: (url: string) => string | undefined): Record<string, string | string[]> => {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || !forwardedResponseHeaders.has(lower) || targetPaymentHeaders.has(lower))
      continue;

    const values = typeof value === 'string' ? [value] : [...value];
    const kept = lower === 'link'
      ? values.flatMap(item => rewriteLinkHeader(item, rewrite) ?? [])
      : lower === 'location' || lower === 'content-location'
        ? values.flatMap(item => rewrite(item) ?? [])
        : values;
    if (kept.length > 0)
      result[lower] = kept.length === 1 ? kept[0]! : kept;
  }

  return result;
};

export interface RoutingLinkOptions {
  // The canonical pay URL from platform config, never the request's Host
  readonly payUrl: string;
  // The target's host, with its port when not 443, and the URL called, which relative references resolve against
  readonly target: { readonly host: string; readonly url: string };
}

/**
 * Rewrites a URL from a target header: one on the target's origin becomes its routing link,
 * `<pay URL>/<host><path>`, so the buyer's next call goes through us too. One on another origin is
 * kept as it is, and one that isn't a URL is dropped (undefined).
 */
export const createRoutingLinkRewriter = ({ payUrl, target }: RoutingLinkOptions) => {
  const base = payUrl.replace(/\/+$/, '');
  const origin = `https://${target.host}`;

  return (value: string): string | undefined => {
    let url: URL;
    try {
      url = new URL(value, target.url);
    }
    catch {
      return undefined;
    }

    return url.origin === origin ? `${base}/${target.host}${url.pathname}${url.search}${url.hash}` : value;
  };
};

/** A routed answer's headers for the buyer: the allowlist, its links to the target through the routing link. */
export const routedResponseHeaders = (headers: ResponseHeaders, options: RoutingLinkOptions): Record<string, string | string[]> =>
  filterResponseHeaders(headers, createRoutingLinkRewriter(options));
