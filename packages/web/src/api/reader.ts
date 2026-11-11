import { ApiError, callApi, defaultTimeoutMs, type ApiFailure } from './http';

// A read of the public API that never throws: a failed or slow read is a value. A page keeps every section
// apart, so one failed read shows its own error state and the rest of the page renders.

/** What a failed read tells the page: enough to word an error state, never a detail that leaks. */
export interface ReadFailure {
  // The API's HTTP status, or 503 when it didn't answer
  readonly status: number;
  // The API's error code, `api_unavailable`, or `unexpected_answer`
  readonly code: string;
  readonly message: string;
}

export type ApiResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: ReadFailure };

/** Reads one path of the API. `check` rejects an answer that isn't the shape the page needs. */
export type Reader = <TValue>(path: string, check?: (value: unknown) => value is TValue, options?: ReadOptions) => Promise<ApiResult<TValue>>;

/** What one read adds to the reader's own: more request headers. */
export interface ReadOptions {
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ReaderOptions {
  // The API's origin, as the code that reads it reaches it
  readonly apiUrl: string;
  // The visitor's address, for the API's per-IP limit. Only a server read has one.
  readonly forwardedFor?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly onFailure?: (failure: ApiFailure) => void;
}

const unexpected: ReadFailure = { status: 502, code: 'unexpected_answer', message: 'The Platform API answered with something this page can\'t read.' };

export const createReader = ({ apiUrl, forwardedFor, timeoutMs = defaultTimeoutMs, fetch: fetchFn, onFailure }: ReaderOptions): Reader =>
  async <TValue>(path: string, check?: (value: unknown) => value is TValue, options?: ReadOptions): Promise<ApiResult<TValue>> => {
    try {
      const value = await callApi<unknown>(apiUrl, {
        path,
        timeoutMs,
        headers: { ...forwardedFor === undefined || forwardedFor === '' ? {} : { 'x-forwarded-for': forwardedFor }, ...options?.headers },
        ...fetchFn === undefined ? {} : { fetch: fetchFn },
        ...onFailure === undefined ? {} : { onFailure },
      });
      if (check !== undefined ? !check(value) : value === undefined)
        return { ok: false, error: unexpected };

      return { ok: true, value: value as TValue };
    }
    catch (error) {
      if (error instanceof ApiError)
        return { ok: false, error: { status: error.status, code: error.code, message: error.message } };

      return { ok: false, error: { status: 503, code: 'api_unavailable', message: 'The Platform API didn\'t answer. Try again in a moment.' } };
    }
  };

/** The value of a read, or `undefined` when it failed. */
export const valueOf = <TValue>(result: ApiResult<TValue>): TValue | undefined => result.ok ? result.value : undefined;
