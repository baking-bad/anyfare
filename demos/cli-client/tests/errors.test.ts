import { describe, expect, it } from 'vitest';
import { ERROR_LINES, PROXY_CODES, clip, hideKeys, httpErrorOf, stopFor } from '../src/errors.ts';
import type { ErrorContext } from '../src/errors.ts';
import { HttpError } from '../src/util.ts';

// Every code in the error files of the Platform API, the proxy, the payments, the accounts, the rate
// limit and the server, with its status
const CODES: Readonly<Record<string, number>> = {
  invalid_request: 400,
  unauthorized: 401,
  invalid_key: 401,
  wrong_key_type: 401,
  rate_limited: 429,
  not_found: 404,
  idempotency_conflict: 409,
  request_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
  invalid_target: 400,
  host_not_allowed: 400,
  not_payable: 400,
  unsupported_payment: 502,
  quote_exceeded: 502,
  multiple_payment_methods: 400,
  insufficient_balance: 402,
  key_budget_exceeded: 402,
  key_allowance_exceeded: 402,
  key_price_limit: 402,
  payment_invalid: 402,
  settlement_failed: 502,
  response_too_large: 502,
  upstream_unavailable: 503,
  facilitator_unavailable: 503,
  payment_unavailable: 503,
  redis_not_ready: 503,
};

// The codes of the proxy's own error table: on a paid call, only these are Anyfare's
const PROXY_TABLE = [
  'invalid_target', 'host_not_allowed', 'not_payable', 'unsupported_payment', 'quote_exceeded', 'multiple_payment_methods',
  'unauthorized', 'invalid_key', 'wrong_key_type', 'insufficient_balance', 'key_budget_exceeded', 'key_allowance_exceeded',
  'key_price_limit', 'payment_invalid', 'rate_limited', 'settlement_failed', 'response_too_large', 'upstream_unavailable',
  'facilitator_unavailable', 'payment_unavailable', 'redis_not_ready',
  // The shared server's, which the proxy answers before it routes a call
  'request_too_large',
];

const NOT_CHARGED_WITH_CREDITS = new Set(PROXY_TABLE.filter((code) => code !== 'settlement_failed'));

const SERVER_MESSAGE = 'A message from the server that the app does not print';

const paid: ErrorContext = { side: 'proxy', paid: { way: 'credits', apiName: 'CoinMarketCap' } };

function errorOf(code: string | undefined, status: number, details: { retryAfter?: string; requestId?: string; body?: unknown } = {}) {
  return new HttpError(status, code === undefined ? `The server answered ${status}` : SERVER_MESSAGE, {
    ...(code !== undefined && { code }),
    ...details,
  });
}

