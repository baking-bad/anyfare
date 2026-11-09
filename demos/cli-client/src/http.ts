import { Stop, readBody } from './util.ts';

export type Fetch = typeof fetch;

export const USER_AGENT = 'anyfare-cli-client/0.1.0';

export interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  /** `manual` answers a redirect as it is, instead of sending a second request. */
  readonly redirect?: 'follow' | 'manual';
}

/** What came back: the status, the headers, and the body as JSON, or as text when it is not JSON. */
export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
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
  const name = (error as { name?: string }).name;
  return name === 'TimeoutError' || name === 'AbortError';
};

function codeOf(error: unknown): { code: string | undefined; reason: string } {
  const cause = (error as { cause?: { code?: unknown; message?: string } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  return { code, reason: code ?? cause?.message ?? (error instanceof Error ? error.message : 'unknown error') };
}

/** A time limit in words: "300 ms", "30 seconds". */
export const limitText = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} seconds`);

/**
 * One request with a time limit. A network failure or a timeout is a `Stop` that names the host and
 * carries a `RequestFailure`: only a `fetch` that failed before any answer can be `not_sent`.
 */
export async function request(fetchFn: Fetch, options: RequestOptions): Promise<Answer> {
  const host = hostOf(options.url);
  let response: Response;
  try {
    response = await fetchFn(options.url, {
      method: options.method,
      headers: { 'user-agent': USER_AGENT, ...options.headers },
      ...(options.body !== undefined && { body: options.body }),
      ...(options.redirect !== undefined && { redirect: options.redirect }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new Stop(`${host} did not answer within ${limitText(options.timeoutMs)}`, {
        cause: { stage: 'timeout', code: undefined } satisfies RequestFailure,
      });
    }
    const { code, reason } = codeOf(error);
    throw new Stop(`Could not reach ${host}: ${reason}`, {
      cause: { stage: stageBeforeAnswer(code), code } satisfies RequestFailure,
    });
  }
  // The answer has begun, so the request was sent: whatever breaks from here, it is not "never sent"
  const status = response.status;
  try {
    return { status, headers: response.headers, body: await readBody(response) };
  } catch (error) {
    const { code, reason } = isTimeout(error) ? { code: undefined, reason: 'it did not finish in time' } : codeOf(error);
    throw new Stop(`${host} answered ${status}, but its body broke: ${reason}`, {
      cause: { stage: 'unknown', code, status } satisfies RequestFailure,
    });
  }
}
