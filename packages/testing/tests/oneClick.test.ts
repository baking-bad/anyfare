import { afterEach, describe, expect, it } from 'vitest';

import { createFakeClock, defaultOneClickTokens, startFakeOneClick, testnetNearUsdcAddress, type FakeOneClick } from '../src/index.js';

const baseUsdc = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const testnetUsdc = `nep141:${testnetNearUsdcAddress}`;

let oneClick: FakeOneClick | undefined;

afterEach(async () => {
  await oneClick?.close();
  oneClick = undefined;
});

const call = async (path: string, body?: unknown) => {
  const response = await fetch(`${oneClick!.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'fake-key' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const quoteRequest = (changes: Record<string, unknown> = {}) => ({
  dry: false, swapType: 'FLEX_INPUT', slippageTolerance: 100, originAsset: baseUsdc, depositType: 'ORIGIN_CHAIN', destinationAsset: testnetUsdc,
  amount: '2000000', refundTo: 'treasury.anyfare.testnet', refundType: 'INTENTS', recipient: 'treasury.anyfare.testnet', recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-11-10T12:00:00.000Z', ...changes,
});

describe('the fake 1Click', () => {
  it('lists real tokens, with two USDC on hypercore and USDC on NEAR testnet', async () => {
    oneClick = await startFakeOneClick();
    const { status, body } = await call('/v0/tokens');

    expect(status).toBe(200);
    expect(body).toEqual(defaultOneClickTokens);
    expect(defaultOneClickTokens.filter(token => token.blockchain === 'hypercore' && token.symbol === 'USDC')).toHaveLength(2);
    expect(defaultOneClickTokens.find(token => token.assetId === testnetUsdc)).toMatchObject({ blockchain: 'near', decimals: 6 });
  });

  it('answers a real quote with a new address, a deadline 72 hours after the requested one, and remembers it', async () => {
    const clock = createFakeClock('2026-11-09T12:00:00.000Z');
    oneClick = await startFakeOneClick({ now: clock.now });
    const first = await call('/v0/quote', quoteRequest());
    const second = await call('/v0/quote', quoteRequest());

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      timestamp: '2026-11-09T12:00:00.000Z',
      signature: expect.stringMatching(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/),
      correlationId: expect.any(String),
      quoteRequest: { ...quoteRequest(), depositMode: 'SIMPLE', confidentiality: 'public' },
      quote: {
        amountIn: '2000000', amountInFormatted: '2.0', amountInUsd: '1.998960000000', minAmountIn: '1980000',
        // $1.99896 less 1 basis point, in 6 decimals
        amountOut: '1998760', amountOutFormatted: '1.99876', minAmountOut: '1978772',
        depositAddress: expect.stringMatching(/^0x[0-9a-f]{40}$/), deadline: '2026-11-13T12:00:00.000Z', timeWhenInactive: '2026-11-13T12:00:00.000Z',
      },
    });
    expect((second.body['quote'] as Record<string, unknown>)['depositAddress']).not.toBe((first.body['quote'] as Record<string, unknown>)['depositAddress']);
    expect(oneClick.quotes()).toEqual([first.body, second.body]);
    expect(oneClick.requests[0]).toMatchObject({ method: 'POST', path: '/v0/quote', body: quoteRequest(), headers: { 'x-api-key': 'fake-key' } });
  });

  it('gives each chain its own kind of address, and forgets a dry quote', async () => {
    oneClick = await startFakeOneClick();
    const addressFrom = async (originAsset: string) =>
      ((await call('/v0/quote', quoteRequest({ originAsset, amount: '100000000' }))).body['quote'] as Record<string, unknown>)['depositAddress'];

    expect(await addressFrom('nep141:sol.omft.near')).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(await addressFrom('nep141:wrap.near')).toMatch(/^[0-9a-f]{64}$/);
    expect(await addressFrom('nep141:btc.omft.near')).toMatch(/^bc1q[02-9ac-hj-np-z]{38}$/);
    const dry = await call('/v0/quote', quoteRequest({ dry: true }));
    expect(dry.status).toBe(201);
    expect(dry.body['quote']).not.toHaveProperty('depositAddress');
    expect(dry.body['quote']).not.toHaveProperty('deadline');
    expect(oneClick.quotes()).toHaveLength(3);
  });

  it('refuses a request without its fields, and an amount below the bridge\'s minimum, as 1Click does', async () => {
    oneClick = await startFakeOneClick();
    const { recipient: _recipient, ...withoutRecipient } = quoteRequest();

    expect(await call('/v0/quote', withoutRecipient)).toEqual({ status: 400, body: { message: 'recipient should not be empty', error: 'Bad Request', statusCode: 400 } });
    expect(await call('/v0/quote', quoteRequest({ amount: '1000' }))).toEqual({
      status: 400, body: { message: 'Amount is too low for bridge, try at least 150000', correlationId: expect.any(String), timestamp: expect.any(String), path: '/v0/quote' },
    });
  });

  it('reports a swap at PENDING_DEPOSIT, then at the status a test sets, with details filled from the quote', async () => {
    oneClick = await startFakeOneClick();
    const quote = (await call('/v0/quote', quoteRequest())).body as { quote: { depositAddress: string } };
    const address = quote.quote.depositAddress;

    expect(await call(`/v0/status?depositAddress=${address}`)).toMatchObject({
      status: 200, body: { status: 'PENDING_DEPOSIT', swapDetails: { depositedAmount: null, nearTxHashes: [], originChainTxHashes: [] }, quoteResponse: { quote: { depositAddress: address } } },
    });
    oneClick.setStatus(address, 'SUCCESS');
    expect((await call(`/v0/status?depositAddress=${address}`)).body).toMatchObject({
      status: 'SUCCESS',
      swapDetails: {
        depositedAmount: '2000000', amountIn: '2000000', amountOut: '1998760', refundedAmount: '0', slippage: 0,
        originChainTxHashes: [{ hash: expect.stringMatching(/^0x[0-9a-f]{64}$/), explorerUrl: '' }], destinationChainTxHashes: [{ hash: expect.any(String), explorerUrl: '' }],
      },
    });
    oneClick.setStatus(address, 'REFUNDED', { refundReason: 'made up' });
    expect((await call(`/v0/status?depositAddress=${address}`)).body).toMatchObject({
      status: 'REFUNDED', swapDetails: { refundedAmount: '2000000', refundReason: 'made up', amountIn: null, amountOut: null },
    });
    expect(await call('/v0/status?depositAddress=0x0000000000000000000000000000000000000001')).toEqual({
      status: 404, body: { message: 'Deposit address 0x0000000000000000000000000000000000000001 not found' },
    });
    expect(() => oneClick!.setStatus('unknown', 'SUCCESS')).toThrow(/no quote/);
  });

  it('answers a script until reset, and falls back to the default when the script answers nothing', async () => {
    oneClick = await startFakeOneClick();
    oneClick.handle('/v0/tokens', () => ({ status: 503, body: { message: 'down' } }));
    oneClick.handle('/v0/quote', request => (request.body as Record<string, unknown>)['amount'] === '7' ? { status: 422, body: { message: 'seven' } } : undefined);

    expect((await call('/v0/tokens')).status).toBe(503);
    expect(await call('/v0/quote', quoteRequest({ amount: '7' }))).toEqual({ status: 422, body: { message: 'seven' } });
    expect((await call('/v0/quote', quoteRequest())).status).toBe(201);
    oneClick.reset();
    expect((await call('/v0/tokens')).status).toBe(200);
  });

  it('cuts the connection when a script says destroy', async () => {
    oneClick = await startFakeOneClick();
    oneClick.handle('/v0/tokens', () => ({ status: 200, destroy: true }));

    await expect(fetch(`${oneClick.url}/v0/tokens`)).rejects.toThrow();
  });

  describe('the control', () => {
    const post = async (body: unknown, raw = false) => {
      const response = await fetch(`${oneClick!.url}/_test/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? String(body) : JSON.stringify(body) });

      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const statusOf = async (address: string) => (await call(`/v0/status?depositAddress=${address}`)).body as Record<string, any>;

    it('is off by default: both paths answer as any unknown path does, and are recorded', async () => {
      oneClick = await startFakeOneClick();
      const unknown = await call('/_test/other');
      const quotes = await call('/_test/quotes');
      const moved = await fetch(`${oneClick.url}/_test/status`, { method: 'POST', body: '{}' });

      expect(quotes).toEqual({ status: 404, body: { ...unknown.body, message: 'Cannot GET /_test/quotes' } });
      expect(moved.status).toBe(404);
      expect(oneClick.requests.map(request => request.path)).toEqual(['/_test/other', '/_test/quotes', '/_test/status']);
    });

    it('lists the remembered quotes, newest last, and leaves the requests alone', async () => {
      oneClick = await startFakeOneClick({ controls: true });
      const first = (await call('/v0/quote', quoteRequest())).body['quote'] as Record<string, string>;
      await call('/v0/quote', quoteRequest({ dry: true }));
      const second = (await call('/v0/quote', quoteRequest())).body['quote'] as Record<string, string>;
      oneClick.setStatus(first['depositAddress']!, 'PROCESSING');
      const seen = oneClick.requests.length;

      expect(await call('/_test/quotes')).toEqual({
        status: 200,
        body: [{ depositAddress: first['depositAddress'], status: 'PROCESSING' }, { depositAddress: second['depositAddress'], status: 'PENDING_DEPOSIT' }],
      });
      expect(oneClick.requests).toHaveLength(seen);
    });

    it.each([
      ['INCOMPLETE_DEPOSIT', { depositedAmount: '990000', nearTxHashes: [expect.any(String)] }],
      ['PROCESSING', { depositedAmount: '2000000', amountOut: null }],
      ['SUCCESS', { depositedAmount: '2000000', amountOut: '1998760', refundedAmount: '0' }],
      ['REFUNDED', { refundedAmount: '2000000', amountOut: null }],
      ['FAILED', { depositedAmount: '2000000', amountOut: null }],
    ])('moves a swap to %s with the details its quote gives', async (status, details) => {
      oneClick = await startFakeOneClick({ controls: true });
      const address = ((await call('/v0/quote', quoteRequest())).body['quote'] as Record<string, string>)['depositAddress']!;
      const seen = oneClick.requests.length;

      expect(await post({ depositAddress: address, status })).toEqual({ status: 200, body: { depositAddress: address, status } });
      expect(await statusOf(address)).toMatchObject({ status, swapDetails: details });
      expect((await call('/_test/quotes')).body).toEqual([{ depositAddress: address, status }]);
      // Only the status read above is recorded
      expect(oneClick.requests).toHaveLength(seen + 1);
    });

    it('lets swapDetails override the fill', async () => {
      oneClick = await startFakeOneClick({ controls: true });
      const address = ((await call('/v0/quote', quoteRequest())).body['quote'] as Record<string, string>)['depositAddress']!;

      await post({ depositAddress: address, status: 'INCOMPLETE_DEPOSIT', swapDetails: { depositedAmount: '5' } });

      expect(await statusOf(address)).toMatchObject({ status: 'INCOMPLETE_DEPOSIT', swapDetails: { depositedAmount: '5' } });
    });

    it('answers 404 for an address it does not remember, and 400 for a bad status or body', async () => {
      oneClick = await startFakeOneClick({ controls: true });
      const address = ((await call('/v0/quote', quoteRequest())).body['quote'] as Record<string, string>)['depositAddress']!;

      expect((await post({ depositAddress: '0xabc', status: 'SUCCESS' })).status).toBe(404);
      expect((await post({ depositAddress: address, status: 'DONE' })).status).toBe(400);
      expect((await post({ depositAddress: address })).status).toBe(400);
      expect((await post({ status: 'SUCCESS' })).status).toBe(400);
      expect((await post({ depositAddress: address, status: 'SUCCESS', swapDetails: 'x' })).status).toBe(400);
      expect((await post('not json', true)).status).toBe(400);
      expect((await post([], true)).status).toBe(400);
      expect((await statusOf(address))['status']).toBe('PENDING_DEPOSIT');
    });
  });
});