describe('stopFor', () => {
  it('has a line of its own for every code', () => {
    expect(Object.keys(ERROR_LINES).sort()).toEqual(Object.keys(CODES).sort());
    expect([...PROXY_CODES].sort()).toEqual([...PROXY_TABLE].sort());
    for (const [code, status] of Object.entries(CODES)) {
      const contexts: ErrorContext[] = PROXY_CODES.has(code) ? [paid, { side: 'api' }, { side: 'proxy' }] : [{ side: 'api' }, { side: 'proxy' }];
      for (const context of contexts) {
        const stop = stopFor(errorOf(code, status), context);
        if (code !== 'invalid_request') expect(stop.message).not.toContain(SERVER_MESSAGE);
        expect(stop.message).not.toMatch(/^Anyfare answered/);
        expect(stop.message).toMatch(/[.]$/);
        expect(stop.message.split('\n')).toHaveLength(1);
      }
    }
  });

  it('says "Not charged" for a paid call as the table says', () => {
    for (const code of PROXY_TABLE) {
      const stop = stopFor(errorOf(code, CODES[code] ?? 400), paid);
      expect([code, stop.notCharged]).toEqual([code, NOT_CHARGED_WITH_CREDITS.has(code)]);
    }
    expect(stopFor(errorOf('settlement_failed', 502), paid).line()).not.toContain('Not charged');
    expect(stopFor(errorOf('insufficient_balance', 402), paid).line()).toBe(
      "Your Credits don't cover this call. Top up, or ask the operator. Not charged.",
    );
  });

  it('says the hold is released on upstream_unavailable only for Credits', () => {
    const near: ErrorContext = { side: 'proxy', paid: { way: 'near', apiName: 'CoinMarketCap' } };
    expect(stopFor(errorOf('upstream_unavailable', 503), paid).notCharged).toBe(true);
    expect(stopFor(errorOf('upstream_unavailable', 503), near).notCharged).toBe(false);
  });

  it('never says "Not charged" for a call that paid nothing', () => {
    for (const [code, status] of Object.entries(CODES)) {
      expect(stopFor(errorOf(code, status), { side: 'api' }).notCharged).toBe(false);
      expect(stopFor(errorOf(code, status), { side: 'proxy' }).notCharged).toBe(false);
    }
  });

  it('gives plain lines for the keys and their limits', () => {
    const line = (code: string, context: ErrorContext = paid) => stopFor(errorOf(code, CODES[code] ?? 400), context).message;
    expect(line('invalid_key')).toBe('The payment key was refused: unknown, revoked or expired.');
    expect(line('wrong_key_type')).toBe('That is a master key; paid calls take a payment key.');
    expect(line('wrong_key_type', { side: 'api' })).toBe('That is a payment key; the Platform API takes the master key.');
    expect(line('key_budget_exceeded')).toBe("The payment key's daily budget is used up.");
    expect(line('key_allowance_exceeded')).toBe("The payment key's allowance is used up.");
    expect(line('key_price_limit')).toBe("The price is above the payment key's highest price per call.");
    expect(line('settlement_failed')).toBe("The payment couldn't be settled, so the answer was not sent.");
  });

  it('puts Retry-After in the line', () => {
    expect(stopFor(errorOf('rate_limited', 429, { retryAfter: '30' }), { side: 'api' }).message).toBe(
      'Too many requests; retry in 30 seconds.',
    );
    expect(stopFor(errorOf('payment_unavailable', 503, { retryAfter: '1' }), paid).line()).toBe(
      "Anyfare couldn't take the payment right now; retry in 1 second. Not charged.",
    );
    expect(stopFor(errorOf('rate_limited', 429), { side: 'api' }).message).toBe('Too many requests; retry in a moment.');
    expect(stopFor(errorOf('rate_limited', 429, { retryAfter: 'Mon, 09 Nov 2026 10:00:00 GMT' }), { side: 'api' }).message).toBe(
      'Too many requests; retry in a moment.',
    );
  });

  it('adds the request ID', () => {
    expect(stopFor(errorOf('insufficient_balance', 402, { requestId: 'req-made-up-1' }), paid).line()).toBe(
      "Your Credits don't cover this call. Top up, or ask the operator (request req-made-up-1). Not charged.",
    );
    expect(stopFor(errorOf('rate_limited', 429, { requestId: 'r 1\nx', retryAfter: '5' }), { side: 'api' }).message).toBe(
      'Too many requests; retry in 5 seconds.',
    );
  });

  it("uses the server's message only for a code it does not know, cut to 200 characters", () => {
    const long = `${'word '.repeat(60)}end`;
    const stop = stopFor(new HttpError(418, long, { code: 'brand_new_code' }), { side: 'proxy' });
    expect(stop.message.startsWith('Anyfare answered 418 brand_new_code: word word')).toBe(true);
    expect(stop.message).not.toContain('end');
    expect(stop.message.length).toBeLessThan(260);
    expect(stop.notCharged).toBe(false);
  });

  it("reads an answer that is not Anyfare's envelope on a routed call as the API's own", () => {
    const body = `{"status":{"error_message":"Invalid value for symbol"},"padding":"${'x'.repeat(300)}"}`;
    const stop = stopFor(errorOf(undefined, 400, { body, requestId: 'req-made-up-2' }), paid);
    expect(stop.message.startsWith('CoinMarketCap answered 400: {"status":{"error_message":"Invalid value for symbol"}')).toBe(true);
    expect(stop.message).toContain('… (request req-made-up-2).');
    expect(stop.notCharged).toBe(true);
    expect(stopFor(errorOf(undefined, 404, { body: '' }), paid).line()).toBe('CoinMarketCap answered 404. Not charged.');
  });

  it("says \"Not charged\" for the API's own answer below 500 when Credits or x402 paid, which Anyfare gives back", () => {
    const answer = errorOf(undefined, 404, { body: 'No such symbol' });
    for (const way of ['credits', 'base', 'near'] as const) {
      expect(stopFor(answer, { side: 'proxy', paid: { way, apiName: 'CoinMarketCap' } }).notCharged).toBe(true);
    }
    // Tempo is not built yet: nothing is said for it
    expect(stopFor(answer, { side: 'proxy', paid: { way: 'tempo', apiName: 'CoinMarketCap' } }).notCharged).toBe(false);
  });

  it("lets a payer's line decide from the answer's message whether it was charged", () => {
    const extra = { payment_invalid: { line: () => 'A later line', notCharged: (error: HttpError) => !error.message.includes('used') } };
    const near: ErrorContext = { side: 'proxy', paid: { way: 'near', apiName: 'CoinMarketCap' } };
    expect(stopFor(new HttpError(402, 'Declined', { code: 'payment_invalid' }), near, extra).notCharged).toBe(true);
    expect(stopFor(new HttpError(402, 'It was used before', { code: 'payment_invalid' }), near, extra).notCharged).toBe(false);
    // Never for a call that paid nothing
    expect(stopFor(new HttpError(402, 'Declined', { code: 'payment_invalid' }), { side: 'proxy' }, extra).notCharged).toBe(false);
  });

  it('reads a 402 with no code after a paid request as the payment not taken', () => {
    const stop = stopFor(errorOf(undefined, 402, { body: { credits: { price: '0.01' } } }), paid);
    expect(stop.line()).toBe('Anyfare asked for a payment again: the key was not accepted. Not charged.');
  });

  it('does not say "Not charged" for a 5xx that is not Anyfare\'s envelope', () => {
    const stop = stopFor(errorOf(undefined, 502, { body: '<html>Bad Gateway</html>' }), paid);
    expect(stop.line()).toBe('Anyfare answered 502: <html>Bad Gateway</html>.');
    expect(stop.notCharged).toBe(false);
  });
});

