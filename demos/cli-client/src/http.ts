import { Stop, readBody } from './util.ts';

export type Fetch = typeof fetch;

export const USER_AGENT = 'anyfare-cli-client/0.1.0';

export interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
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

/** One request with a time limit. A network failure or a timeout is a `Stop` that names the host. */
export async function request(fetchFn: Fetch, options: RequestOptions): Promise<Answer> {
  const host = hostOf(options.url);
  try {
    const response = await fetchFn(options.url, {
      method: options.method,
      headers: { 'user-agent': USER_AGENT, ...options.headers },
      ...(options.body !== undefined && { body: options.body }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return { status: response.status, headers: response.headers, body: await readBody(response) };
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      const limit =
        options.timeoutMs < 1000 ? `${options.timeoutMs} ms` : `${Math.round(options.timeoutMs / 1000)} seconds`;
      throw new Stop(`${host} did not answer within ${limit}`);
    }
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : 'unknown error');
    throw new Stop(`Could not reach ${host}: ${reason}`);
  }
}
