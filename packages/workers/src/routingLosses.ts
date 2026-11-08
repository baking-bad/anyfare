import { Counter, type Registry } from '@prometheus-io/client';

import { formatUsd, type Logger } from '@anyfare/common';
import type { Ledger, RoutingRepository } from '@anyfare/db';

// One runner across replicas
export const routingLossesLockId = 7_301_746_210;
export const routingLossesJobName = 'routing_losses';
export const routingLossesIntervalMs = 60_000;
const defaultBatchSize = 100;

export interface RoutingLossMetrics {
  readonly losses: Counter<'asset'>;
}

export const createRoutingLossMetrics = (registry: Registry): RoutingLossMetrics => ({
  losses: new Counter({
    name: 'routing_losses_usd_total',
    help: 'What routed targets kept while their buyers paid nothing, in USD, as booked',
    labelNames: ['asset'] as const,
    registers: [registry],
  }),
});

export interface RoutingLossesOptions {
  readonly routing: Pick<RoutingRepository, 'listUnbookedLosses'>;
  readonly ledger: Pick<Ledger, 'routingLoss'>;
  readonly metrics: RoutingLossMetrics;
  readonly logger: Logger;
  readonly batchSize?: number;
}

export interface RoutingLossesResult {
  readonly booked: number;
  readonly failed: number;
}

/** Some losses couldn't be booked. They are retried on the next run, and the job stays stale. */
export class RoutingLossesFailedError extends Error {
  constructor(readonly result: RoutingLossesResult) {
    super(`${result.failed} routing losses couldn't be booked`);
  }
}

/**
 * Routing losses: books every routed call whose target kept our payment while the buyer paid
 * nothing, and alerts on each. Mostly an x402 or MPP buyer whose settlement failed after the Signer
 * paid the target, whether the proxy saw it fail or the settlement follow-up did later, or a credits
 * hold released after the target was paid. The Signer's limits cap that risk. A loss is booked once
 * per payment, so a rerun books nothing twice.
 */
export const createRoutingLosses = ({
  routing, ledger, metrics, logger, batchSize = defaultBatchSize,
}: RoutingLossesOptions) => async (): Promise<RoutingLossesResult> => {
  let booked = 0;
  let failed = 0;
  // One page a run: a loss that fails to book stays first, and the next run tries it again
  for (const loss of await routing.listUnbookedLosses(batchSize)) {
    try {
      const { replayed } = await ledger.routingLoss({ paymentId: loss.paymentId });
      if (replayed)
        continue;
      booked += 1;
      metrics.losses.inc({ asset: loss.asset }, Number(loss.amount) / 1_000_000);
      logger.warn({
        paymentId: loss.paymentId, host: loss.targetHost, asset: loss.asset, amount: formatUsd(loss.amount), buyerStatus: loss.buyerStatus, notice: true,
      }, 'A routed target kept our payment while its buyer paid nothing: booked as a routing loss');
    }
    catch (error) {
      failed += 1;
      logger.error({ error, paymentId: loss.paymentId }, 'Failed to book a routing loss');
    }
  }
  const result = { booked, failed };
  if (failed > 0)
    throw new RoutingLossesFailedError(result);

  return result;
};
