import { Gauge, type Registry } from '@prometheus-io/client';

import { formatUsd, type Clock, type IdGenerator, type Logger, type MicroUsd } from '@anyfare/common';
import { atomicToUsd, reconcile, type Asset, type BalanceReader, type PlatformConfig, type TreasuryWallet } from '@anyfare/core';
import { ledgerAccountIds, type Ledger, type TreasuryRepository } from '@anyfare/db';

// One runner across replicas
export const treasuryBalancesLockId = 7_301_746_206;
export const reconciliationLockId = 7_301_746_207;
// The balances every few minutes, the reconciliation daily
export const treasuryBalancesIntervalMs = 5 * 60_000;
export const reconciliationIntervalMs = 24 * 60 * 60_000;
export const treasuryBalancesJobName = 'treasury_balances';
export const reconciliationJobName = 'reconciliation';

export interface TreasuryMetrics {
  readonly balance: Gauge<'wallet' | 'asset'>;
  readonly drift: Gauge<'asset'>;
}

export const createTreasuryMetrics = (registry: Registry): TreasuryMetrics => ({
  balance: new Gauge({
    name: 'treasury_balance_usd',
    help: 'What each platform wallet holds of each asset, in USD',
    labelNames: ['wallet', 'asset'] as const,
    registers: [registry],
  }),
  drift: new Gauge({
    name: 'treasury_drift_usd',
    help: 'On-chain holdings minus what the ledger says, per asset, at the last reconciliation',
    labelNames: ['asset'] as const,
    registers: [registry],
  }),
});

type ReaderFor = (asset: Asset) => BalanceReader | undefined;

/** A wallet's holdings per asset, in micro-USD. An asset without a reader, or that failed, is left out. */
const holdingsOf = async (wallet: TreasuryWallet, readerFor: ReaderFor, logger: Logger): Promise<{ readonly held: Map<string, MicroUsd>; readonly failed: number }> => {
  const held = new Map<string, MicroUsd>();
  let failed = 0;
  for (const asset of wallet.assets) {
    const reader = readerFor(asset);
    if (!reader)
      continue;
    for (const address of wallet.addresses) {
      try {
        const quantity = await reader.balance({ address, asset });
        held.set(asset.name, (held.get(asset.name) ?? 0n) + atomicToUsd(quantity, asset.decimals));
      }
      catch (error) {
        failed += 1;
        // An RPC's error is reduced to its short message: never the RPC's URL or request
        logger.error({ error, wallet: wallet.name, asset: asset.name, network: asset.network.id }, 'Failed to read a treasury balance');
      }
    }
  }

  return { held, failed };
};

/**
 * Warns about each empty `payTo` that has no token account for its asset (Solana): x402's `exact`
 * payment there only transfers, so buyers' payments fail until the account exists. Returns how many
 * checks failed.
 */
const warnWithoutTokenAccounts = async (wallet: TreasuryWallet, held: ReadonlyMap<string, MicroUsd>, readerFor: ReaderFor, logger: Logger): Promise<number> => {
  let failed = 0;
  for (const asset of wallet.assets) {
    const reader = readerFor(asset);
    // Only an empty balance can lack the account: a read that failed has no entry
    if (!reader?.hasTokenAccount || held.get(asset.name) !== 0n)
      continue;
    for (const address of wallet.addresses) {
      try {
        if (!await reader.hasTokenAccount({ address, asset }))
          logger.warn({ wallet: wallet.name, asset: asset.name, network: asset.network.id, address, alert: true }, 'A payTo has no token account for its asset: payments to it fail until it has one');
      }
      catch (error) {
        failed += 1;
        logger.error({ error, wallet: wallet.name, asset: asset.name, network: asset.network.id }, 'Failed to read a treasury balance');
      }
    }
  }

  return failed;
};

export interface TreasuryBalancesOptions {
  readonly wallets: () => Promise<readonly TreasuryWallet[]>;
  readonly readerFor: ReaderFor;
  // signer.maxPerNetworkPerDay: a hot wallet below it may run dry within a day
  readonly signerDailyLimit: MicroUsd;
  readonly metrics: TreasuryMetrics;
  readonly logger: Logger;
}

/**
 * The balance monitor: each wallet's holdings as a metric. Warns when a Signer wallet holds less than
 * a day's spend limit, and when a Solana `payTo` has no token account. A balance that can't be read
 * fails the run, so the job goes stale.
 */
