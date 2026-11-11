import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@anyfare/common';
import { hashApiKey, loadPlatformConfig, type PaymentStatus, type PlatformConfig, type RailName } from '@anyfare/core';
import { createAccountRepository, createCallRepository, createPaymentKeyRepository, payments, targetPayments } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, type FakeClock, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';

const generous = { requests: 100_000, windowSeconds: 60 };
const base = 'eip155:84532';
const near = 'near:testnet';
const evmTransaction = `0x${'9e'.repeat(32)}`;
const apiPayTo = '0x3333333333333333333333333333333333333333';

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let clock: FakeClock;
let url: string;
const servers: ApiServer[] = [];
const redises: TestRedis[] = [];
// Each call a second after the last, from here
let second = 0;
const origin = Date.parse('2026-11-12T09:00:00.000Z');
const next = (): Date => new Date(origin + (second += 1) * 1_000);

const start = async (platform: PlatformConfig, options: { readonly redis?: TestRedis } = {}): Promise<{ server: ApiServer; url: string }> => {
  const server = createApp({
    config: platform, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis: options.redis ?? redis, clock,
    callStreamTimings: { pollMs: 50, pingMs: 200 },
  });
  servers.push(server);
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return { server, url: `http://127.0.0.1:${port}` };
};

interface Seed {
  readonly id: string;
  readonly rail: RailName;
  readonly status: PaymentStatus;
  readonly host: string;
  readonly path?: string;
  readonly network?: string;
  readonly buyer?: { readonly accountId: string; readonly keyId: string };
  // Columns a public read must never show
  readonly requestId?: string;
  readonly receipt?: string;
  readonly settlementRequest?: Record<string, string>;
  // Whether we signed for the API. Default: true.
  readonly signed?: boolean;
}

/** A finished call as the proxy and the rails write it: its payment, our payment of the API, and its details. */
const seed = async (row: Seed, details?: { readonly method: string; readonly payer?: string }): Promise<{ readonly createdAt: Date; readonly updatedAt: Date }> => {
  const createdAt = next();
  const updatedAt = new Date(createdAt.getTime() + 800);
  const chain = row.rail !== 'credits';
  await database.db.insert(payments).values({
    id: row.id, requestId: row.requestId ?? `req-${row.id}`, rail: row.rail, buyerAccountId: row.buyer?.accountId ?? null, keyId: row.buyer?.keyId ?? null,
    targetHost: row.host, targetPath: row.path ?? '/v1/pools', network: chain ? row.network ?? base : null, asset: chain ? 'base-usdc' : null,
    atomicAmount: chain ? 10_000n : null, amount: 10_000n, fee: row.status === 'settled' || row.status === 'captured' ? 0n : null, upstreamStatus: 200,
    upstreamLatencyMs: 250, status: row.status, transactionHash: chain ? evmTransaction : null, receipt: row.receipt ?? null,
    settlementRequest: row.settlementRequest ?? null, needsReview: false, createdAt, updatedAt,
  });
  if (row.signed !== false) {
    await database.db.insert(targetPayments).values({
      paymentId: row.id, protocol: 'x402', network: base, asset: 'base-usdc', amount: 10_000n, atomicAmount: 10_000n, payTo: apiPayTo, signatureId: `sig-${row.id}`,
      status: 'settled', receipt: row.receipt ?? null, transactionHash: evmTransaction, buyerCharged: true, createdAt: new Date(createdAt.getTime() + 100),
      updatedAt,
    });
  }
  if (details)
    await createCallRepository({ db: database.db }).recordDetails({ paymentId: row.id, method: details.method, payer: details.payer, arrivedAt: new Date(createdAt.getTime() - 50) });

  return { createdAt, updatedAt };
};

