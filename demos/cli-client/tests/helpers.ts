import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import type { Io } from '../src/cli.ts';
import type { Fetch } from '../src/http.ts';

export interface Fixture {
  readonly note: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly [key: string]: unknown;
}

/** A fixture file from tests/fixtures. Each starts with a `note` that says where it comes from. */
export function fixture(name: string): Fixture {
  const raw = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const data = JSON.parse(raw) as Fixture;
  if (typeof data.note !== 'string') throw new Error(`${name} has no note`);
  return data;
}

/** The answer a fixture with a status, headers and body stands for. */
export function answerOf(name: string): Response {
  const { status = 200, headers = {}, body = {} } = fixture(name);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A fetch that answers by method and URL: the keys look like `GET https://host/path`. Others fail like a dead host. */
export function fakeFetch(routes: Readonly<Record<string, () => Response>>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const route = routes[`${method} ${url}`];
    if (route === undefined) {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    }
    return route();
  }) as Fetch;
  return { fetch: fetchFn, calls };
}

/** An Io that keeps what is written to it. */
export function captureIo(fetchFn: Fetch, env: Record<string, string> = {}) {
  let out = '';
  let err = '';
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        append(chunk.toString());
        done();
      },
    });
  const io: Io = {
    stdout: sink((text) => (out += text)),
    stderr: sink((text) => (err += text)),
    stdin: new PassThrough(),
    isTerminal: false,
    env,
    fetch: fetchFn,
  };
  return { io, out: () => out, err: () => err };
}
