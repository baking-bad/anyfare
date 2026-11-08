import { fixtureTime } from '@anyfare/testing';

import { Registry } from '@prometheus-io/client';
import { describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import type { UnbookedRoutingLoss } from '@anyfare/db';

import { createRoutingLossMetrics, createRoutingLosses, RoutingLossesFailedError } from '../src/routingLosses.js';

const bookedAt = new Date(fixtureTime(0, 9, 12, 0, 0, 0));

const loss = (paymentId: string, amount: bigint, asset = 'base-usdc'): UnbookedRoutingLoss =>
  ({ paymentId, amount, asset, targetHost: 'api.target.test', buyerStatus: 'failed' });

/** In-memory ports: the unbooked losses, and a ledger that answers each booking as `answer` says. */
const setup = (losses: readonly UnbookedRoutingLoss[], answer: (paymentId: string) => { replayed: boolean } | Error) => {
  const lines: Record<string, unknown>[] = [];
  const registry = new Registry();
  const booked: string[] = [];
  const limits: number[] = [];
  const job = createRoutingLosses({
    routing: {
      listUnbookedLosses: async limit => {
        limits.push(limit);

        return losses.slice(0, limit);
      },
    },
    ledger: {
      routingLoss: async ({ paymentId }) => {
        const result = answer(paymentId);
        if (result instanceof Error)
          throw result;
        booked.push(paymentId);

        return { transactionId: `tx-${paymentId}`, createdAt: bookedAt, replayed: result.replayed };
      },
    },
    metrics: createRoutingLossMetrics(registry),
    logger: createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }),
  });

  return { job, lines, registry, booked, limits };
};

describe('routing losses', () => {
  it('books each loss, counts it in USD by asset, and alerts with a notice', async () => {
    const { job, lines, registry } = setup([loss('pay_1', 1_000n), loss('pay_2', 500_000n), loss('pay_3', 250_000n, 'solana-usdc')], () => ({ replayed: false }));

    expect(await job()).toEqual({ booked: 3, failed: 0 });
    const text = await registry.metrics();
    expect(text).toContain('routing_losses_usd_total{asset="base-usdc"} 0.501');
    expect(text).toContain('routing_losses_usd_total{asset="solana-usdc"} 0.25');
    expect(lines.filter(line => line['notice'] === true).map(line => [line['level'], line['paymentId'], line['amount'], line['host'], line['buyerStatus']]))
      .toEqual([[40, 'pay_1', '0.001', 'api.target.test', 'failed'], [40, 'pay_2', '0.5', 'api.target.test', 'failed'], [40, 'pay_3', '0.25', 'api.target.test', 'failed']]);
  });

  it('counts nothing twice when the ledger already has the loss', async () => {
    const { job, lines, registry } = setup([loss('pay_1', 1_000n)], () => ({ replayed: true }));

    expect(await job()).toEqual({ booked: 0, failed: 0 });
    expect(await registry.metrics()).not.toContain('routing_losses_usd_total{');
    expect(lines.filter(line => line['notice'] === true)).toEqual([]);
  });

  it('books once across runs, as the ledger replays a loss it already booked', async () => {
    const seen = new Set<string>();
    const { job, registry } = setup([loss('pay_1', 2_000n)], paymentId => {
      const replayed = seen.has(paymentId);
      seen.add(paymentId);

      return { replayed };
    });

    expect(await job()).toEqual({ booked: 1, failed: 0 });
    expect(await job()).toEqual({ booked: 0, failed: 0 });
    expect(await registry.metrics()).toContain('routing_losses_usd_total{asset="base-usdc"} 0.002');
  });

  it('reads one page a run', async () => {
    const { job, limits } = setup([], () => ({ replayed: false }));

    expect(await job()).toEqual({ booked: 0, failed: 0 });
    expect(limits).toEqual([100]);
  });

  it('books the rest when one fails, logs the failure, then fails the run so the job shows stale', async () => {
    const { job, booked, lines, registry } = setup([loss('pay_1', 1_000n), loss('pay_2', 1_000n)], paymentId => paymentId === 'pay_1' ? new Error('deadlock') : { replayed: false });

    const error = await job().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RoutingLossesFailedError);
    expect((error as RoutingLossesFailedError).result).toEqual({ booked: 1, failed: 1 });
    expect(booked).toEqual(['pay_2']);
    expect(await registry.metrics()).toContain('routing_losses_usd_total{asset="base-usdc"} 0.001');
    expect(lines.find(line => line['msg'] === 'Failed to book a routing loss')).toMatchObject({ level: 50, paymentId: 'pay_1', error: { message: 'deadlock' } });
  });
});
