import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Secret } from '@anyfare/common';
import { loadPlatformConfig } from '@anyfare/core';
import { createFakeClock, defaultOneClickTokens, startFakeOneClick, testnetNearUsdcAddress, type FakeOneClick, type FakeOneClickAnswer } from '@anyfare/testing';

import {
  buildQuoteRequest, createOneClickClient, fromOneClickStatus, maxOneClickAnswerBytes, OneClickNotFoundError, OneClickRefusedError, oneClickStatuses,
  OneClickUnavailableError, type OneClickClient, type OneClickQuoteRequest,
} from '../src/index.js';

const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml', CONFIG: '{"topups":{"enabled":true}}', CONFIG_DECODE: 'false' } });
const baseUsdc = defaultOneClickTokens.find(token => token.blockchain === 'base' && token.symbol === 'USDC')!;
const clock = createFakeClock('2026-11-09T12:00:00.000Z');

let oneClick: FakeOneClick;
let client: OneClickClient;
// Where this test's requests start in the fake's record
let seen = 0;
const requests = () => oneClick.requests.slice(seen);

beforeAll(async () => {
  oneClick = await startFakeOneClick({ now: clock.now });
});

afterAll(async () => {
  await oneClick.close();
});

beforeEach(() => {
  seen = oneClick.requests.length;
});

afterEach(() => {
  oneClick.reset();
});

const clientWith = (options: { readonly apiKey?: Secret; readonly timeoutMs?: number } = {}) =>
  createOneClickClient({ url: oneClick.url, timeoutMs: 2_000, ...options });

const request = (changes: Partial<Omit<OneClickQuoteRequest, 'dry'>> = {}) => ({
  ...buildQuoteRequest({ topups: config.topups, token: baseUsdc, amount: 2_000_000n, now: clock.now(), dry: false }),
  ...changes,
});
const dryRequest = (): OneClickQuoteRequest => ({ ...request(), dry: true });

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
  try {
    await call();
  }
  catch (error) {
    return error as Error;
  }
  throw new Error('Expected a failure');
};