const buyer = async (accountId: string, keyId: string) => {
  await createAccountRepository({ db: database.db }).create({ id: accountId, createdAt: next() });
  await createPaymentKeyRepository({ db: database.db }).insert({
    id: keyId, accountId, keyHash: hashApiKey(Secret.from(`af_test_${keyId}`)), label: undefined, createdAt: next(), allowance: undefined,
    dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });

  return { accountId, keyId };
};

interface Call {
  readonly id: string;
  readonly payer: string | null;
  readonly [field: string]: unknown;
}

const get = async (path: string, init: RequestInit = {}, at = url) => {
  const response = await fetch(`${at}${path}`, init);
  const text = await response.text();

  return { status: response.status, headers: response.headers, text, body: text === '' ? undefined : JSON.parse(text) as Record<string, unknown> };
};

const list = async (query: string) => {
  const answer = await get(`/v1/calls${query}`);

  return { ...answer, calls: (answer.body?.['calls'] ?? []) as Call[] };
};

/** A client of the stream: its frames as they come, and its events as calls. */
const openStream = async (path: string, at = url) => {
  const controller = new AbortController();
  const response = await fetch(`${at}${path}`, { signal: controller.signal });
  const frames: string[] = [];
  let ended = false;
  const reading = (async () => {
    if (response.status !== 200)
      return;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done)
          break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          frames.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    }
    catch {
      // Closed by the test
    }
    finally {
      ended = true;
    }
  })();

  return {
    response,
    frames,
    events: () => frames.filter(frame => frame.startsWith('event: call\n')).map(frame => JSON.parse(frame.split('\n')[1]!.slice('data: '.length)) as Call),
    get ended() {
      return ended;
    },
    close: async () => {
      controller.abort();
      await reading;
    },
  };
};

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  const loaded = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
  config = { ...loaded, rateLimits: { ...loaded.rateLimits, publicReads: generous, documents: generous } };
  clock = createFakeClock(new Date(origin));
  url = (await start(config)).url;
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await Promise.all([database?.drop(), redis?.cleanup(), ...redises.map(each => each.cleanup())]);
});

// Streams see calls finished after they open: the clock moves past every call seeded so far
const moveClockOn = (): void => {
  clock.set(new Date(origin + (second += 10) * 1_000));
};

