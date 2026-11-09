import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, type Server } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { topups } from '@anyfare/db';
import {
  createFakeClock, createTestDatabase, createTestRedis, defaultOneClickTokens, startFakeOneClick, testnetNearUsdcAddress, type FakeClock, type FakeOneClick,
  type FakeOneClickRequest, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp } from '../../src/app.js';

interface Started {
  readonly url: string;
  readonly metricsUrl: string;
  readonly logs: Record<string, unknown>[];
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

const noon = '2026-11-09T12:00:00.000Z';
const baseUsdc = defaultOneClickTokens.find(token => token.blockchain === 'base' && token.symbol === 'USDC')!;
const sol = defaultOneClickTokens.find(token => token.symbol === 'SOL')!;
// The client's deadline for each call to the fake, short so a held answer times out quickly
const timeoutMs = 500;

let database: TestDatabase;
let redis: TestRedis;
let oneClick: FakeOneClick;
let clock: FakeClock;
let config: PlatformConfig;
let app: Started;
const servers: Server[] = [];

const base64 = (yaml: string) => Buffer.from(yaml).toString('base64');

beforeAll(async () => {
  clock = createFakeClock(noon);
  [database, redis, oneClick] = await Promise.all([createTestDatabase(), createTestRedis(), startFakeOneClick({ now: clock.now })]);
  // Top-ups on against the fake, and limits no test reaches unless it says so
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: base64([
        'rateLimits:',
        '  signup: { requests: 1000, windowSeconds: 60 }',
        '  topups: { requests: 1000, windowSeconds: 3600 }',
        'topups:',
        '  enabled: true',
        `  url: ${oneClick.url}`,
        `  timeoutMs: ${timeoutMs}`,
        '',
      ].join('\n')),
    },
  });
  app = await start(config);
});

afterEach(() => {
  oneClick.reset();
  clock.set(noon);
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await oneClick?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// Behind a trusted proxy on 127.0.0.1, so X-Forwarded-For gives the client IP
async function start(platform: PlatformConfig): Promise<Started> {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });
  const server = createApp({ config: platform, logger, postgres: database.postgres, redis, clock, trustProxy: '127.0.0.1' });
  servers.push(server);
  const { port, metricsPort } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return { url: `http://127.0.0.1:${port}`, metricsUrl: `http://127.0.0.1:${metricsPort}/metrics`, logs };
}

