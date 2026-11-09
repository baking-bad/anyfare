import {
  createMetricsServer, randomIdGenerator, systemClock, systemTimers, type Clock, type IdGenerator, type Logger, type MetricsServer, type Timers,
} from '@anyfare/common';
import { treasuryWallets, type BalanceReader, type PlatformConfig } from '@anyfare/core';
import { createLedger, createPaymentRepository, createRoutingRepository, createTopupRepository, createTreasuryRepository, type Postgres } from '@anyfare/db';
import { createFacilitatorLookup, type Facilitator, type MppSettlementCheck } from '@anyfare/payments';
import type { OneClickClient } from '@anyfare/topups';

import { createHoldExpiry, holdExpiryIntervalMs, holdExpiryJobName, holdExpiryLockId, holdTtlMs } from './holdExpiry.js';
import { createRoutingLossMetrics, createRoutingLosses, routingLossesIntervalMs, routingLossesJobName, routingLossesLockId } from './routingLosses.js';
import { createScheduler, type Job, type JobOutcome, type Scheduler } from './scheduler.js';
import { createSettlementFollowUp, settlementFollowUpIntervalMs, settlementFollowUpJobName, settlementFollowUpLockId } from './settlementFollowUp.js';
import { createTopupStatus, createTopupStatusMetrics, pollsTopups, topupStatusIntervalMs, topupStatusJobName, topupStatusLockId } from './topupStatus.js';
import {
  createReconciliationJob, createTreasuryBalancesJob, createTreasuryMetrics, reconciliationIntervalMs, reconciliationJobName, reconciliationLockId,
  treasuryBalancesIntervalMs, treasuryBalancesJobName, treasuryBalancesLockId,
} from './treasury/jobs.js';
import { readerFor } from './treasury/readers.js';

export interface WorkersDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  // Job time. Default: the system clock.
  readonly clock?: Clock;
  // Job schedules. Default: Node's timers.
  readonly timers?: Timers;
  // Ledger and reconciliation IDs. Default: random UUIDs.
  readonly ids?: IdGenerator;
  // The enabled facilitators, for the settlement follow-up. Default: none, so x402 payments wait.
  readonly facilitators?: readonly Facilitator[];
  // Reads MPP transactions' receipts on the Tempo node, for the settlement follow-up. Default: none, so MPP payments wait.
  readonly mppCheck?: MppSettlementCheck;
  // The NEAR network's final height, for the settlement follow-up. Default: none, so no NEAR refusal is final.
  readonly nearHeight?: () => Promise<bigint>;
  // Balance readers per chain. The treasury jobs run only with one.
  readonly balanceReaders?: { readonly evm?: BalanceReader; readonly solana?: BalanceReader; readonly near?: BalanceReader };
  // The 1Click API of NEAR Intents, which the top-up status job polls. The job runs only with it, while
  // the top-ups section names a recipient and an asset, on or off.
  readonly oneClick?: OneClickClient;
}

export interface WorkersServer extends MetricsServer {
  readonly scheduler: Scheduler;
  // The jobs this replica runs, for its startup line
  readonly jobs: readonly string[];
}

/** The facilitator for each network, from platform config, among the clients given. A network whose facilitator has no client has none. */
const facilitatorLookup = (config: PlatformConfig, facilitators: readonly Facilitator[]): ((network: string) => Facilitator | undefined) => {
  const names = new Set(facilitators.map(facilitator => facilitator.name));

  return createFacilitatorLookup({ ...config, facilitators: config.facilitators.filter(facilitator => names.has(facilitator.name)) }, facilitators);
};

// A run's counts, for its log line: it did something when any of `acted` is above 0
const outcomeOf = <TCounts extends { readonly [Name in keyof TCounts]: number }>(counts: TCounts, acted: readonly (keyof TCounts & string)[]): JobOutcome => {
  const values: Readonly<Record<string, number>> = counts;

  return { counts: { ...values }, acted: acted.some(name => (values[name] ?? 0) > 0) };
};

/**
 * Workers have no public listener. Health, readiness (Postgres), and metrics share the metrics port.
 * Jobs start with the listener and stop before it closes: hold expiry, the settlement follow-up, routing
 * losses, with the top-ups section configured and a 1Click client, the top-up status job, and with a
 * balance reader, the treasury's balance monitor and the daily reconciliation.
 */
