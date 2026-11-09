import type { MicroUsd } from '@anyfare/common';

import type { Asset, PlatformConfig } from '../platform/config.js';

/** A platform wallet and the assets it holds. */
export interface TreasuryWallet {
  // Such as `payTo:base-usdc`, `signer:tempo` or `treasury:near`
  readonly name: string;
  // `pay_to`: an account buyers pay. `signer`: a hot wallet that pays routed targets. The balance monitor
  // alerts when it runs low, and reconciliation counts it: the ledger books its funding as treasury
  // transfers, and its payments to targets. `treasury`: the NEAR account top-ups deliver to. Reconciliation
  // counts it, since the ledger books each top-up into the treasury of its asset, and it never runs low:
  // nothing pays out of it.
  readonly role: 'pay_to' | 'signer' | 'treasury';
  // A `payTo` that is the Signer's hot wallet too, such as `signer:near`: its balance is in this row
  // only, so it's counted once. Absent on every other row.
  readonly signer?: string;
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
 * Tempo assets), the Signer's hot wallets from `signer.wallets`, each with the registry's assets on its
 * chain: Base's, `mpp.network`'s for Tempo, Solana's, and NEAR's, and the account top-ups deliver to,
 * `topups.recipient` with `topups.asset`, whether or not top-ups are on. An asset without a `payTo` has
 * no receiving wallet. Keys stay offline for receiving addresses.
 *
 * On NEAR the hot wallet is the account buyers pay: a NEAR asset whose `payTo` is `signer.wallets.near`
 * stays in its `payTo` row, noted as `signer:near`, and the `signer:near` row keeps only the NEAR
 * assets paid to another account, or none, so no balance is listed twice. For the same reason the
 * top-up recipient has no row of its own when a `payTo` or the Signer's NEAR row already lists its
 * account with the asset.
 */
export const treasuryWallets = (config: PlatformConfig): readonly TreasuryWallet[] => {
  const { base, tempo, solana, near } = config.signer.wallets;
  // A NEAR asset received by the Signer's own NEAR account
  const nearSigner = (asset: Asset): boolean => near !== undefined && asset.network.chain === 'near' && asset.payTo === near;
  const payTo = new Map<string, { addresses: string[]; assets: Asset[]; signer?: string }>();
  for (const asset of config.assets) {
    if (asset.payTo === undefined)
      continue;
    const key = `${asset.network.id}:${asset.payTo}`;
    const wallet = payTo.get(key) ?? { addresses: [asset.payTo], assets: [], ...nearSigner(asset) ? { signer: 'signer:near' } : {} };
    wallet.assets.push(asset);
    payTo.set(key, wallet);
  }
  const signerWallets = [
    { chain: 'base', address: base, assets: config.assets.filter(asset => asset.network.chain === 'base') },
    { chain: 'tempo', address: tempo, assets: config.assets.filter(asset => asset.network.id === config.mpp.network.id) },
    { chain: 'solana', address: solana, assets: config.assets.filter(asset => asset.network.chain === 'solana') },
    { chain: 'near', address: near, assets: config.assets.filter(asset => asset.network.chain === 'near' && !nearSigner(asset)) },
  ].filter(wallet => wallet.address !== undefined && wallet.assets.length > 0);

  const wallets: TreasuryWallet[] = [
    ...[...payTo.values()].map(wallet => ({ name: `payTo:${wallet.assets.map(asset => asset.name).join('+')}`, role: 'pay_to' as const, ...wallet })),
    ...signerWallets.map(wallet => ({ name: `signer:${wallet.chain}`, role: 'signer' as const, addresses: [wallet.address!], assets: wallet.assets })),
  ];

  // The asset as the registry lists it: 1Click delivers it to a NEAR account
  const { recipient } = config.topups;
  const delivered = config.assets.find(asset => asset.name === config.topups.asset?.name);
  const listed = wallets.some(wallet => wallet.addresses.includes(recipient ?? '') && wallet.assets.some(asset => asset.name === delivered?.name));
  if (recipient !== undefined && delivered !== undefined && !listed)
    wallets.push({ name: 'treasury:near', role: 'treasury', addresses: [recipient], assets: [delivered] });

  return wallets;
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