describe('stopFor, the fixes', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'takes the code %j as one it does not know',
    (code) => {
      const body = { error: { code, message: 'Made up' } };
      expect(stopFor(new HttpError(400, 'Made up', { code, body }), { side: 'api' }).message).toBe(
        `Anyfare answered 400 ${code}: Made up.`,
      );
      expect(stopFor(new HttpError(400, 'Made up', { code, body }), paid).line()).toBe(
        `CoinMarketCap answered 400: {"error":{"code":"${code}","message":"Made up"}}. Not charged.`,
      );
      const extra = stopFor(new HttpError(400, 'Made up', { code, body }), { side: 'api' }, {});
      expect(extra.message).toBe(`Anyfare answered 400 ${code}: Made up.`);
    },
  );

  it("shows the server's own message after the fixed words of invalid_request, clipped", () => {
    const message = 'body/label must NOT have more than 60 characters';
    const error = new HttpError(400, message, { code: 'invalid_request', body: { error: { code: 'invalid_request', message } } });
    expect(stopFor(error, { side: 'api' }).message).toBe(
      'Anyfare refused the request as not valid: body/label must NOT have more than 60 characters.',
    );
    const long = new HttpError(400, 'x', { code: 'invalid_request', body: { error: { code: 'invalid_request', message: `a\n${'b'.repeat(300)}` } } });
    expect(stopFor(long, { side: 'api' }).message).toBe(`Anyfare refused the request as not valid: a ${'b'.repeat(198)}….`);
    const none = new HttpError(400, 'The server answered 400', { code: 'invalid_request', body: { error: { code: 'invalid_request' } } });
    expect(stopFor(none, { side: 'api' }).message).toBe('Anyfare refused the request as not valid.');
  });

  it("reads a code the proxy does not answer, on a paid call, as the API's own answer", () => {
    const body = { error: { code: 'not_found', message: 'No such symbol' } };
    const stop = stopFor(new HttpError(404, 'No such symbol', { code: 'not_found', body, requestId: 'req-made-up-4' }), paid);
    expect(stop.line()).toBe(
      'CoinMarketCap answered 404: {"error":{"code":"not_found","message":"No such symbol"}} (request req-made-up-4). Not charged.',
    );
    const invalid = stopFor(new HttpError(400, 'x', { code: 'invalid_request', body: { error: { code: 'invalid_request', message: 'x' } } }), paid);
    expect(invalid.line()).toMatch(/^CoinMarketCap answered 400: .*\. Not charged\.$/);
    const server = stopFor(new HttpError(500, 'x', { code: 'internal_error', body: { error: { code: 'internal_error', message: 'x' } } }), paid);
    expect(server.line()).toBe('Anyfare answered 500: {"error":{"code":"internal_error","message":"x"}}.');
    expect(server.notCharged).toBe(false);
    // The one shared server code that only the proxy answers on a routed call is Anyfare's
    const tooLarge = { error: { code: 'request_too_large', message: 'The request body is too large' } };
    expect(stopFor(new HttpError(413, 'x', { code: 'request_too_large', body: tooLarge }), paid).line()).toBe(
      'The request is too large for Anyfare. Not charged.',
    );
    // The routed scope takes every content type, so a 415 on a paid call is the API's own
    const mediaType = { error: { code: 'unsupported_media_type', message: 'The content type is not supported' } };
    expect(stopFor(new HttpError(415, 'x', { code: 'unsupported_media_type', body: mediaType }), paid).line()).toBe(
      'CoinMarketCap answered 415: {"error":{"code":"unsupported_media_type","message":"The content type is not supported"}}. Not charged.',
    );
    // A later payer's own line is still Anyfare's
    const extra = { brand_new_code: { line: () => 'A later line', notCharged: true } };
    expect(stopFor(new HttpError(402, 'x', { code: 'brand_new_code' }), paid, extra).line()).toBe('A later line. Not charged.');
  });
});

