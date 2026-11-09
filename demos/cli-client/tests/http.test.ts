import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { failureOf, request } from '../src/http.ts';
import type { Fetch } from '../src/http.ts';
import { Stop } from '../src/util.ts';
import { brokenAnswer, fakeFetch } from './helpers.ts';

describe('request', () => {
  it('sends the user agent and reads a JSON body', async () => {
    const { fetch, calls } = fakeFetch({
      'POST https://api.example.test/x': () => new Response('{"a":1}', { status: 402 }),
    });
    const answer = await request(fetch, {
      method: 'POST',
      url: 'https://api.example.test/x',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      timeoutMs: 1000,
    });
    expect(answer.status).toBe(402);
    expect(answer.body).toEqual({ a: 1 });
    expect(calls[0]?.headers['user-agent']).toBe('anyfare-cli-client/0.1.0');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toBe('{}');
  });

  it('turns a network failure into a Stop that names the host', async () => {
    const { fetch } = fakeFetch({});
    const error = await request(fetch, { method: 'GET', url: 'https://down.example.test/x', timeoutMs: 1000 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Stop);
    expect((error as Stop).message).toBe('Could not reach down.example.test: ENOTFOUND');
  });

  it('turns a timeout into a Stop that names the host', async () => {
    const slow: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const error = await request(slow, { method: 'GET', url: 'https://slow.example.test/x', timeoutMs: 20 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Stop);
    expect((error as Stop).message).toContain('slow.example.test did not answer');
  });
});

/** A port of 127.0.0.1 that nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('failureOf', () => {
  it('says a refused connection was never sent, with the real fetch', async () => {
    const port = await closedPort();
    for (const host of ['127.0.0.1', 'localhost']) {
      const error = await request(globalThis.fetch, { method: 'GET', url: `http://${host}:${port}/x`, timeoutMs: 5000 }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Stop);
      expect(failureOf(error)).toEqual({ stage: 'not_sent', code: 'ECONNREFUSED' });
    }
  });

  it('tells a timeout, a broken connection and an unknown host apart', async () => {
    const reject = (cause: unknown) => (async () => {
      throw new TypeError('fetch failed', { cause });
    }) as Fetch;
    const of = async (fetchFn: Fetch) =>
      failureOf(await request(fetchFn, { method: 'GET', url: 'https://made-up.example.test/x', timeoutMs: 20 }).catch((caught: unknown) => caught));
    expect(await of(reject({ code: 'ENOTFOUND' }))).toEqual({ stage: 'not_sent', code: 'ENOTFOUND' });
    expect(await of(reject({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' }))).toEqual({ stage: 'not_sent', code: 'ERR_SSL_WRONG_VERSION_NUMBER' });
    expect(await of(reject({ code: 'ECONNRESET' }))).toEqual({ stage: 'unknown', code: 'ECONNRESET' });
    expect(await of(reject({ message: 'other side closed' }))).toEqual({ stage: 'unknown', code: undefined });
    const slow: Fetch = (_url, init) =>
      new Promise((_resolve, rejectIt) => {
        init?.signal?.addEventListener('abort', () => rejectIt(init.signal?.reason));
      });
    expect(await of(slow)).toEqual({ stage: 'timeout', code: undefined });
    expect(failureOf(new Stop('Not from a request'))).toBeUndefined();
    expect(failureOf(new Error('Not a Stop'))).toBeUndefined();
  });

  it('never says "not sent" for a TLS error that can come in the middle of a connection', async () => {
    const reject = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC' } });
    }) as Fetch;
    const error = await request(reject, { method: 'GET', url: 'https://made-up.example.test/x', timeoutMs: 1000 }).catch(
      (caught: unknown) => caught,
    );
    expect(failureOf(error)).toEqual({ stage: 'unknown', code: 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC' });
  });
});

describe('an answer whose body breaks', () => {
  it.each(['ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC', 'ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ECONNRESET'])(
    'is "unknown", with its status, whatever the code: %s',
    async (code) => {
      const fetchFn = (async () => brokenAnswer(200, code)) as Fetch;
      const error = await request(fetchFn, { method: 'GET', url: 'https://made-up.example.test/x', timeoutMs: 1000 }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Stop);
      expect((error as Stop).message).toBe(`made-up.example.test answered 200, but its body broke: ${code}`);
      expect(failureOf(error)).toEqual({ stage: 'unknown', code, status: 200 });
    },
  );

  it('is "unknown" when the time runs out while the body arrives', async () => {
    const fetchFn: Fetch = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        }),
        { status: 201 },
      );
    const error = await request(fetchFn, { method: 'GET', url: 'https://made-up.example.test/x', timeoutMs: 20 }).catch(
      (caught: unknown) => caught,
    );
    expect((error as Stop).message).toBe('made-up.example.test answered 201, but its body broke: it did not finish in time');
    expect(failureOf(error)).toEqual({ stage: 'unknown', code: undefined, status: 201 });
  });
});