describe('GET /v1/calls', () => {
  it('lists finished calls newest first with the call object, never one in flight, and counts them', async () => {
    const host = 'list.example.com';
    await seed({ id: 'pay_list_1', rail: 'x402', status: 'settled', host }, { method: 'POST', payer: '0x7777777777777777777777777777777777777777' });
    await seed({ id: 'pay_list_2', rail: 'x402', status: 'failed', host });
    await seed({ id: 'pay_list_3', rail: 'x402', status: 'verified', host });
    const { createdAt } = await seed({ id: 'pay_list_4', rail: 'mpp', status: 'settled', host, network: 'eip155:42431' }, { method: 'GET' });

    const answer = await list(`?service=${host}`);

    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('public, max-age=5');
    expect(answer.body).toMatchObject({ page: 1, size: 20, total: 3, totalCapped: false });
    expect(answer.calls.map(call => call.id)).toEqual(['pay_list_4', 'pay_list_2', 'pay_list_1']);
    expect(answer.calls[0]).toEqual({
      id: 'pay_list_4', at: createdAt.toISOString(), service: host, path: '/v1/pools', method: 'GET', paidWith: 'tempo', apiPaidWith: 'base', payer: null,
      amount: '0.01', status: 'paid', apiStatus: 200, ms: 250,
    });
    expect(answer.calls[1]).toMatchObject({ method: null, paidWith: 'base', status: 'free', payer: null });
    expect(answer.calls[2]).toMatchObject({ method: 'POST', payer: '0x7777777777777777777777777777777777777777' });
  });

  it('filters by how the buyer paid, a part of the host, the exact path and the status, and pages', async () => {
    const host = 'filters.example.com';
    const credits = await buyer('acc_filters', 'key_filters');
    await seed({ id: 'pay_filter_1', rail: 'credits', status: 'captured', host, path: '/v1/a', buyer: credits });
    await seed({ id: 'pay_filter_2', rail: 'x402', status: 'settled', host, path: '/v1/b', network: near });
    await seed({ id: 'pay_filter_3', rail: 'x402', status: 'cancelled', host, path: '/v1/a' });
    const ids = async (query: string) => (await list(`?service=FILTERS.example&${query}`)).calls.map(call => call.id);

    expect(await ids('paidWith=credits')).toEqual(['pay_filter_1']);
    expect(await ids('paidWith=near')).toEqual(['pay_filter_2']);
    expect(await ids('paidWith=base')).toEqual(['pay_filter_3']);
    expect(await ids('paidWith=solana')).toEqual([]);
    expect(await ids('endpoint=/v1/a')).toEqual(['pay_filter_3', 'pay_filter_1']);
    expect(await ids('status=free')).toEqual(['pay_filter_3']);
    expect(await ids('status=paid&endpoint=/v1/a')).toEqual(['pay_filter_1']);
    // The exact host, without case: never one that only contains it
    expect((await list('?host=FILTERS.example.com')).calls.map(call => call.id)).toEqual(['pay_filter_3', 'pay_filter_2', 'pay_filter_1']);
    expect((await list('?host=filters.example')).calls).toEqual([]);
    expect((await list('?host=filters.example.com&endpoint=/v1/a&paidWith=base')).calls.map(call => call.id)).toEqual(['pay_filter_3']);
    // An empty filter is none
    expect(await ids('endpoint=&paidWith=credits')).toEqual(['pay_filter_1']);
    expect((await list('?service=filters.example&size=2&page=2')).body).toMatchObject({ page: 2, size: 2, total: 3, calls: [{ id: 'pay_filter_1' }] });
    expect((await list('?service=nothing.example')).body).toEqual({ calls: [], page: 1, size: 20, total: 0, totalCapped: false });
  });

  it('refuses a size outside 1 to 100, a page below 1, an unknown way to pay or status, and a long service', async () => {
    for (const query of ['?size=0', '?size=101', '?page=0', '?page=10001', '?paidWith=bitcoin', '?status=maybe', `?service=${'a'.repeat(101)}`, `?host=${'a'.repeat(260)}`]) {
      const answer = await list(query);
      expect([answer.status, (answer.body?.['error'] as { code: string } | undefined)?.code], query).toEqual([400, 'invalid_request']);
    }
    expect((await list('?size=100&page=100')).status).toBe(200);
  });
});