describe('the 1Click client', () => {
  beforeAll(() => {
    client = clientWith();
  });

  it('reads the token list, without a key header unless it has a key', async () => {
    const tokens = await client.tokens();

    expect(tokens).toEqual(defaultOneClickTokens);
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ method: 'GET', path: '/v0/tokens', headers: { accept: 'application/json' } });
    expect(requests()[0]!.headers).not.toHaveProperty('x-api-key');
    expect(requests()[0]!.headers).not.toHaveProperty('content-type');
  });

  it('sends the key in X-API-Key when it has one, and never echoes it in an error', async () => {
    const keyed = clientWith({ apiKey: Secret.from('oneclick-key-secret') });
    await keyed.tokens();
    oneClick.handle('/v0/tokens', () => ({ status: 401, body: { message: 'Invalid API key oneclick-key-secret' } }));
    const error = await failure(() => keyed.tokens());

    expect(requests()[0]!.headers['x-api-key']).toBe('oneclick-key-secret');
    expect(error).toBeInstanceOf(OneClickUnavailableError);
    expect(error).toMatchObject({ code: 'oneclick_unavailable', reason: 'auth_failed', status: 401 });
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('oneclick-key-secret');
  });

  it('leaves out a token it can\'t read, and refuses a list with none it can read', async () => {
    oneClick.handle('/v0/tokens', () => ({ status: 200, body: [...defaultOneClickTokens.slice(0, 2), { ...baseUsdc, assetId: 'nep141:odd', price: null }] }));
    expect(await client.tokens()).toEqual(defaultOneClickTokens.slice(0, 2));

    oneClick.handle('/v0/tokens', () => ({ status: 200, body: [{ ...baseUsdc, decimals: '6' }] }));
    expect(await failure(() => client.tokens())).toMatchObject({ reason: 'invalid_answer', detail: 'the token list has no token in the expected shape' });
    oneClick.handle('/v0/tokens', () => ({ status: 200, body: { tokens: [] } }));
    expect(await failure(() => client.tokens())).toMatchObject({ reason: 'invalid_answer', detail: 'the token list is not a list' });
  });

  it('asks for a dry quote, which has no address and isn\'t remembered', async () => {
    const before = oneClick.quotes().length;
    const answer = await client.quote(dryRequest());

    expect(answer.quote).toEqual({
      amountIn: '2000000', minAmountIn: '1980000', amountOut: '1998760', minAmountOut: '1978772', amountInUsd: '1.998960000000', amountOutUsd: '1.998760000000',
      timeEstimate: 35, depositAddress: undefined, depositMemo: undefined, deadline: undefined, timeWhenInactive: undefined,
    });
    expect(answer).toMatchObject({ correlationId: expect.any(String), signature: expect.stringMatching(/^ed25519:/), timestamp: '2026-11-09T12:00:00.000Z' });
    expect(answer.raw).toMatchObject({ quoteRequest: { dry: true, depositMode: 'SIMPLE' } });
    expect(oneClick.quotes()).toHaveLength(before);
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ method: 'POST', path: '/v0/quote', body: dryRequest(), headers: { accept: 'application/json', 'content-type': 'application/json' } });
  });

  it('asks for a real quote, which has an address and a deadline, and keeps the whole body', async () => {
    const answer = await client.quote(request());
    const remembered = oneClick.quotes().at(-1);

    expect(answer.quote.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
    // The requested deadline, a day out for a stablecoin, plus 72 hours
    expect(answer.quote).toMatchObject({ deadline: '2026-11-13T12:00:00.000Z', timeWhenInactive: '2026-11-13T12:00:00.000Z', depositMemo: undefined });
    expect(answer.raw).toEqual(remembered);
    expect(answer.correlationId).toBe(remembered!.correlationId);
    expect(answer.raw['quoteRequest']).toMatchObject({ destinationAsset: `nep141:${testnetNearUsdcAddress}`, recipient: 'treasury.anyfare.testnet', refundType: 'INTENTS' });
  });

  it('gets two addresses for the same real quote asked twice', async () => {
    const first = await client.quote(request());
    const second = await client.quote(request());

    expect(first.quote.depositAddress).not.toBe(second.quote.depositAddress);
    expect(oneClick.quotes().slice(-2).map(quote => quote.quote.depositAddress)).toEqual([first.quote.depositAddress, second.quote.depositAddress]);
  });

  it.each(oneClickStatuses)('reads the status %s with its swap details', async status => {
    const { quote } = await client.quote(request());
    oneClick.setStatus(quote.depositAddress, status);
    const answer = await client.status({ depositAddress: quote.depositAddress });

    expect(answer.status).toBe(status);
    expect(answer.updatedAt).toBe('2026-11-09T12:00:00.000Z');
    expect(answer.raw).toMatchObject({ status, quoteResponse: { quote: { depositAddress: quote.depositAddress } } });
    expect(requests().at(-1)).toMatchObject({ method: 'GET', path: '/v0/status', query: { depositAddress: quote.depositAddress } });
    const details = answer.swapDetails;
    switch (fromOneClickStatus(status)) {
      case 'waiting':
        expect(details).toMatchObject({ depositedAmount: undefined, amountOut: undefined, nearTxHashes: [], intentHashes: [] });
        break;
      case 'incomplete':
        expect(details).toMatchObject({ depositedAmount: '990000', amountOut: undefined, nearTxHashes: [expect.any(String)] });
        break;
      case 'processing':
        expect(details).toMatchObject({ depositedAmount: '2000000', amountOut: undefined, originChainTxHashes: [{ hash: expect.any(String), explorerUrl: '' }] });
        break;
      case 'success':
        expect(details).toMatchObject({
          depositedAmount: '2000000', amountIn: '2000000', amountOut: '1998760', amountOutUsd: '1.998760000000', refundedAmount: '0', slippage: 0,
          intentHashes: [expect.any(String)], destinationChainTxHashes: [{ hash: details.nearTxHashes[0], explorerUrl: '' }],
        });
        break;
      case 'refunded':
        expect(details).toMatchObject({ depositedAmount: '2000000', refundedAmount: '2000000', refundFee: '0', refundReason: expect.any(String), amountIn: undefined, amountOut: undefined });
        break;
      case 'failed':
        expect(details).toMatchObject({ depositedAmount: '2000000', amountIn: undefined, nearTxHashes: [] });
        break;
    }
  });

  it('sends the deposit memo in the query when there is one', async () => {
    const { quote } = await client.quote(request({ depositMode: 'MEMO' }));

    expect(quote.depositMemo).toMatch(/^[0-9]{9}$/);
    expect((await client.status({ depositAddress: quote.depositAddress, depositMemo: quote.depositMemo })).status).toBe('PENDING_DEPOSIT');
    expect(requests().at(-1)?.query).toEqual({ depositAddress: quote.depositAddress, depositMemo: quote.depositMemo });
  });

  it('says 1Click knows no swap at an unknown address', async () => {
    const error = await failure(() => client.status({ depositAddress: '0x0000000000000000000000000000000000000001' }));

    expect(error).toBeInstanceOf(OneClickNotFoundError);
    expect(error).toMatchObject({ code: 'oneclick_not_found', depositAddress: '0x0000000000000000000000000000000000000001' });
  });

  it('passes on 1Click\'s refusal of an amount too low for the bridge, which made no address', async () => {
    const before = oneClick.quotes().length;
    const error = await failure(() => client.quote(request({ amount: '1000' })));

    expect(error).toBeInstanceOf(OneClickRefusedError);
    expect(error).toMatchObject({ code: 'oneclick_refused', status: 400, reason: 'Amount is too low for bridge, try at least 150000' });
    expect(oneClick.quotes()).toHaveLength(before);
  });

  const refused: readonly (readonly [string, FakeOneClickAnswer, Record<string, unknown>])[] = [
    ['a 400 with a message', { status: 400, body: { message: 'amount must be an integer string', error: 'Bad Request', statusCode: 400 } }, { status: 400, reason: 'amount must be an integer string' }],
    ['a 400 with a list of messages', { status: 400, body: { message: ['recipient should not be empty', 'deadline should not be empty'], error: 'Bad Request', statusCode: 400 } }, { reason: 'recipient should not be empty; deadline should not be empty' }],
    ['a 422 with a message', { status: 422, body: { message: 'No route for this pair' } }, { status: 422, reason: 'No route for this pair' }],
    ['a long message, cut to 300 characters', { status: 400, body: { message: 'x'.repeat(1_000) } }, { reason: 'x'.repeat(300) }],
  ];

  it.each(refused)('takes %s as a refusal, sent once', async (_name, answer, expected) => {
    oneClick.handle('/v0/quote', () => answer);
    const error = await failure(() => client.quote(request()));

    expect(error).toBeInstanceOf(OneClickRefusedError);
    expect(error).toMatchObject(expected);
    expect(requests()).toHaveLength(1);
  });

  const big = JSON.stringify({ message: 'x'.repeat(maxOneClickAnswerBytes) });
  const { depositAddress: _depositAddress, ...withoutAddress } = { depositAddress: '', amountIn: '2000000', minAmountIn: '1980000', amountOut: '1998760', minAmountOut: '1978772', amountInUsd: '2', amountOutUsd: '2', deadline: '2026-11-13T12:00:00.000Z' };
  const unavailable: readonly (readonly [string, FakeOneClickAnswer, Record<string, unknown>])[] = [
    ['a 400 without a message', { status: 400, body: { error: 'Bad Request' } }, { reason: 'unexpected_status', status: 400 }],
    ['a 401', { status: 401, body: { message: 'Unauthorized' } }, { reason: 'auth_failed', status: 401 }],
    ['a 403', { status: 403, body: { message: 'Forbidden' } }, { reason: 'auth_failed', status: 403 }],
    ['a 429', { status: 429, body: { message: 'Too many requests' } }, { reason: 'rate_limited', status: 429 }],
    ['a 503', { status: 503, body: { message: 'Service unavailable' } }, { reason: 'server_error', status: 503 }],
    ['a 404 on a quote', { status: 404, body: { message: 'Cannot POST /v0/quote' } }, { reason: 'unexpected_status', status: 404 }],
    ['a body that isn\'t JSON', { status: 201, raw: '<html>Bad gateway</html>' }, { reason: 'not_json', status: 201 }],
    ['an empty body', { status: 201 }, { reason: 'not_json', status: 201 }],
    ['a body over 1 MiB with its length', { status: 201, raw: big }, { reason: 'too_large', status: 201 }],
    ['a body over 1 MiB in chunks', { status: 201, raw: big, chunked: true }, { reason: 'too_large', status: 201 }],
    ['an error over 1 MiB', { status: 400, raw: big, chunked: true }, { reason: 'too_large', status: 400 }],
    [
      'a real quote without depositAddress', { status: 201, body: { correlationId: 'made-up', quote: withoutAddress } },
      { reason: 'invalid_answer', status: 201, detail: 'quote.depositAddress is missing from a real quote' },
    ],
    [
      'a real quote without a deadline', { status: 201, body: { correlationId: 'made-up', quote: { ...withoutAddress, deadline: undefined, depositAddress: '0x0000000000000000000000000000000000000002' } } },
      { reason: 'invalid_answer', detail: 'quote.deadline is missing from a real quote' },
    ],
    [
      'an amount that isn\'t digits', { status: 201, body: { correlationId: 'made-up', quote: { ...withoutAddress, depositAddress: '0x0000000000000000000000000000000000000002', amountOut: '1.5' } } },
      { reason: 'invalid_answer', detail: 'quote.amountOut is not an amount in digits' },
    ],
    [
      'a negative amount', { status: 201, body: { correlationId: 'made-up', quote: { ...withoutAddress, depositAddress: '0x0000000000000000000000000000000000000002', minAmountOut: '-1' } } },
      { reason: 'invalid_answer', detail: 'quote.minAmountOut is not an amount in digits' },
    ],
    ['an answer without a quote', { status: 201, body: { correlationId: 'made-up' } }, { reason: 'invalid_answer', detail: 'quote is not an object' }],
    ['a timeout', { status: 201, body: {}, delayMs: 1_000 }, { reason: 'timeout', status: undefined }],
    ['a cut connection', { status: 201, destroy: true }, { reason: 'connection_failed', status: undefined }],
  ];

  it.each(unavailable)('takes %s on a real quote as 1Click being unavailable, sent once', async (_name, answer, expected) => {
    oneClick.handle('/v0/quote', () => answer);
    const error = await failure(() => clientWith({ timeoutMs: 300 }).quote(request()));

    expect(error).toBeInstanceOf(OneClickUnavailableError);
    expect(error).toMatchObject({ code: 'oneclick_unavailable', method: 'POST', path: '/v0/quote', ...expected });
    expect(requests()).toHaveLength(1);
  });

  it('times out on a body that stops halfway', async () => {
    oneClick.handle('/v0/tokens', () => ({ status: 200, raw: big.slice(0, 1_000), delayMs: 1_000 }));
    const started = performance.now();
    const error = await failure(() => clientWith({ timeoutMs: 200 }).tokens());

    expect(error).toMatchObject({ reason: 'timeout' });
    expect(performance.now() - started).toBeLessThan(900);
  });

  it.each([
    ['an unknown status', { status: 'EXPIRED' }, 'status is not a known status'],
    ['an amount that isn\'t digits', { swapDetails: { depositedAmount: '1e6' } }, 'swapDetails.depositedAmount is not an amount in digits'],
    ['a transaction without a hash', { swapDetails: { originChainTxHashes: [{ explorerUrl: '' }] } }, 'swapDetails.originChainTxHashes[0].hash is not a string'],
    ['no quote response', { quoteResponse: null }, 'quoteResponse is not an object'],
  ])('refuses a status answer with %s', async (_name, changes, detail) => {
    const body = { correlationId: 'made-up', quoteResponse: {}, status: 'PROCESSING', updatedAt: '2026-11-09T12:00:00.000Z', swapDetails: {}, ...changes };
    oneClick.handle('/v0/status', () => ({ status: 200, body }));

    expect(await failure(() => client.status({ depositAddress: 'treasury.anyfare.testnet' }))).toMatchObject({ reason: 'invalid_answer', detail, path: '/v0/status' });
  });

  it('takes a status answer that leaves out empty lists', async () => {
    oneClick.handle('/v0/status', () => ({ status: 200, body: { correlationId: 'made-up', quoteResponse: {}, status: 'PENDING_DEPOSIT', updatedAt: '2026-11-09T12:00:00.000Z', swapDetails: {} } }));

    expect((await client.status({ depositAddress: 'treasury.anyfare.testnet' })).swapDetails).toMatchObject({
      intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], depositedAmount: undefined,
    });
  });

  it('can\'t reach a closed port', async () => {
    const closed = await startFakeOneClick();
    const url = closed.url;
    await closed.close();

    expect(await failure(() => createOneClickClient({ url, timeoutMs: 1_000 }).tokens())).toMatchObject({ reason: 'connection_failed', path: '/v0/tokens' });
  });
});
