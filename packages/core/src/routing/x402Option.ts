import { atomicToUsd, isRecord, type MicroUsd } from '@anyfare/common';

import { isValidAddress } from '../addresses.js';
import type { NetworkInfo } from '../networks.js';
import type { Asset, PlatformConfig } from '../platform/config.js';

/**
 * Why the platform won't pay a routed target's x402 option, as a code for the logs. Whether its network
 * and asset are in the registry is the caller's check: `not_in_registry`.
 */
export type X402OptionRefusal = 'not_exact' | 'invalid_option' | 'invalid_pay_to' | 'invalid_timeout' | 'transfer_method' | 'no_fee_payer' | 'fee_payer_is_us'
  | 'invalid_amount';

/** An `exact` x402 option of any JSON shape, with a network and an asset to look up in the registry. */
export type ExactX402Option = Readonly<Record<string, unknown>> & {
  readonly scheme: 'exact';
  readonly network: string;
  readonly asset: string;
};

/** An option the platform pays: its amount in the asset's atomic units, and its price in micro-USD. */
export interface X402OptionPrice {
  readonly atomicAmount: bigint;
  // Rounded up to the micro-USD: the platform never quotes less than the target asks
  readonly price: MicroUsd;
}

// The longest an x402 authorization may stay valid, from when it's signed
export const maxX402TimeoutSeconds = 300;
// The longest memo a Solana option may ask for, as @x402/svm's client allows it
export const maxSolanaMemoBytes = 256;

const isTransactionVersions = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every(version => version === 0 || version === 1);

/** The option, when it's an `exact` x402 option with a network and an asset to look up. Otherwise `not_exact`. */
export const asExactX402Option = (requirement: unknown): ExactX402Option | undefined =>
  isRecord(requirement) && requirement['scheme'] === 'exact' && typeof requirement['network'] === 'string' && typeof requirement['asset'] === 'string'
    ? requirement as ExactX402Option
    : undefined;

/**
 * The registry's asset for an option's network and asset address. Base58 addresses are case-sensitive,
 * EVM addresses aren't.
 */
export const findOptionAsset = (config: Pick<PlatformConfig, 'assets'>, network: NetworkInfo, address: string): Asset | undefined =>
  config.assets.find(item => item.network.id === network.id
    && (network.namespace === 'solana' ? item.address === address : item.address.toLowerCase() === address.toLowerCase()));

/**
 * Checks an x402 option of an asset of the registry against what the official clients sign: an
 * `exact` authorization of its amount to its payTo, valid for at most 5 minutes.
 * - every chain: a payTo of the network, a whole `maxTimeoutSeconds` from 1 to 300, and the
 *   authorization payment flow;
 * - EVM: an EIP-3009 transfer, never Permit2 or a Circle Gateway nanopayment, with the asset's EIP-712
 *   domain in `extra.name` and `extra.version`;
 * - Solana: a fee payer that isn't our wallet, since the target's facilitator pays the transaction's
 *   fee, transaction versions 0 or 1, and a memo of at most 256 bytes;
 * - an amount: a decimal string of up to 30 digits, above 0.
 * The proxy checks it to choose an option, and the Signer again before it signs.
 */
export const checkX402Option = (
  requirement: unknown,
  { asset, network, ourSolanaWallet }: { readonly asset: Asset; readonly network: NetworkInfo; readonly ourSolanaWallet?: string | undefined },
): ({ readonly ok: true; readonly refusal?: undefined } & X402OptionPrice) | { readonly ok?: undefined; readonly refusal: X402OptionRefusal } => {
  const option = asExactX402Option(requirement);
  if (!option)
    return { refusal: 'not_exact' };
  const extra = isRecord(option['extra']) ? option['extra'] : {};
  const payTo = option['payTo'];
  // Lexical, as the EVM client takes it: its checksum isn't checked
  if (typeof payTo !== 'string' || !isValidAddress(network, payTo))
    return { refusal: 'invalid_pay_to' };
  const timeout = option['maxTimeoutSeconds'];
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > maxX402TimeoutSeconds)
    return { refusal: 'invalid_timeout' };
  // An authorization, rather than an upfront or escrow payment
  if (extra['paymentFlow'] !== undefined && extra['paymentFlow'] !== 'authorization')
    return { refusal: 'invalid_option' };
  if (network.namespace === 'eip155') {
    // Permit2 and Gateway's batched nanopayments sign another kind of payload
    if ((extra['assetTransferMethod'] !== undefined && extra['assetTransferMethod'] !== 'eip3009') || extra['name'] === 'GatewayWalletBatched')
      return { refusal: 'transfer_method' };
    if (typeof extra['name'] !== 'string' || extra['name'] === '' || typeof extra['version'] !== 'string' || extra['version'] === '')
      return { refusal: 'invalid_option' };
  }
  else {
    const feePayer = extra['feePayer'];
    if (typeof feePayer !== 'string' || feePayer === '')
      return { refusal: 'no_fee_payer' };
    if (feePayer === ourSolanaWallet)
      return { refusal: 'fee_payer_is_us' };
    const memo = extra['memo'];
    if (!isValidAddress(network, feePayer) || ('transactionVersions' in extra && !isTransactionVersions(extra['transactionVersions']))
      || (memo !== undefined && (typeof memo !== 'string' || new TextEncoder().encode(memo).length > maxSolanaMemoBytes)))
      return { refusal: 'invalid_option' };
  }
  const amount = option['amount'];
  if (typeof amount !== 'string' || !/^\d{1,30}$/.test(amount) || BigInt(amount) <= 0n)
    return { refusal: 'invalid_amount' };
  const atomicAmount = BigInt(amount);

  return { ok: true, atomicAmount, price: atomicToUsd(atomicAmount, { decimals: asset.decimals, rounding: 'ceil' }) };
};