describe('GET /v1/calls/:id', () => {
  it('answers a finished call\'s receipt', async () => {
    const { createdAt, updatedAt } = await seed(
      { id: 'pay_receipt_1', rail: 'x402', status: 'settled', host: 'receipt.example.com' },
      { method: 'GET', payer: '0x7777777777777777777777777777777777777777' },
    );

    const answer = await get('/v1/calls/pay_receipt_1');

    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('public, max-age=60');
    expect(answer.body).toEqual({
      id: 'pay_receipt_1', at: createdAt.toISOString(), status: 'paid', apiStatus: 200, service: 'receipt.example.com', method: 'GET', path: '/v1/pools',
      buyer: {
        paidWith: 'base', network: base, asset: 'USDC', amount: '0.01', payer: '0x7777777777777777777777777777777777777777', transaction: evmTransaction,
        explorerUrl: null, settledAt: updatedAt.toISOString(),
      },
      api: { paidWith: 'base', network: base, asset: 'USDC', amount: '0.01', payTo: apiPayTo, transaction: evmTransaction, explorerUrl: null, status: 'settled' },
      apiPrice: '0.01',
      fee: '0',
      ms: { api: 250, total: 850 },
      steps: [
        { step: 'received', at: new Date(createdAt.getTime() - 50).toISOString() },
        { step: 'authorized', at: createdAt.toISOString() },
        { step: 'api_signed', at: new Date(createdAt.getTime() + 100).toISOString() },
        { step: 'api_answered', at: new Date(createdAt.getTime() + 350).toISOString() },
        { step: 'settled', at: updatedAt.toISOString() },
      ],
    });
  });

  it('answers a receipt of a call we never signed for, recorded before details were kept', async () => {
    const { createdAt, updatedAt } = await seed({ id: 'pay_receipt_unsigned', rail: 'x402', status: 'cancelled', host: 'receipt.example.com', signed: false });

    const answer = await get('/v1/calls/pay_receipt_unsigned');

    expect(answer.body).toMatchObject({
      status: 'free', method: null, api: null, apiPrice: null, fee: '0', ms: { api: 250, total: null },
      buyer: { paidWith: 'base', payer: null, settledAt: null },
      steps: [{ step: 'authorized', at: createdAt.toISOString() }, { step: 'released', at: updatedAt.toISOString() }],
    });
  });

  it('answers 404 not_found for an unknown ID and for a payment still in flight', async () => {
    await seed({ id: 'pay_receipt_held', rail: 'x402', status: 'verified', host: 'receipt.example.com' });

    for (const id of ['pay_unknown', 'pay_receipt_held', 'not-a-payment'])
      expect(await get(`/v1/calls/${id}`)).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });
});

describe('the privacy of public reads', () => {
  it('never shows a Credits buyer\'s account ID or key ID, in the list, the receipt or the stream, and gives no payer', async () => {
    const credits = await buyer('acc_private_4f1c', 'key_private_9d2e');
    moveClockOn();
    const stream = await openStream('/v1/calls/stream');
    // The account and the key, in every column that might hold them
    await seed({
      id: 'pay_private_credits', rail: 'credits', status: 'captured', host: 'private-credits.example.com', buyer: credits,
      requestId: 'acc_private_4f1c key_private_9d2e', receipt: 'account="acc_private_4f1c", key="key_private_9d2e"',
    }, { method: 'GET' });

    await expect.poll(() => stream.events().map(call => call.id)).toContain('pay_private_credits');
    await stream.close();
    const listed = await list('?paidWith=credits&service=private-credits');
    const receipt = await get('/v1/calls/pay_private_credits');
    const streamed = stream.events().find(call => call.id === 'pay_private_credits')!;

    expect(listed.calls.map(call => call.id)).toEqual(['pay_private_credits']);
    for (const text of [listed.text, receipt.text, JSON.stringify(streamed), stream.frames.join('\n\n')]) {
      expect(text).not.toContain('acc_private_4f1c');
      expect(text).not.toContain('key_private_9d2e');
    }
    expect([listed.calls[0]!.payer, (receipt.body?.['buyer'] as { payer: unknown }).payer, streamed.payer]).toEqual([null, null, null]);
  });

  it('never shows a routed call\'s query string, body or headers, in the list, the receipt or the stream', async () => {
    moveClockOn();
    const stream = await openStream('/v1/calls/stream?service=private-routed');
    // As a call to /private-routed.example.com/v1/pools?token=secret-in-query, with a body and an x-request-id
    // header, leaves them: the path alone, and the rest in columns no read shows
    await seed({
      id: 'pay_private_routed', rail: 'x402', status: 'settled', host: 'private-routed.example.com', path: '/v1/pools', requestId: 'secret-in-header',
      receipt: 'token=secret-in-query secret-in-body',
      settlementRequest: { resource: 'https://private-routed.example.com/v1/pools?token=secret-in-query', body: 'secret-in-body', header: 'secret-in-header' },
    }, { method: 'POST' });

    await expect.poll(() => stream.events().map(call => call.id)).toEqual(['pay_private_routed']);
    await stream.close();
    const listed = await list('?service=private-routed');
    const receipt = await get('/v1/calls/pay_private_routed');

    expect([listed.calls[0]?.['path'], receipt.body?.['path'], stream.events()[0]!['path']]).toEqual(['/v1/pools', '/v1/pools', '/v1/pools']);
    for (const text of [listed.text, receipt.text, stream.frames.join('\n\n')]) {
      for (const secret of ['secret-in-query', 'secret-in-body', 'secret-in-header', 'token='])
        expect(text, secret).not.toContain(secret);
    }
  });

  it('shows a chain payment\'s payer, in the list, the receipt and the stream', async () => {
    const payer = 'scout.example.testnet';
    moveClockOn();
    const stream = await openStream('/v1/calls/stream?paidWith=near');
    await seed({ id: 'pay_private_chain', rail: 'x402', status: 'settled', host: 'private-chain.example.com', network: near }, { method: 'GET', payer });

    await expect.poll(() => stream.events().map(call => call.id)).toEqual(['pay_private_chain']);
    await stream.close();
    const listed = await list('?service=private-chain');
    const receipt = await get('/v1/calls/pay_private_chain');

    expect([listed.calls[0]?.payer, (receipt.body?.['buyer'] as { payer: unknown }).payer, stream.events()[0]!.payer]).toEqual([payer, payer, payer]);
  });
});