const call = async (target: Started, method: string, path: string, { key, body, ip }: { key?: string; body?: unknown; ip?: string } = {}): Promise<Answer> => {
  const response = await fetch(`${target.url}${path}`, {
    method,
    headers: {
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...(ip === undefined ? {} : { 'x-forwarded-for': ip }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();

  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
};

const signup = async (target: Started = app): Promise<{ readonly id: string; readonly masterKey: string }> =>
  (await call(target, 'POST', '/v1/accounts')).body as { id: string; masterKey: string };

const topUp = (key: string, body: unknown, target: Started = app) => call(target, 'POST', '/v1/topups', { key, body });

const rowsOf = (accountId: string) => database.db.select().from(topups).where(eq(topups.accountId, accountId));

// The quote requests the fake has seen since `from`
const quotesSince = (from: number): FakeOneClickRequest[] => oneClick.requests.slice(from).filter(request => request.path === '/v0/quote');
const quoteBody = (request: FakeOneClickRequest | undefined) => request?.body as Record<string, unknown>;
const isReal = (request: FakeOneClickRequest) => request.path === '/v0/quote' && (request.body as Record<string, unknown> | undefined)?.['dry'] === false;

// api_topups_total by result, from the metrics listener
const results = async (target: Started): Promise<Record<string, number>> => {
  const text = await (await fetch(target.metricsUrl)).text();

  return Object.fromEntries([...text.matchAll(/^api_topups_total\{result="(\w+)"\} (\d+)$/gm)].map(match => [match[1]!, Number(match[2])]));
};

const linesOf = (target: Started, message: string) => target.logs.filter(line => line['msg'] === message);
const hours = (count: number) => new Date(Date.parse(noon) + count * 3_600_000).toISOString();

const correlationId = 'b5cc1a45-2f4e-4f4b-9f4b-6a1b2c3d4e5f';

interface AnswerChanges {
  // Changed in the answer's quoteRequest; undefined leaves the field out
  readonly echo?: Record<string, unknown>;
  // Changed in the answer's quote
  readonly quote?: Record<string, unknown>;
}

// A real quote's answer for 1 USDC as 1Click gives it, with a new deposit address and the changes made
const realAnswer = (request: FakeOneClickRequest, { echo = {}, quote = {} }: AnswerChanges = {}) => {
  const body = request.body as Record<string, unknown>;

  return {
    status: 201,
    body: {
      quote: {
        amountIn: body['amount'], amountInFormatted: '1.0', amountInUsd: '0.999480000000', minAmountIn: '990000', amountOut: '999380', amountOutFormatted: '0.99938',
        amountOutUsd: '0.999380000000', minAmountOut: '989386', depositAddress: `0x${randomBytes(20).toString('hex')}`, timeWhenInactive: hours(96),
        deadline: hours(96), timeEstimate: 35, ...quote,
      },
      quoteRequest: { ...body, depositMode: 'SIMPLE', ...echo },
      signature: 'ed25519:scripted',
      timestamp: noon,
      correlationId,
    },
  };
};

// Scripts the real quote's answer. Returns the deposit addresses it answered with.
const scriptRealAnswer = (changes: AnswerChanges = {}): string[] => {
  const addresses: string[] = [];
  oneClick.handle('/v0/quote', request => {
    if (!isReal(request))
      return undefined;
    const answer = realAnswer(request, changes);
    addresses.push(answer.body.quote.depositAddress as string);

    return answer;
  });

  return addresses;
};

// A dry quote's answer that prices the amount at `amountInUsd`
const dryAnswer = (request: FakeOneClickRequest, amountInUsd: string) => {
  const body = request.body as Record<string, unknown>;

  return {
    status: 201,
    body: {
      quote: {
        amountIn: body['amount'], amountInUsd, minAmountIn: body['amount'], amountOut: '995000', amountOutUsd: amountInUsd, minAmountOut: '995000', timeEstimate: 35,
      },
      quoteRequest: { ...body, depositMode: 'SIMPLE' },
      signature: 'ed25519:dry',
      timestamp: noon,
      correlationId,
    },
  };
};

// A refused answer: 502 topup_mismatch, the row quote_failed with the answer kept, and no address given
const expectMismatch = async (answered: Answer, accountId: string, addresses: readonly string[], reason: string): Promise<void> => {
  expect(answered).toMatchObject({ status: 502, body: { error: { code: 'topup_mismatch', message: 'The quote didn\'t match the request. Nothing to send.' } } });
  expect(addresses).toHaveLength(1);
  expect(JSON.stringify(answered.body)).not.toContain(addresses[0]);
  const rows = await rowsOf(accountId);
  expect(rows).toEqual([expect.objectContaining({ status: 'quote_failed', quoteError: expect.stringContaining(reason), depositAddress: null, correlationId })]);
  expect(rows[0]!.quoteResponse).toMatchObject({ signature: 'ed25519:scripted', quote: { depositAddress: addresses[0] } });
};

describe('POST /v1/topups', () => {
  it('makes a top-up from USDC on Base: a deposit address waiting for the transfer, which GET shows its account and nobody else', async () => {
    const owner = await signup();
    const before = await results(app);

    const created = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' });

    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const [answered] = oneClick.quotes().slice(-1);
    expect(created.body).toEqual({
      id: expect.stringMatching(/^top_[A-Za-z0-9-]+$/),
      status: 'waiting',
      message: 'Waiting for your transfer',
      network: 'base',
      token: 'USDC',
      amount: '1',
      depositAddress: answered!.quote.depositAddress,
      depositMemo: null,
      send: '1',
      sendAtLeast: '0.99',
      estimatedCredits: '0.99938',
      payBy: hours(24),
      addressExpiresAt: hours(96),
      createdAt: noon,
      updatedAt: noon,
      deposited: null,
      credited: null,
      transaction: null,
      refunded: null,
      refundReason: null,
    });
    expect(created.body['depositAddress']).toMatch(/^0x[0-9a-f]{40}$/);

    const id = created.body['id'] as string;
    const [row] = await rowsOf(owner.id);
    expect(row).toMatchObject({
      id,
      status: 'waiting',
      network: 'base',
      blockchain: 'base',
      tokenSymbol: 'USDC',
      originAsset: baseUsdc.assetId,
      tokenDecimals: 6,
      amount: 1_000_000n,
      destinationAsset: 'near-usdc',
      recipient: 'treasury.anyfare.testnet',
      refundTo: 'treasury.anyfare.testnet',
      correlationId: answered!.correlationId,
      sendAmount: 1_000_000n,
      sendAtLeast: 990_000n,
      estimatedCredits: 999_380n,
      nextPollAt: new Date(Date.parse(noon) + 10_000),
      needsReview: false,
      quoteError: null,
    });
    // The whole answer with its signature, and exactly the request it answered
    expect(row!.quoteResponse).toEqual(answered);
    expect(row!.quoteResponse).toHaveProperty('signature', expect.stringMatching(/^ed25519:/));
    expect(row!.quoteRequest).toEqual(quoteBody(oneClick.requests.filter(isReal).at(-1)));

    const shown = await call(app, 'GET', `/v1/topups/${id}`, { key: owner.masterKey });
    expect(shown).toMatchObject({ status: 200, body: created.body });
    expect(shown.headers.get('cache-control')).toBe('no-store');
    const other = await signup();
    expect(await call(app, 'GET', `/v1/topups/${id}`, { key: other.masterKey })).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    expect(await call(app, 'GET', '/v1/topups/top_unknown', { key: owner.masterKey })).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    expect((await call(app, 'GET', '/v1/topups/not-a-topup', { key: owner.masterKey })).status).toBe(404);
    expect((await call(app, 'GET', `/v1/topups/top_${'a'.repeat(65)}`, { key: owner.masterKey })).status).toBe(404);

    expect(linesOf(app, 'A top-up was created').at(-1)).toMatchObject({
      level: 30, topupId: id, accountId: owner.id, network: 'base', token: 'USDC', amount: '1', depositAddress: answered!.quote.depositAddress, correlationId: answered!.correlationId,
    });
    expect((await results(app))['created']).toBe((before['created'] ?? 0) + 1);
  });

  it('sends one dry quote, then one real one with the same deadline: a day ahead for USDC, two hours for SOL', async () => {
    const owner = await signup();
    const seen = oneClick.requests.length;

    expect((await topUp(owner.masterKey, { network: 'base', token: 'usdc', amount: '2' })).status).toBe(201);
    clock.set('2026-11-09T15:30:00.000Z');
    expect((await topUp(owner.masterKey, { network: 'solana', token: 'SOL', amount: '0.1' })).status).toBe(201);

    const sent = quotesSince(seen);
    expect(sent.map(request => quoteBody(request)['dry'])).toEqual([true, false, true, false]);
    const [dryUsdc, realUsdc, drySol, realSol] = sent.map(quoteBody);
    expect(realUsdc).toEqual({
      dry: false,
      swapType: 'FLEX_INPUT',
      slippageTolerance: 100,
      originAsset: baseUsdc.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: `nep141:${testnetNearUsdcAddress}`,
      amount: '2000000',
      refundTo: 'treasury.anyfare.testnet',
      refundType: 'INTENTS',
      recipient: 'treasury.anyfare.testnet',
      recipientType: 'DESTINATION_CHAIN',
      deadline: hours(24),
    });
    expect(dryUsdc).toEqual({ ...realUsdc, dry: true });
    expect(realSol).toMatchObject({ originAsset: sol.assetId, amount: '100000000', deadline: '2026-11-09T17:30:00.000Z', refundType: 'INTENTS' });
    expect(drySol).toEqual({ ...realSol, dry: true });
    expect((await rowsOf(owner.id)).map(row => [row.tokenSymbol, row.payBy.toISOString()]).sort()).toEqual([
      ['SOL', '2026-11-09T17:30:00.000Z'],
      ['USDC', hours(24)],
    ]);
  });

  it('refuses a top-up worth less than its network\'s minimum after the dry quote, with no row and no real quote', async () => {
    const owner = await signup();
    const seen = oneClick.requests.length;
    const before = await results(app);

    const small = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '0.5' });
    // $0.994 rounds to $0.99
    const justUnder = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '0.995' });

    expect(small).toMatchObject({
      status: 400,
      body: { error: { code: 'amount_too_small', message: 'A top-up on base must be worth at least $1. This one is worth $0.50.' } },
    });
    expect(justUnder).toMatchObject({ status: 400, body: { error: { code: 'amount_too_small', message: expect.stringContaining('This one is worth $0.99.') } } });
    expect(quotesSince(seen).map(request => quoteBody(request)['dry'])).toEqual([true, true]);
    expect(await rowsOf(owner.id)).toEqual([]);
    expect((await results(app))['too_small']).toBe((before['too_small'] ?? 0) + 2);
  });

  it.each([
    ['0.995000000000', 201],
    ['0.994999000000', 400],
  ])('rounds a dry quote worth $%s to the cent against a $1 minimum', async (amountInUsd, status) => {
    const owner = await signup();
    oneClick.handle('/v0/quote', request => isReal(request) ? undefined : dryAnswer(request, amountInUsd));

    const answered = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' });

    expect(answered.status).toBe(status);
    if (status === 400)
      expect(answered.body).toMatchObject({ error: { code: 'amount_too_small', message: 'A top-up on base must be worth at least $1. This one is worth $0.99.' } });
  });

  it('takes a top-up worth exactly the minimum once rounded to the cent', async () => {
    const owner = await signup();

    // 0.996 USDC at 1Click's price is $0.99548, which rounds to $1.00
    const created = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '0.996' });

    expect(created).toMatchObject({ status: 201, body: { status: 'waiting', amount: '0.996' } });
  });

  it('answers 1Click\'s refusal of the dry quote with its message, and records nothing', async () => {
    const owner = await signup();
    const seen = oneClick.requests.length;
    const before = await results(app);

    // Under the fake's least amount of 150000 atomic units
    const refused = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '0.1' });

    expect(refused).toMatchObject({
      status: 400,
      body: { error: { code: 'topup_refused', message: expect.stringContaining('Amount is too low for bridge, try at least 150000') } },
    });
    expect(quotesSince(seen)).toHaveLength(1);
    expect(await rowsOf(owner.id)).toEqual([]);
    expect((await results(app))['refused']).toBe((before['refused'] ?? 0) + 1);
  });

  it.each([
    ['times out', 'timeout', { status: 201, body: {}, delayMs: timeoutMs * 3 }],
    ['answers 503', 'server_error', { status: 503, body: { message: 'Service Unavailable' } }],
    ['cuts the connection', 'connection_failed', { status: 200, destroy: true }],
  ])('marks the top-up quote_unknown when the real quote %s, answers 503, and asks for it exactly once', async (_case, reason, failure) => {
    const owner = await signup();
    const seen = oneClick.requests.length;
    const before = await results(app);
    oneClick.handle('/v0/quote', request => isReal(request) ? failure : undefined);

    const answered = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' });

    expect(answered).toMatchObject({
      status: 503,
      body: { error: { code: 'topups_unavailable', message: 'No deposit address was made. Nothing to send. Try again.' } },
    });
    expect(quotesSince(seen).filter(isReal)).toHaveLength(1);
    const rows = await rowsOf(owner.id);
    expect(rows).toEqual([expect.objectContaining({ status: 'quote_unknown', quoteError: reason, depositAddress: null, nextPollAt: null })]);
    expect(linesOf(app, 'A top-up\'s quote didn\'t answer, so no deposit address was given').at(-1)).toMatchObject({
      level: 40, topupId: rows[0]!.id, accountId: owner.id, reason,
    });
    expect((await results(app))['unknown']).toBe((before['unknown'] ?? 0) + 1);
    const shown = await call(app, 'GET', `/v1/topups/${rows[0]!.id}`, { key: owner.masterKey });
    expect(shown.body).toMatchObject({ status: 'quote_unknown', depositAddress: null, send: null, addressExpiresAt: null });
  });

  it('marks the top-up quote_failed when 1Click refuses the real quote, and answers 400', async () => {
    const owner = await signup();
    oneClick.handle('/v0/quote', request => isReal(request) ? { status: 400, body: { message: 'Not enough liquidity for this swap' } } : undefined);

    const refused = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' });

    expect(refused).toMatchObject({ status: 400, body: { error: { code: 'topup_refused', message: expect.stringContaining('Not enough liquidity for this swap') } } });
    expect(await rowsOf(owner.id)).toEqual([expect.objectContaining({ status: 'quote_failed', quoteError: 'Not enough liquidity for this swap', depositAddress: null })]);
  });

  it('refuses a real quote for another recipient: 502, quote_failed with the answer kept, and one error line', async () => {
    const owner = await signup();
    const addresses = scriptRealAnswer({ echo: { recipient: 'someone-else.testnet' } });

    const answered = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' });

    await expectMismatch(answered, owner.id, addresses, 'recipient');
    const [row] = await rowsOf(owner.id);
    expect(row!.quoteResponse).toMatchObject({ quoteRequest: { recipient: 'someone-else.testnet' } });
    const errors = app.logs.filter(line => line['level'] === 50 && line['topupId'] === row!.id);
    expect(errors).toEqual([expect.objectContaining({
      msg: 'A top-up\'s quote didn\'t match the request, so its deposit address was not given',
      expected: 'treasury.anyfare.testnet',
      received: 'someone-else.testnet',
      depositAddress: addresses[0],
      correlationId,
    })]);
  });

  // Every field of the real request, each changed in the answer's echo
  const echoChanges: readonly (readonly [string, unknown])[] = [
    ['dry', true],
    ['swapType', 'EXACT_INPUT'],
    ['slippageTolerance', 10_000],
    ['originAsset', 'nep141:base.omft.near'],
    ['depositType', 'INTENTS'],
    ['destinationAsset', 'nep141:usdc.someone-else.near'],
    ['amount', '2000000'],
    ['refundTo', 'someone-else.testnet'],
    ['refundType', 'ORIGIN_CHAIN'],
    ['recipient', 'someone-else.testnet'],
    ['recipientType', 'INTENTS'],
    ['deadline', hours(48)],
  ];

  it('compares every field the real request sends', async () => {
    const owner = await signup();
    const seen = oneClick.requests.length;

    await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' });

    expect(Object.keys(quoteBody(quotesSince(seen).find(isReal))).sort()).toEqual(echoChanges.map(([field]) => field).sort());
  });

  it.each(echoChanges)('refuses an answer whose quoteRequest has another %s', async (field, value) => {
    const owner = await signup();
    const addresses = scriptRealAnswer({ echo: { [field]: value } });

    await expectMismatch(await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' }), owner.id, addresses, `quoteRequest.${field}`);
  });

  it('refuses an answer whose quoteRequest leaves out a field we sent', async () => {
    const owner = await signup();
    const addresses = scriptRealAnswer({ echo: { recipientType: undefined } });

    await expectMismatch(await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' }), owner.id, addresses, 'quoteRequest.recipientType');
  });

  it('takes the same deadline written another way', async () => {
    const owner = await signup();
    scriptRealAnswer({ echo: { deadline: '2026-11-10T15:00:00+03:00' } });

    expect((await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' })).status).toBe(201);
  });

  it.each([
    ['app fees over 100 basis points in all', [{ recipient: 'fees.near', fee: 60 }, { recipient: 'more-fees.near', fee: 41 }], 'add up to 101 basis points'],
    ['app fees that aren\'t a list', { recipient: 'fees.near', fee: 1 }, 'appFees'],
    ['an app fee that isn\'t a number', [{ recipient: 'fees.near', fee: '20' }], 'appFees'],
  ])('refuses an answer with %s', async (_case, appFees, reason) => {
    const owner = await signup();
    const addresses = scriptRealAnswer({ echo: { appFees } });

    await expectMismatch(await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' }), owner.id, addresses, reason);
  });

  it.each([
    ['20 basis points to 1Click', [{ recipient: 'app-fees.near', fee: 20 }]],
    ['100 basis points in all', [{ recipient: 'fees.near', fee: 60 }, { recipient: 'more-fees.near', fee: 40 }]],
    ['an empty list of app fees', []],
  ])('takes an answer with %s', async (_case, appFees) => {
    const owner = await signup();
    const addresses = scriptRealAnswer({ echo: { appFees } });

    const created = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' });

    expect(created).toMatchObject({ status: 201, body: { status: 'waiting', depositAddress: addresses[0] } });
  });

  it.each([
    ['an amountIn other than the amount asked for', { amountIn: '999999' }, 'amountIn isn\'t the amount asked for'],
    ['a minAmountIn above its amountIn', { minAmountIn: '1000001' }, 'minAmountIn is more than its amountIn'],
    ['a minAmountOut above its amountOut', { minAmountOut: '999381' }, 'minAmountOut is more than its amountOut'],
  ])('refuses a quote with %s', async (_case, quote, reason) => {
    const owner = await signup();
    const addresses = scriptRealAnswer({ quote });

    await expectMismatch(await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' }), owner.id, addresses, reason);
  });

  it('leaves the top-up quoting and logs the answer once when it can\'t be recorded, answering 500', async () => {
    const [first, owner] = [await signup(), await signup()];
    const taken = (await topUp(first.masterKey, { network: 'base', token: 'USDC', amount: '1' })).body['depositAddress'] as string;
    // An address another top-up has: the write breaks the unique index
    scriptRealAnswer({ quote: { depositAddress: taken } });

    const answered = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' });

    expect(answered).toMatchObject({ status: 500, body: { error: { code: 'internal_error' } } });
    const rows = await rowsOf(owner.id);
    expect(rows).toEqual([expect.objectContaining({ status: 'quoting', depositAddress: null, quoteResponse: null })]);
    expect(app.logs.filter(line => line['level'] === 50 && line['topupId'] === rows[0]!.id)).toEqual([expect.objectContaining({
      msg: 'A top-up\'s quote could not be recorded, so it stays quoting. An operator should look at it',
      accountId: owner.id,
      depositAddress: taken,
      correlationId,
      error: expect.any(Object),
    })]);
    expect(linesOf(app, 'A top-up was created').filter(line => line['topupId'] === rows[0]!.id)).toEqual([]);
  });

  it.each([
    ['an unknown network', { network: 'dogechain', token: 'USDC', amount: '1' }, 'unsupported_network', 'Networks: base, arbitrum, solana, near, ethereum, bitcoin'],
    ['an unknown token', { network: 'base', token: 'DOGE', amount: '1' }, 'unknown_token', 'No token "DOGE" on base'],
    ['an amount of zero', { network: 'base', token: 'USDC', amount: '0' }, 'invalid_amount', 'more than 0'],
    ['more decimals than the token has', { network: 'base', token: 'USDC', amount: '1.0000001' }, 'invalid_amount', 'at most 6 decimals'],
    ['an amount with an exponent', { network: 'base', token: 'USDC', amount: '1e3' }, 'invalid_request', 'amount'],
    ['a number for an amount', { network: 'base', token: 'USDC', amount: 1 }, 'invalid_request', 'amount'],
    ['an unknown field', { network: 'base', token: 'USDC', amount: '1', recipient: 'me.near' }, 'invalid_request', 'additional properties'],
    ['a missing field', { network: 'base', token: 'USDC' }, 'invalid_request', 'amount'],
  ])('refuses %s with 400, sending no quote', async (_case, body, code, message) => {
    const owner = await signup();
    const seen = oneClick.requests.length;

    const refused = await topUp(owner.masterKey, body);

    expect(refused).toMatchObject({ status: 400, body: { error: { code, message: expect.stringContaining(message) } } });
    expect(quotesSince(seen)).toEqual([]);
    expect(await rowsOf(owner.id)).toEqual([]);
  });

  it('refuses a token that holds a key anywhere, in any case, without echoing it or looking it up', async () => {
    // A new app, whose catalog has never read the list: any lookup would reach the fake
    const fresh = await start(config);
    const owner = await signup(fresh);
    const paymentKey = (await call(fresh, 'POST', '/v1/keys', { key: owner.masterKey })).body['key'] as string;
    const seen = oneClick.requests.length;

    const tokens = [owner.masterKey, ` ${owner.masterKey}`, `USDC ${owner.masterKey}`, owner.masterKey.toUpperCase(), `nep141:${paymentKey}`, `USDC${paymentKey.toUpperCase()}`];
    const refused = [];
    for (const token of tokens)
      refused.push(await topUp(owner.masterKey, { network: 'base', token, amount: '1' }, fresh));

    expect(refused).toEqual(tokens.map(() => expect.objectContaining({ status: 400, body: { error: { code: 'unknown_token', message: expect.any(String) } } })));
    for (const key of [owner.masterKey, paymentKey]) {
      const secret = key.slice(key.indexOf('_test_') + 6);
      expect(JSON.stringify(refused)).not.toContain(secret);
      expect(JSON.stringify(refused).toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(oneClick.requests.slice(seen)).toEqual([]);
    // Another token is looked up, so the guard, not a cached list, kept the fake out
    expect(await topUp(owner.masterKey, { network: 'base', token: 'DOGE', amount: '1' }, fresh)).toMatchObject({ status: 400, body: { error: { code: 'unknown_token' } } });
    expect(oneClick.requests.slice(seen).map(request => request.path)).toEqual(['/v0/tokens']);
  });

  it('refuses a token that matches two on the network with 400 ambiguous_token, naming both', async () => {
    const withHypercore = await start({
      ...config,
      topups: { ...config.topups, networks: [...config.topups.networks, { name: 'hypercore', blockchain: 'hypercore', minimum: 1_000_000n }] },
    });
    const owner = await signup(withHypercore);
    const seen = oneClick.requests.length;

    const refused = await topUp(owner.masterKey, { network: 'hypercore', token: 'USDC', amount: '1' }, withHypercore);

    expect(refused).toMatchObject({
      status: 400,
      body: { error: { code: 'ambiguous_token', message: expect.stringMatching(/0x6d1e7cde53ba9467b783cb7c530ce054.*0xb88339CB7199b77E23DB6E890353E22632Ba630f/) } },
    });
    expect(quotesSince(seen)).toEqual([]);
  });

  it('answers 503 for every route while top-ups are off, without calling 1Click', async () => {
    const off = await start({ ...config, topups: { ...config.topups, enabled: false } });
    const owner = await signup(off);
    const seen = oneClick.requests.length;

    const answers = [
      await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' }, off),
      await call(off, 'GET', '/v1/topups/top_anything', { key: owner.masterKey }),
      await call(off, 'GET', '/v1/topups/options'),
    ];

    expect(answers).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({
      status: 503, body: { error: { code: 'topups_unavailable', message: 'Top-ups are off' } },
    })));
    expect(oneClick.requests.slice(seen)).toEqual([]);
    expect(off.logs.filter(line => (line['level'] as number) >= 50)).toEqual([]);
  });

  it('limits each account\'s top-ups, answering 429 with Retry-After after the limit', async () => {
    const limited = await start({ ...config, rateLimits: { ...config.rateLimits, topups: { requests: 2, windowSeconds: 3_600 } } });
    const [owner, other] = [await signup(limited), await signup(limited)];
    const body = { network: 'base', token: 'USDC', amount: '1' };

    const statuses = [await topUp(owner.masterKey, body, limited), await topUp(owner.masterKey, body, limited)].map(answer => answer.status);
    const over = await topUp(owner.masterKey, body, limited);

    expect(statuses).toEqual([201, 201]);
    expect(over).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(3_500);
    expect(await rowsOf(owner.id)).toHaveLength(2);
    expect((await topUp(other.masterKey, body, limited)).status).toBe(201);
    expect(await redis.client.get(`${redis.prefix}rl:api:topups:${owner.id}`)).toBe('3');
  });

  it('needs the master key', async () => {
    expect((await call(app, 'POST', '/v1/topups', { body: { network: 'base', token: 'USDC', amount: '1' } })).status).toBe(401);
    expect((await topUp('afm_test_not-a-key', { network: 'base', token: 'USDC', amount: '1' })).status).toBe(401);
    expect((await call(app, 'GET', '/v1/topups/top_anything')).status).toBe(401);
  });
});

describe('GET /v1/topups/options', () => {
  it('lists the networks in config order with their minimums and the tokens 1Click takes on each, without a key', async () => {
    const options = await call(app, 'GET', '/v1/topups/options');

    expect(options.status).toBe(200);
    expect(options.headers.get('cache-control')).toBe('public, max-age=60');
    const networks = options.body['networks'] as { name: string; minimum: string; tokens: unknown[] }[];
    expect(options.body['asset']).toBe('USDC on NEAR');
    expect(networks.map(network => [network.name, network.minimum])).toEqual([
      ['base', '1'], ['arbitrum', '1'], ['solana', '1'], ['near', '1'], ['ethereum', '5'], ['bitcoin', '10'],
    ]);
    expect(networks[0]!.tokens).toEqual([
      { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
      { symbol: 'ETH', decimals: 18 },
    ]);
    expect(networks[5]!.tokens).toEqual([{ symbol: 'BTC', decimals: 8 }]);
    expect(networks[3]!.tokens.map(token => (token as { symbol: string }).symbol)).toEqual(['USDC', 'wNEAR', 'tUSDC']);
  });

  it('still answers 200 without tokens when the token list fails, and a top-up then answers 503', async () => {
    // A new app, whose catalog has never read the list
    const fresh = await start(config);
    const owner = await signup(fresh);
    oneClick.handle('/v0/tokens', () => ({ status: 500, body: { message: 'Internal server error' } }));

    const options = await call(fresh, 'GET', '/v1/topups/options');
    const created = await topUp(owner.masterKey, { network: 'base', token: 'USDC', amount: '1' }, fresh);

    expect(options.status).toBe(200);
    expect(options.headers.get('cache-control')).toBe('no-store');
    expect((options.body['networks'] as Record<string, unknown>[]).map(network => Object.keys(network))).toEqual(Array.from({ length: 6 }, () => ['name', 'minimum']));
    expect(created).toMatchObject({ status: 503, body: { error: { code: 'topups_unavailable' } } });
    expect(await rowsOf(owner.id)).toEqual([]);
    expect(await results(fresh)).toEqual({ unavailable: 1 });
  });

  it('answers from the older token list, with one warn line, when a refresh fails', async () => {
    const fresh = await start(config);
    expect(((await call(fresh, 'GET', '/v1/topups/options')).body['networks'] as { tokens?: unknown[] }[])[0]!.tokens).toHaveLength(2);
    // Past the catalog's five minutes, so the next call fetches the list again
    clock.advance(6 * 60_000);
    oneClick.handle('/v0/tokens', () => ({ status: 503, body: { message: 'Service Unavailable' } }));

    const options = await call(fresh, 'GET', '/v1/topups/options');

    expect((options.body['networks'] as { tokens?: unknown[] }[])[0]!.tokens).toHaveLength(2);
    expect(linesOf(fresh, 'The 1Click token list could not be refreshed, so top-ups use the older list')).toEqual([
      expect.objectContaining({ level: 40, ageMs: 6 * 60_000, error: expect.objectContaining({ code: 'oneclick_unavailable' }) }),
    ]);
  });

  it('limits calls per client IP under the documents limit', async () => {
    const limited = await start({ ...config, rateLimits: { ...config.rateLimits, documents: { requests: 2, windowSeconds: 60 } } });

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1)
      statuses.push((await call(limited, 'GET', '/v1/topups/options', { ip: '203.0.113.40' })).status);

    expect(statuses).toEqual([200, 200, 429]);
  });
});
