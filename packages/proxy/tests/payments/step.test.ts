import { Registry } from '@prometheus-io/client';
import { describe, expect, it } from 'vitest';

import { createLogger, type MicroUsd } from '@anyfare/common';
import type { Payment } from '@anyfare/core';
import type { Authorization, PaymentRail, PaymentRecorder, Quote } from '@anyfare/payments';

import { createProxyMetrics } from '../../src/metrics.js';
import type { ProxyLimits } from '../../src/payments/limits.js';
import { createPaymentStep } from '../../src/payments/step.js';

class LedgerWriteError extends Error {
  readonly code = '40P01';
}

/** A rail that authorizes anything, records the quotes it saw, and whose finalize fails as a ledger write would. */
const failingRail = (settlesBeforeResponse: boolean, quotes: Quote[] = []): PaymentRail => ({
  name: settlesBeforeResponse ? 'x402' : 'credits',
  settlesBeforeResponse,
  detect: headers => headers['authorization'] === undefined
    ? undefined
    : ({ rail: settlesBeforeResponse ? 'x402' : 'credits', key: { kind: 'payment', hash: 'hash-1' } }) as never,
  challenge: async quote => {
    quotes.push(quote);

    return { body: { offered: quote.description } };
  },
  authorize: async (_credential, quote) => {
    quotes.push(quote);

    return { rail: settlesBeforeResponse ? 'x402' : 'credits', paymentId: quote.paymentId, amount: quote.priceMicroUsd, buyer: 'account:acc_1', receipt: undefined } as Authorization;
  },
  finalize: async () => {
    throw new LedgerWriteError('The ledger write failed: deadlock detected');
  },
  abort: async () => undefined,
});

const setup = (rail: PaymentRail, recorder: Pick<PaymentRecorder, 'recordDecision'> = { recordDecision: async () => ({}) as Payment }) => {
  const lines: Record<string, unknown>[] = [];
  const limited: string[] = [];
  const limits: ProxyLimits = {
    unpaid: async ip => {
      limited.push(`unpaid:${ip}`);
    },
    paymentKey: async hash => {
      limited.push(`paymentKey:${hash}`);
    },
    probe: async ip => {
      limited.push(`probe:${ip}`);
    },
  };
  const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const step = createPaymentStep({
    rails: [rail], detectors: [rail.detect], recorder, limits, ids: { next: () => 'id-1' }, logger, metrics: createProxyMetrics(new Registry()),
  });

  return { step, lines, limited };
};

const routed = (headers: Record<string, string> = { authorization: 'Bearer key' }) => ({
  headers, ip: '127.0.0.1', requestId: 'req-1', host: 'api.target.test', path: '/v1/pools',
  resource: 'https://pay.anyfare.test/api.target.test/v1/pools', quote: 1_100n as MicroUsd,
});

const begin = async (step: ReturnType<typeof setup>['step']) => {
  const started = await step.begin(routed());
  if (started.kind !== 'paid')
    throw new Error('Not paid');

  return started.call;
};

describe('the payment step\'s quote', () => {
  it('answers a call without a credential with the combined 402 at the quote, after the unpaid limit', async () => {
    const quotes: Quote[] = [];
    const { step, limited } = setup(failingRail(false, quotes));

    const started = await step.begin(routed({}));

    expect(started).toMatchObject({ kind: 'challenge', response: { status: 402, body: { offered: 'api.target.test/v1/pools, through Anyfare' } } });
    expect(limited).toEqual(['unpaid:127.0.0.1']);
    expect(quotes).toEqual([{
      paymentId: 'pay_id-1', requestId: 'req-1', resource: 'https://pay.anyfare.test/api.target.test/v1/pools', priceMicroUsd: 1_100n,
      description: 'api.target.test/v1/pools, through Anyfare', subject: { targetHost: 'api.target.test', targetPath: '/v1/pools' },
    }]);
  });

  it('never bills an answer that didn\'t reach the buyer, whatever its status', async () => {
    const recorded: unknown[] = [];
    const { step } = setup(failingRail(false), { recordDecision: async input => {
      recorded.push(input);

      return {} as Payment;
    } });
    const call = await begin(step);

    expect(await step.decide(call, { status: 200, latencyMs: 5, delivered: false })).toBe('not_billable');
    expect(recorded).toEqual([{ paymentId: 'pay_id-1', decision: 'not_billable', upstreamStatus: 200, upstreamLatencyMs: 5 }]);
  });

  it('authorizes a payment key\'s call at the quote, after the key\'s limit', async () => {
    const quotes: Quote[] = [];
    const { step, limited } = setup(failingRail(false, quotes));

    const call = await begin(step);

    expect(limited).toEqual(['paymentKey:hash-1']);
    expect(call.authorization).toMatchObject({ paymentId: 'pay_id-1', amount: 1_100n });
    expect(call.trace.subject).toEqual({ host: 'api.target.test', path: '/v1/pools' });
    expect(quotes[0]).toMatchObject({ priceMicroUsd: 1_100n, subject: { targetHost: 'api.target.test', targetPath: '/v1/pools' } });
  });
});

describe('a ledger write that fails', () => {
  it('logs a capture that fails at error, with the call\'s fields, the cause, and finalize_failed', async () => {
    const { step, lines } = setup(failingRail(false));
    const call = await begin(step);

    await step.finish(call, await step.decide(call, { status: 200, latencyMs: 12, upstreamRequestId: 'up-1' }));

    expect(lines.find(line => line['msg'] === 'Failed to finish a payment. The hold expiry worker finishes it.')).toMatchObject({
      level: 50, paymentId: 'pay_id-1', rail: 'credits', host: 'api.target.test', path: '/v1/pools', decision: 'billable', paymentStatus: 'finalize_failed',
      upstreamStatus: 200, upstreamMs: 12, upstreamRequestId: 'up-1', error: { type: 'Error', message: 'The ledger write failed: deadlock detected', code: '40P01' },
    });
  });

  it('logs a settlement whose ledger write fails at error, and rethrows it', async () => {
    const { step, lines } = setup(failingRail(true));
    const call = await begin(step);
    await step.decide(call, { status: 200, latencyMs: 3 });

    await expect(step.settleNow(call)).rejects.toBeInstanceOf(LedgerWriteError);

    expect(lines.find(line => line['msg'] === 'Paid call failed to settle')).toMatchObject({
      level: 50, rail: 'x402', paymentStatus: 'settlement_failed', error: { code: '40P01', stack: expect.stringContaining('step.test.ts') },
    });
  });

  it('logs a billing decision that can\'t be recorded at error, with the payment\'s ID', async () => {
    const { step, lines } = setup(failingRail(false), { recordDecision: async () => {
      throw new LedgerWriteError('The decision write failed');
    } });
    const call = await begin(step);

    expect(await step.decide(call, { status: 200, latencyMs: 1 })).toBe('billable');

    expect(lines.find(line => line['msg'] === 'Failed to record the billing decision')).toMatchObject({ level: 50, paymentId: 'pay_id-1', decision: 'billable', error: { code: '40P01' } });
  });
});
