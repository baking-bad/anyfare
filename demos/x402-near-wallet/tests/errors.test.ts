// The lines for Anyfare's errors, and the guards on what is printed. Every message here is made up.

import { describe, expect, it } from 'vitest';
import { ERROR_LINES, HttpError, PROXY_CODES, clip, hideKeys, httpErrorOf, isProxyEnvelope, retryIn, stopFor } from '../src/errors.ts';

const CHECK = 'https://nearblocks.io/address/alice.near shows your payments';
const paid = { paid: { apiName: 'The API', check: CHECK } };

describe('hideKeys', () => {
  it('hides a NEAR key and a hex key whole, and cuts an Anyfare key', () => {
    expect(hideKeys(`key ed25519:${'7'.repeat(64)} end`)).toBe('key ed25519:… end');
    expect(hideKeys(`0x${'a'.repeat(64)}`)).toBe('0x…');
    expect(hideKeys(`af_live_${'A'.repeat(43)}`)).toBe('af_live_AA…');
    expect(hideKeys('alice.near')).toBe('alice.near');
  });

  it('cuts an Anyfare key only where it starts a word', () => {
    expect(hideKeys('/v1/leaf_nodes_by_height')).toBe('/v1/leaf_nodes_by_height');
    expect(hideKeys('graf_with_a_long_tail_here')).toBe('graf_with_a_long_tail_here');
    expect(hideKeys(`key=af_live_${'A'.repeat(43)}`)).toBe('key=af_live_AA…');
    expect(hideKeys(`/afm_live_${'B'.repeat(43)}`)).toBe('/afm_live_B…');
  });
});

describe('clip', () => {
  it('makes one short line with no control characters', () => {
    expect(clip('a\nb\u001b[31mc\u202ed')).toBe('a b [31mc d');
    expect(clip('x'.repeat(250))).toBe(`${'x'.repeat(200)}…`);
  });
});

describe('retryIn', () => {
  it('reads Retry-After in seconds only', () => {
    expect(retryIn(new HttpError(503, 'x', { retryAfter: '2' }))).toBe('retry in 2 seconds');
    expect(retryIn(new HttpError(503, 'x', { retryAfter: 'Wed, 11 Nov 2026 10:00:00 GMT' }))).toBe('retry in a moment');
  });
});

describe('the tables', () => {
  it('have a line for each code of the proxy, and no Credits key or top-up code', () => {
    expect([...PROXY_CODES].sort()).toEqual(Object.keys(ERROR_LINES).sort());
    for (const code of ['invalid_key', 'insufficient_balance', 'key_budget_exceeded', 'topup_refused', 'idempotency_conflict']) {
      expect(PROXY_CODES.has(code)).toBe(false);
    }
  });
});

describe('httpErrorOf', () => {
  it("reads Anyfare's envelope, the request ID and Retry-After", () => {
    const error = httpErrorOf({
      status: 503,
      headers: new Headers({ 'x-request-id': 'req-made-up-1', 'retry-after': '2' }),
      bytes: new Uint8Array(),
      truncated: false,
      body: { error: { code: 'payment_unavailable', message: 'Made up' } },
      ms: 0,
    });
    expect(error).toMatchObject({ status: 503, code: 'payment_unavailable', message: 'Made up', requestId: 'req-made-up-1', retryAfter: '2' });
    expect(isProxyEnvelope({ error: { code: 'payment_unavailable' } })).toBe(true);
    expect(isProxyEnvelope({ error: { code: 'not_found' } })).toBe(false);
    expect(isProxyEnvelope({ error: 'x' })).toBe(false);
  });
});

describe('stopFor', () => {
  it('gives the line of a code, with the request ID', () => {
    const stop = stopFor(new HttpError(400, 'Made up', { code: 'host_not_allowed', requestId: 'req-made-up-2' }), {});
    expect(stop.line()).toBe("Anyfare doesn't route payments to this API's host (request req-made-up-2).");
  });

  it('says not charged on a paid request only when it is known', () => {
    expect(stopFor(new HttpError(400, 'Made up', { code: 'host_not_allowed' }), paid).line()).toBe(
      "Anyfare doesn't route payments to this API's host. Not charged.",
    );
    expect(stopFor(new HttpError(502, 'Made up', { code: 'settlement_failed' }), paid).line()).toBe(
      `The payment couldn't be settled, so the answer was not sent. Whether the payment was taken is not known: ${CHECK}.`,
    );
  });

  it("reads an API's answer passed through below 500 as not charged, and a 5xx as not known", () => {
    expect(stopFor(new HttpError(404, 'x', { code: 'not_found', body: { error: { code: 'not_found' } } }), paid).line()).toBe(
      'The API answered 404: {"error":{"code":"not_found"}}. Not charged.',
    );
    expect(stopFor(new HttpError(404, 'x', { body: 'Made up' }), { ...paid, bodyShown: true }).line()).toBe('The API answered 404. Not charged.');
    expect(stopFor(new HttpError(500, 'x', { body: 'Made up' }), paid).line()).toBe(
      `Anyfare answered 500: Made up. Whether the payment was taken is not known: ${CHECK}.`,
    );
    expect(stopFor(new HttpError(402, 'x', { body: {} }), paid).line()).toBe('Anyfare asked for a payment again: the payment was not accepted. Not charged.');
  });
});