describe('httpErrorOf', () => {
  it('reads the code, the message, the request ID and Retry-After', () => {
    const error = httpErrorOf({
      status: 429,
      headers: new Headers({ 'x-request-id': 'req-made-up-3', 'retry-after': '7' }),
      body: { error: { code: 'rate_limited', message: 'Too many requests. Retry after 7 s' } },
    });
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', requestId: 'req-made-up-3', retryAfter: '7' });
    expect(error.message).toBe('Too many requests. Retry after 7 s');
  });

  it('has no code when the body is not the envelope', () => {
    expect(httpErrorOf({ status: 400, headers: new Headers(), body: 'Bad request' }).code).toBeUndefined();
    expect(httpErrorOf({ status: 400, headers: new Headers(), body: { error: 'Bad request' } }).code).toBeUndefined();
  });
});

describe('hideKeys', () => {
  it('hides a private key whole, EVM or NEAR, and leaves addresses and other hex alone', () => {
    // Made up, shaped like keys so that they are hidden
    const evm = `0x${'a1'.repeat(32)}`;
    const near = `ed25519:${'3Bq'.repeat(29)}`;
    expect(hideKeys(`one ${evm}, two ${near}.`)).toBe('one 0x…, two ed25519:….');
    expect(hideKeys(`${evm.toUpperCase().replace('0X', '0x')}`)).toBe('0x…');
    const address = `0x${'b2'.repeat(20)}`;
    expect(hideKeys(`from ${address}`)).toBe(`from ${address}`);
    expect(hideKeys(`0x${'c'.repeat(66)}`)).toBe(`0x${'c'.repeat(66)}`);
    expect(clip(`refused ${near}`)).toBe('refused ed25519:…');
  });
});

describe('clip', () => {
  it('makes one line, hides keys and cuts to 200 characters', () => {
    // Made up, shaped like a key so that it is hidden
    const key = `af_live_${'Q'.repeat(43)}`;
    expect(clip(`a\nb\u001b[31m  c ${key}`)).toBe('a b [31m c af_live_QQ…');
    expect(clip('x'.repeat(250))).toBe(`${'x'.repeat(200)}…`);
  });
});