describe('GET /v1/calls/stream', () => {
  it('sends each call once it is finished, as a call object, with the event stream headers, and pings', async () => {
    moveClockOn();
    await seed({ id: 'pay_stream_before', rail: 'x402', status: 'settled', host: 'stream.example.com' });
    moveClockOn();
    const stream = await openStream('/v1/calls/stream?service=stream.example');

    expect(stream.response.status).toBe(200);
    expect(Object.fromEntries(['content-type', 'cache-control', 'x-accel-buffering', 'access-control-allow-origin'].map(name => [name, stream.response.headers.get(name)])))
      .toEqual({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*' });
    // In flight: not yet
    await seed({ id: 'pay_stream_held', rail: 'x402', status: 'verified', host: 'stream.example.com' });
    const { createdAt } = await seed({ id: 'pay_stream_paid', rail: 'x402', status: 'settled', host: 'stream.example.com' }, { method: 'GET' });

    await expect.poll(() => stream.events().map(call => call.id)).toEqual(['pay_stream_paid']);
    await expect.poll(() => stream.frames.includes(': ping')).toBe(true);
    await stream.close();

    expect(stream.frames[0]).toBe('retry: 3000');
    expect(stream.events()[0]).toEqual({
      id: 'pay_stream_paid', at: createdAt.toISOString(), service: 'stream.example.com', path: '/v1/pools', method: 'GET', paidWith: 'base', apiPaidWith: 'base',
      payer: null, amount: '0.01', status: 'paid', apiStatus: 200, ms: 250,
    });
  });

  it('sends nothing for a call its filter doesn\'t match', async () => {
    moveClockOn();
    const stream = await openStream('/v1/calls/stream?status=free&service=nomatch.example&paidWith=base&endpoint=/v1/free');
    const byHost = await openStream('/v1/calls/stream?host=Other.Example.com');
    await seed({ id: 'pay_nomatch_paid', rail: 'x402', status: 'settled', host: 'nomatch.example.com', path: '/v1/free' });
    await seed({ id: 'pay_nomatch_path', rail: 'x402', status: 'failed', host: 'nomatch.example.com', path: '/v1/other' });
    await seed({ id: 'pay_nomatch_near', rail: 'x402', status: 'failed', host: 'nomatch.example.com', path: '/v1/free', network: near });
    await seed({ id: 'pay_nomatch_host', rail: 'x402', status: 'failed', host: 'other.example.com', path: '/v1/free' });
    // The one that matches, last
    await seed({ id: 'pay_nomatch_free', rail: 'x402', status: 'failed', host: 'nomatch.example.com', path: '/v1/free' });

    await expect.poll(() => stream.events().map(call => call.id)).toContain('pay_nomatch_free');
    await expect.poll(() => byHost.events().map(call => call.id)).toContain('pay_nomatch_host');
    await Promise.all([stream.close(), byHost.close()]);

    expect(stream.events().map(call => call.id)).toEqual(['pay_nomatch_free']);
    expect(byHost.events().map(call => call.id)).toEqual(['pay_nomatch_host']);
  });

  it('answers 429 over the cap of open streams per client IP', async () => {
    const capped = await start({ ...config, callStream: { maxPerIp: 1, maxTotal: 10 } });
    const first = await openStream('/v1/calls/stream', capped.url);
    const second = await get('/v1/calls/stream', {}, capped.url);
    await first.close();

    expect(first.response.status).toBe(200);
    expect(second).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    expect([second.headers.get('retry-after'), second.headers.get('access-control-allow-origin')]).toEqual(['30', '*']);
    // A stream that closed frees its place
    await expect.poll(async () => {
      const again = await openStream('/v1/calls/stream', capped.url);
      await again.close();

      return again.response.status;
    }).toBe(200);
  });

  it('ends open streams when the app closes, so it stops at once', async () => {
    const closing = await start(config);
    const stream = await openStream('/v1/calls/stream', closing.url);
    await expect.poll(() => stream.frames.length).toBeGreaterThan(0);

    const started = performance.now();
    await closing.server.close();

    expect(performance.now() - started).toBeLessThan(5_000);
    await expect.poll(() => stream.ended).toBe(true);
  });

});

describe('the shared parts of public reads', () => {
  it('answers any origin, on errors too, and the preflight, on every public read, never on a route behind a key', async () => {
    const preflight = { method: 'OPTIONS', headers: { origin: 'https://site.example', 'access-control-request-method': 'GET' } };

    for (const path of ['/v1/calls', '/v1/calls/stream', '/v1/calls/pay_unknown', '/v1/catalog', '/v1/topups/options']) {
      const answer = await get(path, preflight);
      expect([answer.status, answer.headers.get('access-control-allow-origin'), answer.headers.get('access-control-allow-methods')], path).toEqual([204, '*', 'GET, OPTIONS']);
      expect(answer.headers.get('access-control-allow-credentials'), path).toBeNull();
    }
    for (const path of ['/v1/calls', '/v1/calls/pay_unknown', '/v1/catalog', '/v1/topups/options', '/v1/calls?size=0'])
      expect((await get(path)).headers.get('access-control-allow-origin'), path).toBe('*');
    // Behind the master key: no CORS, and no preflight
    expect((await get('/v1/account')).headers.get('access-control-allow-origin')).toBeNull();
    expect((await get('/v1/account', preflight)).status).toBe(404);
  });

  it('limits every public read of calls under one publicReads limit per client IP, a stream once when it opens, and never a preflight', async () => {
    const own = await createTestRedis();
    redises.push(own);
    const limited = await start({ ...config, rateLimits: { ...config.rateLimits, publicReads: { requests: 3, windowSeconds: 60 } } }, { redis: own });
    const preflight = { method: 'OPTIONS', headers: { origin: 'https://site.example', 'access-control-request-method': 'GET' } };

    for (let index = 0; index < 5; index += 1)
      expect((await get('/v1/calls', preflight, limited.url)).status).toBe(204);
    const stream = await openStream('/v1/calls/stream', limited.url);
    await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
    const statuses = [stream.response.status, (await get('/v1/calls', {}, limited.url)).status, (await get('/v1/calls/pay_unknown', {}, limited.url)).status];
    const over = await get('/v1/calls', {}, limited.url);
    await stream.close();

    expect(statuses).toEqual([200, 200, 404]);
    expect(over).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    expect([over.headers.get('access-control-allow-origin'), over.headers.get('retry-after')]).toEqual(['*', expect.stringMatching(/^\d+$/)]);
  });
});
