// The lookup of a call paid through Anyfare, against the fake API's list of calls and their receipts.
// Every account, transaction and call here is made up. No request leaves 127.0.0.1.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findAnyfareCall, routedHost } from '../src/anyfareCall.ts';
import type { CallLimits, CallLookup } from '../src/anyfareCall.ts';
import type { Fetch } from '../src/http.ts';
import { startFakeApi } from './fakeApi.ts';
import type { FakeApi, FakeCall } from './fakeApi.ts';
import { closedAddress, localFetch } from './helpers.ts';

// Made up: the payer, the API's host, and two NEAR transaction hashes
const ACCOUNT = 'alice.near';
const HOST = 'api.example.test';
const TX = 'MadeUpTransactionOfThisPayment1111111111111';
const OTHER_TX = 'MadeUpTransactionOfAnotherPayment111111111';

let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
});

/** A call of this payment, `secondsAgo` old, changed by `change`. */
const call = (secondsAgo: number, change: Partial<FakeCall> = {}): FakeCall => ({
  id: `pay_${randomUUID()}`,
  at: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
  service: HOST,
  path: '/v1/quote',
  method: 'GET',
  paidWith: 'near',
  payer: ACCOUNT,
  amount: '0.01',
  network: 'near:mainnet',
  transaction: TX,
  ...change,
});

/** A fetch to 127.0.0.1 that keeps what each request asked for. */
function recording(): { readonly fetch: Fetch; readonly inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  const local = localFetch();
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    inits.push(init ?? {});
    return local(input, init);
  }) as Fetch;
  return { fetch: fetchFn, inits };
}

const find = (limits: CallLimits = {}, fetchFn: Fetch = localFetch(), apiUrl = api.url): Promise<CallLookup> =>
  findAnyfareCall(fetchFn, { apiUrl, host: HOST, accountId: ACCOUNT, transaction: TX, limits });

const LIST = `/v1/calls?paidWith=near&host=${HOST}&size=10`;
const paths = (): string[] => api.callReads().map((read) => read.path);

describe('routedHost', () => {
  it('is the first part of the path, lowercase', () => {
    expect(routedHost('https://pay.anyfare.agents.bakingbad.dev/pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC')).toBe(
      'pro-api.coinmarketcap.com',
    );
    expect(routedHost('https://pay.example.test/API.Example.TEST/v1/quote')).toBe('api.example.test');
    expect(routedHost('http://127.0.0.1:8080/api.example.test:8443/v1')).toBe('api.example.test:8443');
    expect(routedHost('https://pay.example.test/api.example.test')).toBe('api.example.test');
  });

  it('is none when the first part is not a host name', () => {
    for (const path of ['/', '/v1/quote', '/localhost/v1', '/-a.example/v1', '/a..example/v1', '/a_b.example/v1', '/%61.example/v1', '/a.example:/v1', `/${'a'.repeat(64)}.example/v1`]) {
      expect(routedHost(`https://pay.example.test${path}`), path).toBeUndefined();
    }
    expect(routedHost('not a URL')).toBeUndefined();
  });
});

