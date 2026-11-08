import { afterEach, describe, expect, it } from 'vitest';

import { facilitatorAnswers, startFakeFacilitator, type FakeFacilitator } from '../src/index.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const feePayer = '11111111111111111111111111111112';

let facilitator: FakeFacilitator | undefined;

afterEach(async () => {
  await facilitator?.close();
  facilitator = undefined;
});

const call = async (path: string, body?: unknown) => {
  const response = await fetch(`${facilitator!.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, body: await response.json() as unknown };
};

const payment = (network: string, from?: string) => ({
  x402Version: 2,
  paymentPayload: { x402Version: 2, payload: from === undefined ? { transaction: 'AQ==' } : { authorization: { from } } },
  paymentRequirements: { scheme: 'exact', network },
});

describe('the fake facilitator', () => {
  it('answers /supported with exact on each network, and the fee payer and the transaction versions on Solana', async () => {
    facilitator = await startFakeFacilitator({ networks: [base, solana], feePayer });

    expect(await call('/supported')).toEqual({
      status: 200,
      body: {
        kinds: [
          { x402Version: 2, scheme: 'exact', network: base },
          { x402Version: 2, scheme: 'exact', network: solana, extra: { feePayer, transactionVersions: [0, 1] } },
        ],
        extensions: [],
        signers: {},
      },
    });
  });

  it('advertises the transaction versions it is given, with or without a fee payer', async () => {
    facilitator = await startFakeFacilitator({ networks: [solana], transactionVersions: [0] });

    expect((await call('/supported')).body).toMatchObject({ kinds: [{ network: solana, extra: { transactionVersions: [0] } }] });
  });

  it('verifies and settles every payment by default, naming the payer and a transaction of the network', async () => {
    facilitator = await startFakeFacilitator({ networks: [base, solana] });
    const from = '0x2222222222222222222222222222222222222222';

    expect(await call('/verify', payment(base, from))).toEqual({ status: 200, body: { isValid: true, payer: from } });
    expect(await call('/settle', payment(base, from))).toEqual({
      status: 200, body: { success: true, transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/), network: base, payer: from },
    });
    expect(await call('/settle', payment(solana))).toEqual({
      status: 200, body: { success: true, transaction: expect.stringMatching(/^[0-9a-f]{64}$/), network: solana, payer: 'solana-payer' },
    });
  });

  it('records every request in order, with its method, path, headers, and parsed body', async () => {
    facilitator = await startFakeFacilitator({ networks: [base] });

    await call('/supported?probe=1');
    await call('/verify', payment(base, '0x2222222222222222222222222222222222222222'));

    expect(facilitator.requests).toEqual([
      expect.objectContaining({ method: 'GET', path: '/supported', body: undefined }),
      expect.objectContaining({ method: 'POST', path: '/verify', body: payment(base, '0x2222222222222222222222222222222222222222') }),
    ]);
    expect(facilitator.requests[1]?.headers.authorization).toBe('Bearer token');
  });

  it('answers a path as scripted until reset, and 404 for a path it doesn\'t know', async () => {
    facilitator = await startFakeFacilitator({ networks: [base] });
    facilitator.handle('/verify', facilitatorAnswers.invalid('insufficient_funds'));
    facilitator.handle('/settle', facilitatorAnswers.pending('0xbroadcast'));

    expect(await call('/verify', payment(base))).toEqual({ status: 200, body: { isValid: false, invalidReason: 'insufficient_funds' } });
    expect(await call('/settle', payment(base))).toMatchObject({ body: { success: false, errorReason: 'settlement_pending', transaction: '0xbroadcast', network: base } });
    facilitator.handle('/supported', facilitatorAnswers.unavailable);
    expect(await call('/supported')).toEqual({ status: 503, body: { error: 'unavailable' } });

    facilitator.reset();

    expect(await call('/verify', payment(base))).toMatchObject({ body: { isValid: true } });
    expect((await call('/supported')).status).toBe(200);
    expect(await call('/nothing')).toEqual({ status: 404, body: { error: 'not found' } });
  });

  it('holds a delayed answer back', async () => {
    facilitator = await startFakeFacilitator({ networks: [base] });
    facilitator.handle('/settle', facilitatorAnswers.timeout(200));
    const started = performance.now();

    const answer = await fetch(`${facilitator.url}/settle`, { method: 'POST', body: '{}' });

    expect(answer.status).toBe(503);
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
  });
});
