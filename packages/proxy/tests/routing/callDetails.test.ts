import { describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import type { NewCallDetails } from '@anyfare/db';

import { createCallDetailsRecorder, maxPendingDetails, payerOf } from '../../src/routing/callDetails.js';

const arrivedAt = new Date('2026-11-12T10:00:00.000Z');

const capture = () => {
  const lines: Record<string, unknown>[] = [];

  return { lines, log: createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }) };
};

describe('payerOf', () => {
  it('takes the payer of a payment on a chain, never an account', () => {
    expect(payerOf({ rail: 'x402', buyer: 'address:eip155:8453:0x7777777777777777777777777777777777777777' })).toBe('0x7777777777777777777777777777777777777777');
    expect(payerOf({ rail: 'x402', buyer: 'address:near:mainnet:scout.example.near' })).toBe('scout.example.near');
    expect(payerOf({ rail: 'mpp', buyer: 'address:eip155:4217:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' })).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(payerOf({ rail: 'credits', buyer: 'account:acc_1' })).toBeUndefined();
    // Never from Credits, whatever the rail says
    expect(payerOf({ rail: 'credits', buyer: 'address:eip155:8453:0x7777777777777777777777777777777777777777' })).toBeUndefined();
    expect(payerOf({ rail: 'x402', buyer: 'account:acc_1' })).toBeUndefined();
    expect(payerOf({ rail: 'x402', buyer: 'address:eip155:8453:unknown' })).toBeUndefined();
    expect(payerOf({ rail: 'x402', buyer: 'address:eip155:8453:<script>' })).toBeUndefined();
    expect(payerOf({ rail: 'x402', buyer: `address:eip155:8453:${'a'.repeat(129)}` })).toBeUndefined();
  });
});

describe('the call details recorder', () => {
  it('writes the method, the payer and the arrival, and never waits for the write', async () => {
    const written: NewCallDetails[] = [];
    let finish: (() => void) | undefined;
    const recorder = createCallDetailsRecorder({
      store: {
        recordDetails: details => new Promise<void>(resolve => {
          written.push(details);
          finish = resolve;
        }),
      },
    });
    const { log } = capture();

    const returned = recorder.record({ authorization: { paymentId: 'pay_1', rail: 'x402', buyer: 'address:eip155:8453:0xabc' }, method: 'POST', arrivedAt, log });

    expect(returned).toBeUndefined();
    expect(written).toEqual([{ paymentId: 'pay_1', method: 'POST', payer: '0xabc', arrivedAt }]);
    let drained = false;
    const draining = recorder.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish!();
    await draining;
    expect(drained).toBe(true);
  });

  it('logs one warn line when a write fails or throws, and never throws itself', async () => {
    const { lines, log } = capture();
    const failing = createCallDetailsRecorder({ store: { recordDetails: async () => { throw new Error('The database is down'); } } });
    const throwing = createCallDetailsRecorder({ store: { recordDetails: () => { throw new Error('No connection'); } } });
    const authorization = { paymentId: 'pay_2', rail: 'credits' as const, buyer: 'account:acc_2' };

    expect(() => failing.record({ authorization, method: 'GET', arrivedAt, log })).not.toThrow();
    expect(() => throwing.record({ authorization, method: 'GET', arrivedAt, log })).not.toThrow();
    await failing.drain();

    expect(lines.map(line => [line['level'], line['msg'], line['paymentId']])).toEqual([
      [40, 'A call\'s details couldn\'t be kept. The call goes on.', 'pay_2'],
      [40, 'A call\'s details couldn\'t be kept. The call goes on.', 'pay_2'],
    ]);
    expect(JSON.stringify(lines)).not.toContain('acc_2');
  });

  it('drops a call\'s details while too many writes are in flight', async () => {
    const { lines, log } = capture();
    const waiting: (() => void)[] = [];
    const recorder = createCallDetailsRecorder({ store: { recordDetails: () => new Promise<void>(resolve => waiting.push(resolve)) } });
    const authorization = { paymentId: 'pay_3', rail: 'x402' as const, buyer: 'address:eip155:8453:0xabc' };

    for (let index = 0; index <= maxPendingDetails; index += 1)
      recorder.record({ authorization, method: 'GET', arrivedAt, log });

    expect(waiting).toHaveLength(maxPendingDetails);
    expect(lines.map(line => line['msg'])).toEqual(['A call\'s details were not kept: too many writes are in flight. The call goes on.']);
    waiting.forEach(resolve => resolve());
    await recorder.drain();
  });
});
