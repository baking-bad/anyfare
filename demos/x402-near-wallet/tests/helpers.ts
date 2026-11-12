// What the tests share: an Io that keeps what is written to it, a NEAR key made in memory, a fetch
// that reaches 127.0.0.1 only, and the check that no output holds a part of a key.

import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import type { Io } from '../src/cli.ts';
import type { Fetch } from '../src/http.ts';
import { base58 } from './fakeNearRpc.ts';

/**
 * A NEAR key made here, in memory, that holds nothing: an ed25519 seed and its public key, base58,
 * as NEAR writes a secret key; and its public key.
 */
export function nearTestKey(): { readonly secretKey: string; readonly publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  return { secretKey: `ed25519:${base58(Buffer.concat([seed, pub]))}`, publicKey: `ed25519:${base58(pub)}` };
}

const urlOf = (input: string | URL | Request): string => (input instanceof Request ? input.url : String(input));

/** The global fetch, kept before a test replaces it. */
export const realFetch = globalThis.fetch;

/**
 * A fetch that reaches 127.0.0.1 only. `routes` sends an https origin, such as
 * `https://api.example.test`, to a local one, such as the fake API's: its path and query are kept.
 */
export function localFetch(routes: Readonly<Record<string, string>> = {}): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(urlOf(input));
    const to = routes[url.origin];
    const target = to === undefined ? url.href : `${to}${url.pathname}${url.search}`;
    if (new URL(target).hostname !== '127.0.0.1') throw new Error('These tests reach no host but 127.0.0.1');
    return realFetch(target, init);
  }) as Fetch;
}

export interface IoOptions {
  readonly isTerminal?: boolean;
  /** What is typed at the questions, such as "n\n". The input then ends. */
  readonly input?: string;
  /** The input is a terminal's, `isTTY`: lines typed before a question are dropped. */
  readonly tty?: boolean;
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
  if (options.tty === true) Object.assign(stdin, { isTTY: true });
  if (options.input !== undefined) stdin.end(options.input);
  const io: Io = {
    stdout: sink((text) => (out += text)),
    stderr: sink((text) => (err += text)),
    stdin,
    isTerminal: options.isTerminal ?? false,
    env,
    fetch: fetchFn,
  };
  return { io, out: () => out, err: () => err, stdin };
}

/** An address on 127.0.0.1 where nothing listens: a server's port, once it is closed. */
export async function closedAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** Waits until the check is true, polling often, and fails with `what` after `ms`. */
export async function waitUntil(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The output with the time of each result block set to `T`, which changes from run to run. */
export const withoutTimes = (text: string): string => text.replace(/ · \d+\.\d s$/gm, ' · T s');

/**
 * Throws when a text holds `key`, its base58 body, or any `slice` characters of the body. Public
 * values in `known`, such as made-up transaction hashes, are taken out first: they are not parts of
 * a key.
 */
export function expectNoKeyIn(text: string, key: string, options: { readonly slice?: number; readonly known?: readonly string[] } = {}): void {
  let rest = text;
  for (const part of options.known ?? []) rest = rest.split(part).join(' ');
  const body = key.slice(key.indexOf(':') + 1);
  if (rest.includes(key) || rest.includes(body)) throw new Error('The output holds the key');
  const slice = options.slice ?? 12;
  for (let at = 0; at + slice <= body.length; at += 1) {
    // The message never holds the part itself
    if (rest.includes(body.slice(at, at + slice))) throw new Error(`The output holds a part of the key, at ${at}`);
  }
}
