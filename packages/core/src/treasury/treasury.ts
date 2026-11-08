import type { MicroUsd } from '@anyfare/common';

import type { Asset, PlatformConfig } from '../platform/config.js';

/** A platform wallet and the assets it holds. */
export interface TreasuryWallet {
  // Such as `payTo:base-usdc` or `signer:tempo`
  readonly name: string;
  // `signer`: a hot wallet that pays routed targets. The balance monitor watches it; reconciliation doesn't count it.
  readonly role: 'pay_to' | 'signer';
  readonly addresses: readonly string[];
  readonly assets: readonly Asset[];
}

/** Port: reads what an address holds of an asset, in its atomic units. One per chain. */
export interface BalanceReader {
  balance(input: { readonly address: string; readonly asset: Asset }): Promise<bigint>;
  /**
   * Solana only: whether the address has a token account for the asset. x402's `exact` payment on
   * Solana only transfers, so a `payTo` without one can't be paid. Absent on chains without token accounts.
   */
  hasTokenAccount?(input: { readonly address: string; readonly asset: Asset }): Promise<boolean>;
}

/**
 * Every platform wallet, from platform config: each asset's `payTo` (which is the MPP recipient for
 * Tempo assets), and the Signer's hot wallets from `signer.wallets`, each with the registry's assets
 * on its chain: Base's, `mpp.network`'s for Tempo, and Solana's. An asset without a `payTo` has no
 * receiving wallet. Keys stay offline for receiving addresses.
 */
export const treasuryWallets = (config: PlatformConfig): readonly TreasuryWallet[] => {
  const payTo = new Map<string, { addresses: string[]; assets: Asset[] }>();
  for (const asset of config.assets) {
    if (asset.payTo === undefined)
      continue;
    const key = `${asset.network.id}:${asset.payTo}`;
    const wallet = payTo.get(key) ?? { addresses: [asset.payTo], assets: [] };
    wallet.assets.push(asset);
    payTo.set(key, wallet);
  }
  const { base, tempo, solana } = config.signer.wallets;
  const signerWallets = [
    { chain: 'base', address: base, assets: config.assets.filter(asset => asset.network.chain === 'base') },
    { chain: 'tempo', address: tempo, assets: config.assets.filter(asset => asset.network.id === config.mpp.network.id) },
    { chain: 'solana', address: solana, assets: config.assets.filter(asset => asset.network.chain === 'solana') },
  ].filter(wallet => wallet.address !== undefined && wallet.assets.length > 0);

  return [
    ...[...payTo.values()].map(wallet => ({ name: `payTo:${wallet.assets.map(asset => asset.name).join('+')}`, role: 'pay_to' as const, ...wallet })),
    ...signerWallets.map(wallet => ({ name: `signer:${wallet.chain}`, role: 'signer' as const, addresses: [wallet.address!], assets: wallet.assets })),
  ];
};

/** An atomic amount of a pegged asset in micro-USD, rounded down. */
export const atomicToUsd = (quantity: bigint, decimals: number): MicroUsd =>
  (decimals >= 6 ? quantity / 10n ** BigInt(decimals - 6) : quantity * 10n ** BigInt(6 - decimals)) as MicroUsd;

export interface ReconciliationEntry {
  // What the ledger says the chain holds: minus the treasury's balance
  readonly ledger: MicroUsd;
  readonly chain: MicroUsd;
  // chain - ledger
  readonly drift: MicroUsd;
  readonly alert: boolean;
}

// A drift above $1 alerts: fees and rounding stay well below it
export const reconciliationThreshold = 1_000_000n as MicroUsd;

/**
 * Compares, per asset, what the ledger says the platform holds with what its wallets hold on chain.
 * Money enters the ledger through the treasury, so its balance is minus what came in. Credits
 * granted through the internal API never touch a chain, so they aren't counted.
 */
export const reconcile = ({ assets, ledgerBalances, chainBalances, threshold = reconciliationThreshold }: {
  readonly assets: readonly Asset[];
  // By ledger account ID: platform:treasury:<asset>
  readonly ledgerBalances: ReadonlyMap<string, bigint>;
  // By asset name, in micro-USD
  readonly chainBalances: ReadonlyMap<string, MicroUsd>;
  readonly threshold?: MicroUsd;
}): ReadonlyMap<string, ReconciliationEntry> => new Map(assets.map(asset => {
  const treasury = ledgerBalances.get(`platform:treasury:${asset.name}`) ?? 0n;
  const ledger = -treasury as MicroUsd;
  const chain = chainBalances.get(asset.name) ?? 0n as MicroUsd;
  const drift = (chain - ledger) as MicroUsd;

  return [asset.name, { ledger, chain, drift, alert: drift > threshold || drift < -threshold }] as const;
}));
