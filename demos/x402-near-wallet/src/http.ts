// One HTTP request with a time limit, never redirected, and how far a failed one got.

import { scrubRpcUrl } from './rpc.ts';
import { Stop } from './util.ts';

export type Fetch = typeof fetch;

export const USER_AGENT = 'x402-near-wallet/0.1.0';

/** A time limit in words: "300 ms", "30 seconds". */
export const limitText = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} seconds`);

export interface RequestOptions {
  /** Any method, in upper case. */
  readonly method: string;
  readonly url: string;
  /** In order, as given. A `User-Agent` is added unless one is here. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: string;
  readonly timeoutMs: number;
  /** The most of the body to read. Default `MAX_BODY_BYTES`. */
  readonly maxBodyBytes?: number;
}

/** The most of a body that is read: more is left unread, and the answer says so. */
export const MAX_BODY_BYTES = 10_000_000;
/** The most of a body that is parsed as JSON, to read a 402 or an error: both are small. */
const MAX_JSON_BYTES = 1_000_000;

/** What came back. */
export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  /** The body as it came, at most `MAX_BODY_BYTES` of it. */
  readonly bytes: Uint8Array;
  /** The body was larger than `MAX_BODY_BYTES`: the rest was not read. */
  readonly truncated: boolean;
  /** The body as JSON, or as text when it is not JSON or too large to parse; `''` when it is empty. */
  readonly body: unknown;
  /** How long it took, from the request to the end of the body. */
  readonly ms: number;
}

/**
 * How far a failed request got. `not_sent`: `fetch` failed before any answer came, in a way that
 * means no connection was made, so the request never left: the host was not found, refused the
 * connection, or refused the TLS handshake. `timeout`: the time limit ran out before an answer came.
 * `unknown`: anything else, such as a connection that broke after the request was sent, or an answer
 * whose body broke after its status arrived.
 */
export type FailureStage = 'not_sent' | 'timeout' | 'unknown';

export interface RequestFailure {
  readonly stage: FailureStage;
  /** The network error's code, such as `ECONNREFUSED`. */
  readonly code: string | undefined;
  /** The status of the answer whose body broke. `undefined` when no answer came. */
  readonly status?: number;
}

// Errors that come before any byte of the request is written: no connection, or a TLS handshake that
// was refused. Not every TLS error: one in the middle of a connection can come after the request.
export const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
]);

/** How far a request got whose `fetch` failed before any answer came. */
function stageBeforeAnswer(code: string | undefined): FailureStage {
  return code !== undefined && NOT_SENT_CODES.has(code) ? 'not_sent' : 'unknown';
}

/** How far the request behind a `Stop` from `request` got, or `undefined` for any other error. */
export function failureOf(error: unknown): RequestFailure | undefined {
  const cause = error instanceof Stop ? error.cause : undefined;
  if (typeof cause !== 'object' || cause === null || !('stage' in cause)) return undefined;
  return cause as RequestFailure;
}

const isTimeout = (error: unknown): boolean => {
  const name = (error as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
};

/**
 * The network error's code, and a reason to print: the code, or a few plain words with nothing of
 * the URL in them. The URL may hold a key in its path or query, so its own text is never quoted.
 */
function reasonOf(error: unknown, url: string): { readonly code: string | undefined; readonly reason: string } {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  if (code !== undefined && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return { code, reason: code };
  const words = typeof cause?.message === 'string' ? scrubRpcUrl(cause.message, url).trim() : '';
  return { code, reason: /^[A-Za-z][A-Za-z ]{0,39}$/.test(words) ? words : 'the connection failed' };
}

function hostOf(url: string): string {
  return URL.parse(url)?.host ?? 'the host';
}

function headersOf(options: RequestOptions): [string, string][] {
  const headers = options.headers.map(([name, value]): [string, string] => [name, value]);
  if (!headers.some(([name]) => name.toLowerCase() === 'user-agent')) headers.push(['User-Agent', USER_AGENT]);
  return headers;
}

function bodyOf(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return '';
  const text = new TextDecoder().decode(bytes);
  if (bytes.length > MAX_JSON_BYTES) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** At most `limit` bytes of a body. The rest is left unread, and its stream cancelled. */
async function readBody(response: Response, limit: number): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  if (response.body === null) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > limit) {
      chunks.push(value.subarray(0, limit - size));
      size = limit;
      truncated = true;
      // Not waited for: the answer is read as far as it is wanted
      void reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, truncated };
}

/**
 * One request with a time limit, never redirected: a redirect is answered as it is. A network
 * failure or a timeout is a `Stop` that names the host and carries a `RequestFailure`: only a
 * `fetch` that failed before any answer can be `not_sent`.
 */
export async function request(fetchFn: Fetch, options: RequestOptions): Promise<Answer> {
  const host = hostOf(options.url);
  const started = performance.now();
  const signal = AbortSignal.timeout(options.timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(options.url, {
      method: options.method,
      headers: headersOf(options),
      ...(options.body !== undefined && { body: options.body }),
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new Stop(`${host} did not answer within ${limitText(options.timeoutMs)}`, {
        cause: { stage: 'timeout', code: undefined } satisfies RequestFailure,
      });
    }
    const { code, reason } = reasonOf(error, options.url);
    throw new Stop(`Could not reach ${host}: ${reason}`, {
      cause: { stage: stageBeforeAnswer(code), code } satisfies RequestFailure,
    });
  }
  // The answer has begun, so the request was sent: whatever breaks from here, it is not "never sent"
  const status = response.status;
  try {
    const { bytes, truncated } = await readBody(response, options.maxBodyBytes ?? MAX_BODY_BYTES);
    return { status, headers: response.headers, bytes, truncated, body: bodyOf(bytes), ms: performance.now() - started };
  } catch (error) {
    const { code, reason } = isTimeout(error) ? { code: undefined, reason: 'it did not finish in time' } : reasonOf(error, options.url);
    throw new Stop(`${host} answered ${status}, but its body broke: ${reason}`, {
      cause: { stage: 'unknown', code, status } satisfies RequestFailure,
    });
  }
}
