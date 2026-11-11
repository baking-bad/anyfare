import { readSettings, type SiteSettings } from '../config';
import { logApiFailure } from './failures';
import { createReader, type Reader } from './reader';

/** The visitor's address as the proxy in front of the website saw it, from the request's headers. */
export const visitorAddress = (headers: Headers): string | undefined =>
  headers.get('x-forwarded-for')?.trim() || headers.get('x-real-ip')?.trim() || undefined;

/**
 * A reader for the server: it calls `API_INTERNAL_URL`, forwards the visitor's address in
 * `X-Forwarded-For` so the API's per-IP limit counts the visitor and not this server, and logs each
 * failed read.
 */
export const serverReader = (incoming: Headers, settings: SiteSettings = readSettings()): Reader =>
  createReader({ apiUrl: settings.apiInternalUrl, forwardedFor: visitorAddress(incoming), onFailure: logApiFailure() });

/** How long a read of the pay host's check waits: the pay host makes a request to an outside host, which can be slow. */
export const checkTimeoutMs = 15_000;

/**
 * A reader for the pay host, at `PAY_INTERNAL_URL`. It forwards the visitor's address in `X-Forwarded-For`,
 * so the pay host's per-IP limit counts the visitor and not this server. A failed read is logged with its
 * path and no query: the visitor's link is never in the log.
 */
export const payReader = (incoming: Headers, settings: SiteSettings = readSettings()): Reader =>
  createReader({ apiUrl: settings.payInternalUrl, forwardedFor: visitorAddress(incoming), timeoutMs: checkTimeoutMs, onFailure: logApiFailure() });
