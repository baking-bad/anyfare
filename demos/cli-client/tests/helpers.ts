import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** An answer whose body breaks after its status arrived, with a network error of this code. */
export function brokenAnswer(status: number, code: string, headers: HeadersInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError('terminated', { cause: Object.assign(new Error(`Made up: ${code}`), { code }) }));
    },
  });
  return new Response(body, { status, headers });
}

/** True when the tests run as root, who can write a directory or a file whatever its mode. */
export const RUNS_AS_ROOT = process.getuid?.() === 0;
export const ROOT_NOTE = 'runs as root: root can write whatever the mode, so chmod 500 and 400 prove nothing here';

/** A new empty directory to stand for the app's directory, and a way to remove it. */
export function tempAppDir(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anyfare-cli-test-'));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface IoOptions {
  /** The app's directory. Default: one that does not exist, so nothing can be saved by mistake. */
  readonly appDir?: string;
  readonly isTerminal?: boolean;
  /** What is typed at the questions, such as "n\n". */
  readonly input?: string;
}

/** An Io that keeps what is written to it. */
export function captureIo(fetchFn: Fetch, env: Record<string, string> = {}, options: IoOptions = {}) {
  let out = '';
  let err = '';
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        append(chunk.toString());
        done();
      },
    });
  const stdin = new PassThrough();
  if (options.input !== undefined) stdin.end(options.input);
  const io: Io = {
    stdout: sink((text) => (out += text)),
    stderr: sink((text) => (err += text)),
    stdin,
    isTerminal: options.isTerminal ?? false,
    env,
    fetch: fetchFn,
    appDir: options.appDir ?? join(tmpdir(), `anyfare-cli-no-app-${randomUUID()}`),
  };
  return { io, out: () => out, err: () => err };
}

/**
 * The shape of the result of a call, with colors off: one blank line, the header (48 characters wide),
 * the answer's lines under a bar, the closing line, the proof under its own header (when it has lines),
 * one blank line, and the story line last. The lines in `proof` are given as they read, without their
 * indent. Throws, with the output, when the shape is not that.
 */
export function expectResultShape(
  out: string,
  shape: {
    readonly name: string;
    readonly answer: readonly string[];
    readonly proof: readonly (string | RegExp)[];
    readonly story: string;
  },
): void {
  const lines = out.split('\n');
  const at = lines.findIndex((text) => text.startsWith('━━ Result: '));
  const fail = (why: string): never => {
    throw new Error(`${why}\n${out}`);
  };
  if (at < 1) fail('There is no result header');
  if (lines[at - 1] !== '') fail('The header does not follow a blank line');
  const head = `━━ Result: ${shape.name} `;
  const header = lines[at] ?? '';
  if (!header.startsWith(head) || header.length !== 48 || !/^━+$/.test(header.slice(head.length))) {
    fail(`The header is not "${head}" filled with ━ to 48 characters`);
  }
  let next = at + 1;
  for (const answer of shape.answer) {
    if (lines[next] !== `  │ ${answer}`) fail(`Expected the answer line "  │ ${answer}", got "${lines[next]}"`);
    next += 1;
  }
  if (lines[next] !== `  └${'─'.repeat(45)}`) fail(`Expected the closing line, got "${lines[next]}"`);
  next += 1;
  if (shape.proof.length > 0) {
    if (lines[next] !== '  Proof') fail(`Expected "  Proof", got "${lines[next]}"`);
    next += 1;
    for (const proof of shape.proof) {
      const text = lines[next] ?? '';
      const good = typeof proof === 'string' ? text === `    ${proof}` : text.startsWith('    ') && proof.test(text.slice(4));
      if (!good) fail(`Expected the proof line ${String(proof)}, got "${text}"`);
      next += 1;
    }
  }
  if (lines[next] !== '') fail('The story line does not follow a blank line');
  if (lines[next + 1] !== shape.story) fail(`Expected the story line "${shape.story}", got "${lines[next + 1]}"`);
  if (lines.slice(next + 2).some((text) => text !== '')) fail('Something follows the story line');
}

/** Waits until the check is true, polling often, and fails with `what` after `ms`. */
export async function waitUntil(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