export const createApp = ({
  config,
  logger,
  postgres,
  clock = systemClock,
  timers = systemTimers,
  ids = randomIdGenerator,
  facilitators = [],
  mppCheck,
  nearHeight,
  balanceReaders,
  oneClick,
}: WorkersDependencies): WorkersServer => {
  const server = createMetricsServer({
    logger,
    health: true,
    readinessChecks: [{ name: 'postgres', check: () => postgres.ping() }],
  });
  const payments = createPaymentRepository({ db: postgres.db, clock });
  const ledger = createLedger({ db: postgres.db, clock, ids });
  const holdExpiry = createHoldExpiry({ payments, ledger, clock, ttlMs: holdTtlMs(config), logger });
  const settlementFollowUp = createSettlementFollowUp({
    payments,
    ledger,
    // Through the facilitators given: those that passed their startup check, by name
    facilitatorFor: facilitatorLookup(config, facilitators),
    ...mppCheck ? { mppCheck } : {},
    ...nearHeight ? { nearHeight } : {},
    clock,
    settleMs: config.timeouts.settleMs,
    logger,
  });
  const routingLosses = createRoutingLosses({
    routing: createRoutingRepository({ db: postgres.db, clock }), ledger, metrics: createRoutingLossMetrics(server.registry), logger,
  });

  // Each run returns its counts; `acted` names those that make its line info
  const jobs: Job[] = [{
    name: holdExpiryJobName,
    lockId: holdExpiryLockId,
    intervalMs: holdExpiryIntervalMs,
    run: async () => outcomeOf(await holdExpiry(), ['captured', 'released']),
  }, {
    name: settlementFollowUpJobName,
    lockId: settlementFollowUpLockId,
    intervalMs: settlementFollowUpIntervalMs,
    // Pending ones wait for the next run: polling them isn't news
    run: async () => outcomeOf(await settlementFollowUp(), ['settled', 'failed']),
  }, {
    name: routingLossesJobName,
    lockId: routingLossesLockId,
    intervalMs: routingLossesIntervalMs,
    run: async () => outcomeOf(await routingLosses(), ['booked']),
  }];

  // Whether or not top-ups are on: open ones are still credited after new ones are switched off
  if (pollsTopups(config) && oneClick) {
    const topupStatus = createTopupStatus({
      topups: createTopupRepository({ db: postgres.db, clock }),
      ledger: db => createLedger({ db, clock, ids }),
      oneClick,
      config,
      metrics: createTopupStatusMetrics(server.registry),
      clock,
      logger,
    });
    jobs.push({
      name: topupStatusJobName,
      lockId: topupStatusLockId,
      intervalMs: topupStatusIntervalMs,
      // Polls that changed nothing, and swaps still under way, aren't news
      run: async () => outcomeOf(await topupStatus(), ['credited', 'refunded', 'failed', 'review', 'stuck']),
    });
  }

  if (balanceReaders?.evm || balanceReaders?.solana || balanceReaders?.near) {
    const pickReader = readerFor(balanceReaders);
    const wallets = async () => treasuryWallets(config);
    const metrics = createTreasuryMetrics(server.registry);
    const balances = createTreasuryBalancesJob({ wallets, readerFor: pickReader, signerDailyLimit: config.signer.maxPerNetworkPerDay, metrics, logger });
    const treasury = createTreasuryRepository({ db: postgres.db });
    const reconciliation = createReconciliationJob({ config, wallets, readerFor: pickReader, ledger, treasury, metrics, clock, ids, logger });
    jobs.push({
      name: treasuryBalancesJobName,
      lockId: treasuryBalancesLockId,
      intervalMs: treasuryBalancesIntervalMs,
      // Every few minutes: debug
      run: async () => outcomeOf(await balances(), []),
    }, {
      name: reconciliationJobName,
      lockId: reconciliationLockId,
      intervalMs: reconciliationIntervalMs,
      // Daily: always news
      run: async () => outcomeOf(await reconciliation(), ['assets']),
      // A day after the last run, or now: the replicas may restart more often than daily
      firstRunDelayMs: async () => {
        const latest = await treasury.latestReconciliationRun();

        return latest ? latest.ranAt.getTime() + reconciliationIntervalMs - clock.now().getTime() : 0;
      },
    });
  }

  const scheduler = createScheduler({ jobs, locks: postgres, clock, timers, logger, registry: server.registry });

  return {
    ...server,
    scheduler,
    jobs: jobs.map(job => job.name),
    listen: async options => {
      const port = await server.listen(options);
      await scheduler.start();

      return port;
    },
    close: async () => {
      await scheduler.stop();
      await server.close();
    },
  };
};