describe('findAnyfareCall', () => {
  it('finds the call of this payment, and passes over another payer, another transaction and an older call', async () => {
    const own = call(60);
    const otherTransaction = call(10, { transaction: OTHER_TX });
    api.calls.list.push(call(5, { payer: 'bob.near' }), otherTransaction, call(11 * 60), own, call(1, { paidWith: 'base' }), call(2, { id: 'not_an_id' }));
    const { fetch: fetchFn, inits } = recording();
    expect(await find({}, fetchFn)).toEqual({ kind: 'found', id: own.id });
    // The list, then the receipts of this payer's recent calls, newest first, until one is this payment's
    expect(paths()).toEqual([LIST, `/v1/calls/${otherTransaction.id}`, `/v1/calls/${own.id}`]);
    for (const init of inits) {
      expect(init.method).toBe('GET');
      expect(init.headers).toEqual({ accept: 'application/json', 'user-agent': 'x402-near-wallet/0.1.0' });
      expect(init.redirect).toBe('error');
      expect(init.body).toBeUndefined();
    }
    expect(api.callReads()[0]?.headers).toMatchObject({ accept: 'application/json', 'user-agent': 'x402-near-wallet/0.1.0' });
    expect(api.callReads()[0]?.headers['authorization']).toBeUndefined();
  });

  it('reads the receipts of the 3 newest candidates only', async () => {
    api.calls.list.push(call(60), call(3, { transaction: OTHER_TX }), call(2, { transaction: OTHER_TX }), call(1, { transaction: OTHER_TX }));
    expect(await find({ tries: 1 })).toEqual({ kind: 'not_found', reason: 'no call with this transaction is listed yet' });
    expect(paths()).toHaveLength(1 + 3);
  });

  it('takes no receipt of another network, and passes over a call still in flight', async () => {
    api.calls.list.push(call(3, { network: 'near:testnet' }));
    expect(await find({ tries: 1 })).toMatchObject({ kind: 'not_found' });
    api.reset();
    const own = call(60);
    api.calls.list.push(own, call(1, { inFlight: true }));
    expect(await find({ tries: 1 })).toEqual({ kind: 'found', id: own.id });
  });

  it('finds the call on the second try, when the list is empty at first', async () => {
    const own = call(1);
    api.calls.list.push(own);
    api.calls.emptyLists = 1;
    expect(await find({ pauseMs: 20 })).toEqual({ kind: 'found', id: own.id });
    expect(paths()).toEqual([LIST, LIST, `/v1/calls/${own.id}`]);
  });

  it('tries 3 times in all, 1 second apart, then says no call is listed', async () => {
    api.calls.list.push(call(1, { transaction: OTHER_TX }));
    const started = performance.now();
    expect(await find()).toEqual({ kind: 'not_found', reason: 'no call with this transaction is listed yet' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(paths().filter((path) => path === LIST)).toHaveLength(3);
  });

  it('says why when the API answers 500, and does not try again', async () => {
    api.calls.failure = 'status_500';
    expect(await find()).toEqual({ kind: 'not_found', reason: `${new URL(api.url).host} answered 500` });
    expect(paths()).toEqual([LIST]);
  });

  it('says why when the API is down', async () => {
    const down = await closedAddress();
    expect(await find({}, localFetch(), down)).toEqual({ kind: 'not_found', reason: `could not reach ${new URL(down).host}: ECONNREFUSED` });
  });

  it('never follows a redirect', async () => {
    api.calls.failure = 'redirect';
    const found = await find();
    expect(found).toMatchObject({ kind: 'not_found' });
    expect((found as { reason: string }).reason).toMatch(/^could not reach 127\.0\.0\.1:\d+/);
    expect(paths()).toEqual([LIST]);
  });

  it('gives up on a request after its limit', async () => {
    api.calls.failure = 'hang';
    const started = performance.now();
    expect(await find({ requestMs: 100 })).toEqual({ kind: 'not_found', reason: `${new URL(api.url).host} did not answer within 100 ms` });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('gives up on the whole lookup after its limit', async () => {
    api.calls.failure = 'hang';
    const started = performance.now();
    expect(await find({ totalMs: 200 })).toEqual({ kind: 'not_found', reason: 'the lookup took more than 200 ms' });
    expect(performance.now() - started).toBeLessThan(1_000);
    // Even when the fetch never ends and takes no signal
    const never = (() => new Promise<Response>(() => undefined)) as Fetch;
    expect(await find({ totalMs: 100 }, never)).toEqual({ kind: 'not_found', reason: 'the lookup took more than 100 ms' });
  });

  it('reads at most 1 MB of an answer', async () => {
    const huge = (() => Promise.resolve(new Response('x'.repeat(2_000_000), { status: 200 }))) as Fetch;
    expect(await find({}, huge, 'https://api.example.test')).toEqual({ kind: 'not_found', reason: 'api.example.test sent more than 1 MB' });
  });

  it('never throws, and gives a reason of its own', async () => {
    const answering = (body: string, status = 200) => (() => Promise.resolve(new Response(body, { status }))) as Fetch;
    const cases: [Fetch, string][] = [
      [(() => Promise.reject(new Error('Made up: \u001b[31m a long text of the error'))) as Fetch, 'could not reach api.example.test'],
      [(() => {
        throw new RangeError('Made up');
      }) as Fetch, 'could not reach api.example.test'],
      [answering('<html>not JSON</html>'), "api.example.test sent an answer this app can't read"],
      [answering('{"calls":"none"}'), "api.example.test sent a list this app can't read"],
      [answering('null'), "api.example.test sent a list this app can't read"],
      [answering('{"error":{"code":"not_found"}}', 404), 'api.example.test answered 404'],
      [answering('Made up: \u001b[2J', 503), 'api.example.test answered 503'],
    ];
    for (const [fetchFn, reason] of cases) {
      expect(await find({ tries: 1 }, fetchFn, 'https://api.example.test'), reason).toEqual({ kind: 'not_found', reason });
    }
  });
});
