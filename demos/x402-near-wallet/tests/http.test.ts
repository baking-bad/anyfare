// One request, and how far a failed one got. Everything runs against servers on 127.0.0.1.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, USER_AGENT, failureOf, request } from '../src/http.ts';
import { Stop } from '../src/util.ts';

let server: Server;
let url: string;
const seen: { method: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];

beforeAll(async () => {
  server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      seen.push({ method: incoming.method ?? '', headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (incoming.url === '/redirect') {
        response.writeHead(302, { location: '/elsewhere' });
        response.end();
      } else if (incoming.url === '/large') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('0123456789'.repeat(100));
      } else if (incoming.url === '/silent') {
        // Never answers
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('request', () => {
  it('sends any method, its headers and its body, with the app as the User-Agent', async () => {
    seen.length = 0;
    const answer = await request(fetch, { method: 'PUT', url: `${url}/x`, headers: [['X-Made-Up', '1']], body: 'a=1', timeoutMs: 5_000 });
    expect(answer).toMatchObject({ status: 200, body: { ok: true } });
    expect(new TextDecoder().decode(answer.bytes)).toBe('{"ok":true}');
    expect(seen[0]).toMatchObject({ method: 'PUT', body: 'a=1', headers: { 'x-made-up': '1', 'user-agent': USER_AGENT } });
  });

  it('keeps a User-Agent of the request', async () => {
    seen.length = 0;
    await request(fetch, { method: 'GET', url, headers: [['user-agent', 'made-up/1']], timeoutMs: 5_000 });
    expect(seen[0]?.headers['user-agent']).toBe('made-up/1');
  });

  it('reads a body up to its limit, and says when there was more', async () => {
    const cut = await request(fetch, { method: 'GET', url: `${url}/large`, headers: [], timeoutMs: 5_000, maxBodyBytes: 25 });
    expect(cut.truncated).toBe(true);
    expect(new TextDecoder().decode(cut.bytes)).toBe('0123456789012345678901234');
    expect(cut.body).toBe('0123456789012345678901234');
    const whole = await request(fetch, { method: 'GET', url: `${url}/large`, headers: [], timeoutMs: 5_000, maxBodyBytes: 1_000 });
    expect(whole.truncated).toBe(false);
    expect(whole.bytes).toHaveLength(1_000);
    expect(MAX_BODY_BYTES).toBe(10_000_000);
  });

  it('answers a redirect as it is, and never follows it', async () => {
    seen.length = 0;
    const answer = await request(fetch, { method: 'GET', url: `${url}/redirect`, headers: [], timeoutMs: 5_000 });
    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe('/elsewhere');
    expect(seen).toHaveLength(1);
  });

  const failure = async (target: string, timeoutMs = 5_000): Promise<Stop> => {
    try {
      await request(fetch, { method: 'GET', url: target, headers: [], timeoutMs });
    } catch (error) {
      expect(error).toBeInstanceOf(Stop);
      return error as Stop;
    }
    throw new Error('Expected a failure');
  };

  it('says a refused connection never sent the request', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const stop = await failure(`http://127.0.0.1:${port}/made-up-key/x?key=MadeUp`);
    expect(stop.message).toBe(`Could not reach 127.0.0.1:${port}: ECONNREFUSED`);
    expect(failureOf(stop)).toEqual({ stage: 'not_sent', code: 'ECONNREFUSED' });
  });

  it('says a timeout is a timeout, not "never sent"', async () => {
    const stop = await failure(`${url}/silent`, 200);
    expect(stop.message).toBe(`${new URL(url).host} did not answer within 200 ms`);
    expect(failureOf(stop)?.stage).toBe('timeout');
  });

  it('never quotes the URL of a failure that is no code', async () => {
    const broken = (() => Promise.reject(new TypeError('fetch failed', { cause: new Error('https://api.example.test/MadeUpKey123/x went wrong somehow') }))) as typeof fetch;
    let stop: unknown;
    try {
      await request(broken, { method: 'GET', url: 'https://api.example.test/MadeUpKey123/x', headers: [], timeoutMs: 5_000 });
    } catch (error) {
      stop = error;
    }
    expect((stop as Stop).message).toBe('Could not reach api.example.test: the connection failed');
    expect(failureOf(stop)?.stage).toBe('unknown');
  });

  it('keeps the status of an answer whose body broke', async () => {
    const broken = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError('terminated', { cause: Object.assign(new Error('Made up'), { code: 'UND_ERR_SOCKET' }) }));
            },
          }),
          { status: 201 },
        ),
      )) as typeof fetch;
    let stop: unknown;
    try {
      await request(broken, { method: 'GET', url: 'https://api.example.test/x', headers: [], timeoutMs: 5_000 });
    } catch (error) {
      stop = error;
    }
    expect((stop as Stop).message).toBe('api.example.test answered 201, but its body broke: UND_ERR_SOCKET');
    expect(failureOf(stop)).toEqual({ stage: 'unknown', code: 'UND_ERR_SOCKET', status: 201 });
  });
});