export const createTreasuryBalancesJob = ({ wallets, readerFor, signerDailyLimit, metrics, logger }: TreasuryBalancesOptions) =>
  async (): Promise<{ readonly wallets: number; readonly balances: number }> => {
    let failed = 0;
    let read = 0;
    const watched = await wallets();
    for (const wallet of watched) {
      const result = await holdingsOf(wallet, readerFor, logger);
      failed += result.failed;
      read += result.held.size;
      for (const [asset, amount] of result.held)
        metrics.balance.set({ wallet: wallet.name, asset }, Number(formatUsd(amount)));
      if (wallet.role === 'pay_to')
        failed += await warnWithoutTokenAccounts(wallet, result.held, readerFor, logger);

      // A hot wallet that read fine, but holds less than a day of routed payments
      if (wallet.role === 'signer' && result.held.size > 0) {
        const held = [...result.held.values()].reduce((sum, amount) => sum + amount, 0n);
        if (held < signerDailyLimit)
          logger.warn({ wallet: wallet.name, held: formatUsd(held), dailyLimit: formatUsd(signerDailyLimit), alert: true }, 'A Signer wallet holds less than a day\'s spend limit: top it up');
      }
    }
    if (failed > 0)
      throw new Error(`${failed} treasury balances couldn't be read`);

    return { wallets: watched.length, balances: read };
  };

export interface ReconciliationOptions {
  readonly config: Pick<PlatformConfig, 'assets'>;
  readonly wallets: () => Promise<readonly TreasuryWallet[]>;
  readonly readerFor: ReaderFor;
  readonly ledger: Pick<Ledger, 'balancesOf'>;
  readonly treasury: Pick<TreasuryRepository, 'recordReconciliationRun'>;
  readonly metrics: TreasuryMetrics;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/**
 * The wallets with each address counted once per asset, as the chain holds it: a Signer wallet may
 * share its address with a `payTo` on the same network.
 */
const distinctHoldings = (wallets: readonly TreasuryWallet[]): readonly TreasuryWallet[] => {
  const seen = new Set<string>();

  return wallets.flatMap(wallet => wallet.assets.flatMap(asset => wallet.addresses.flatMap(address => {
    const key = `${asset.name} ${asset.network.namespace === 'eip155' ? address.toLowerCase() : address}`;
    if (seen.has(key))
      return [];
    seen.add(key);

    return [{ ...wallet, assets: [asset], addresses: [address] }];
  })));
};

/**
 * Reconciliation: per asset, the ledger's view of what the platform holds against the chain's, every
 * wallet counted: the `payTo` wallets that buyers pay, and the Signer's hot wallets that pay targets.
 * The ledger books each target payment out of the treasury of its asset, and the operator's funding of
 * a hot wallet as a treasury transfer, so both sides move together. Each run is recorded. A drift
 * above the threshold alerts. A balance that can't be read fails the run, and nothing is recorded.
 */
export const createReconciliationJob = ({ config, wallets, readerFor, ledger, treasury, metrics, clock, ids, logger }: ReconciliationOptions) =>
  async (): Promise<{ readonly assets: number; readonly alerts: number }> => {
    const chain = new Map<string, MicroUsd>();
    let failed = 0;
    for (const wallet of distinctHoldings(await wallets())) {
      const result = await holdingsOf(wallet, readerFor, logger);
      failed += result.failed;
      for (const [asset, amount] of result.held)
        chain.set(asset, (chain.get(asset) ?? 0n) + amount);
    }
    if (failed > 0)
      throw new Error(`${failed} treasury balances couldn't be read: no reconciliation without them`);

    const readable = config.assets.filter(asset => readerFor(asset) !== undefined);
    const ledgerBalances = await ledger.balancesOf(readable.map(asset => ledgerAccountIds.treasury(asset.name)));
    const results = reconcile({ assets: readable, ledgerBalances, chainBalances: chain });
    let alerts = 0;
    for (const [asset, entry] of results) {
      metrics.drift.set({ asset }, Number(formatUsd(entry.drift)));
      if (entry.alert) {
        alerts += 1;
        logger.error({ asset, ledger: formatUsd(entry.ledger), chain: formatUsd(entry.chain), drift: formatUsd(entry.drift), alert: true }, 'Treasury drift: the chain and the ledger disagree');
      }
    }
    await treasury.recordReconciliationRun({
      id: `rec_${ids.next()}`,
      ranAt: clock.now(),
      results: Object.fromEntries([...results].map(([asset, entry]) => [asset, {
        ledger: formatUsd(entry.ledger), chain: formatUsd(entry.chain), drift: formatUsd(entry.drift), alert: entry.alert,
      }])),
      alerts,
    });

    return { assets: results.size, alerts };
  };
