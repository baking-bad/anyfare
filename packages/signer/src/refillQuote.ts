import { isRecord, usdDecimals, usdToAtomic, type MicroUsd } from '@anyfare/common';
import { isValidAddress, supportedNetworks } from '@anyfare/core';
import type { OneClickDepositQuoteResponse, OneClickQuoteRequest } from '@anyfare/topups';

// Any NEAR network: account IDs are written alike on each
const nearNetwork = supportedNetworks.find(network => network.namespace === 'near')!;

/**
 * Micro-USD in a stablecoin's atomic units, by the registry's decimals: what the target wallet must
 * receive. Rounded up when the asset has fewer than 6 decimals, so it never receives less.
 */
export const refillAtomicAmount = (amount: MicroUsd, decimals: number): bigint => usdToAtomic(amount, { decimals, rounding: 'ceil' });

/**
 * Whether a deposit address is a NEAR account the hot wallet can transfer to: a named account, or an
 * implicit one of 64 hex characters. Not an Ethereum-like implicit account, `0x` and 40 hex.
 */
export const isNearDepositAddress = (address: string): boolean => isValidAddress(nearNetwork, address) && !/^0x[0-9a-f]{40}$/.test(address);

// The fields of our request that the answer's quoteRequest must repeat as we sent them, when it repeats them
const echoedFields = ['originAsset', 'destinationAsset', 'swapType', 'amount', 'recipient', 'recipientType', 'refundTo', 'refundType', 'depositType'] as const;

export interface RefillQuoteCheck {
  // What the target wallet must receive, in micro-USD and in the target asset's atomic units
  readonly amount: MicroUsd;
  readonly atomicAmount: bigint;
  // The registry's decimals of the source and the target assets
  readonly sourceDecimals: number;
  readonly targetDecimals: number;
  readonly maxFeeBps: number;
  // What we sent, which the answer's quoteRequest must echo when it echoes it
  readonly request: Pick<OneClickQuoteRequest, typeof echoedFields[number]>;
  // Accounts a deposit address must never be: the source token's contract, and our own wallets
  readonly ours: readonly string[];
  // The Signer's clock: the quote's deadline must be at least `quoteDeadlineMarginMs` after it
  readonly now: Date;
}

// The same value: an EVM address in any letter case
const same = (echoed: unknown, sent: string): boolean => typeof echoed === 'string'
  && (/^0x[0-9a-fA-F]+$/.test(sent) ? echoed.toLowerCase() === sent.toLowerCase() : echoed === sent);

// Amounts at the finest of their precisions and micro-USD's, so none is rounded
const scaler = (...decimals: readonly number[]) => {
  const scale = Math.max(usdDecimals, ...decimals);

  return (value: bigint, from: number) => value * 10n ** BigInt(scale - from);
};

/**
 * Whether 1Click's cost, amountIn less amountOut, is at most `maxFeeBps` of the amount. Stablecoins
 * count a unit as a dollar, so each amount is read in USD by its own decimals. Exact: every amount is
 * scaled to the finest of the three precisions, and nothing is rounded.
 */
export const isRefillFeeWithin = ({ amountIn, amountOut, amount, sourceDecimals, targetDecimals, maxFeeBps }: {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly amount: MicroUsd;
  readonly sourceDecimals: number;
  readonly targetDecimals: number;
  readonly maxFeeBps: number;
}): boolean => {
  const scaled = scaler(sourceDecimals, targetDecimals);
  const fee = scaled(amountIn, sourceDecimals) - scaled(amountOut, targetDecimals);

  return fee * 10_000n <= scaled(amount, usdDecimals) * BigInt(maxFeeBps);
};

/**
 * How long before its deadline a quote may still be paid. A transfer that lands after the deadline is
 * refunded, so a quote about to expire would only cost a wasted refill.
 */
export const quoteDeadlineMarginMs = 2 * 60_000;

/**
 * Why the Signer won't pay a real EXACT_OUTPUT quote for a refill, or undefined when it may:
 * - the deposit address is a NEAR account, none of ours nor the source token's contract, with no memo;
 * - the quote's deadline is at least `quoteDeadlineMarginMs` after the Signer's clock;
 * - amountOut and minAmountOut are at least what was asked, and amountOut at most that plus `maxFeeBps`;
 * - amountIn is more than 0, and in USD at most the amount plus `maxFeeBps` of it, so the limits on
 *   the amount limit what leaves the hot wallet;
 * - 1Click's cost, amountIn less amountOut, is at most `maxFeeBps` of the amount;
 * - where the answer echoes our request's fields, they are ours.
 */
export const checkRefillQuote = (answer: OneClickDepositQuoteResponse, check: RefillQuoteCheck): string | undefined => {
  const { quote, raw } = answer;
  const { atomicAmount, maxFeeBps } = check;
  if (!isNearDepositAddress(quote.depositAddress))
    return 'The quote\'s deposit address isn\'t a NEAR account';
  if (check.ours.includes(quote.depositAddress))
    return 'The quote\'s deposit address is one of our own accounts, or the source token\'s contract';
  if (quote.depositMemo !== undefined)
    return 'The quote asks for a deposit memo';
  const deadline = quote.deadline === undefined ? Number.NaN : Date.parse(quote.deadline);
  if (Number.isNaN(deadline) || deadline < check.now.getTime() + quoteDeadlineMarginMs)
    return 'The quote has no deadline, or its deadline is less than 2 minutes away';
  const amountIn = BigInt(quote.amountIn);
  const amountOut = BigInt(quote.amountOut);
  const minAmountOut = BigInt(quote.minAmountOut);
  if (amountOut < atomicAmount)
    return `The quote's amountOut, ${amountOut}, is less than the ${atomicAmount} asked for`;
  if (minAmountOut < atomicAmount)
    return `The quote's minAmountOut, ${minAmountOut}, is less than the ${atomicAmount} asked for`;
  if (amountOut * 10_000n > atomicAmount * BigInt(10_000 + maxFeeBps))
    return `The quote's amountOut, ${amountOut}, is more than ${maxFeeBps} basis points above the ${atomicAmount} asked for`;
  if (amountIn <= 0n)
    return 'The quote\'s amountIn is 0';
  const scaled = scaler(check.sourceDecimals);
  if (scaled(amountIn, check.sourceDecimals) * 10_000n > scaled(check.amount, usdDecimals) * BigInt(10_000 + maxFeeBps))
    return `The quote's amountIn, ${amountIn}, is worth more than the amount plus ${maxFeeBps} basis points`;
  if (!isRefillFeeWithin({ amountIn, amountOut, ...check }))
    return `1Click's cost, amountIn ${amountIn} less amountOut ${amountOut}, is more than ${maxFeeBps} basis points of the amount`;
  const echo = raw['quoteRequest'];
  for (const field of echoedFields) {
    if (isRecord(echo) && echo[field] !== undefined && !same(echo[field], check.request[field]))
      return `The quote's quoteRequest.${field} isn't the one asked for`;
  }

  return undefined;
};
