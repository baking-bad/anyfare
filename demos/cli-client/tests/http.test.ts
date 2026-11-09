import { describe, expect, it } from 'vitest';
import { request } from '../src/http.ts';
import type { Fetch } from '../src/http.ts';
import { Stop } from '../src/util.ts';
import { fakeFetch } from './helpers.ts';

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
