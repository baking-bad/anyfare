import { InvalidAmountError, maxAssetDecimals } from '@anyfare/common';
import type { PlatformConfig } from '@anyfare/core';

import type { OneClickQuoteRequest, OneClickToken } from './oneClick.js';

export type TopupSettings = Pick<PlatformConfig['topups'], 'asset' | 'recipient' | 'refundTo' | 'slippageBps' | 'deadlineMinutes' | 'stablecoins'>;

export interface BuildQuoteRequestInput {
  readonly topups: TopupSettings;
  readonly token: Pick<OneClickToken, 'assetId' | 'symbol'>;
  // In the token's atomic units
  readonly amount: bigint;
  readonly now: Date;
  // True: a price only, with no deposit address
  readonly dry: boolean;
}

/** Whether the token counts as a stablecoin: its symbol is in `stablecoins`, compared without case. */
export const isStablecoin = (topups: Pick<TopupSettings, 'stablecoins'>, symbol: string): boolean =>
  topups.stablecoins.some(stablecoin => stablecoin.toLowerCase() === symbol.toLowerCase());

const required = <TValue>(value: TValue | undefined, field: string): TValue => {
  if (value === undefined)
    throw new Error(`topups.${field} is not set: top-ups are not configured`);

  return value;
};

/**
 * The 1Click quote for a top-up: the deposited amount, whatever it turns out to be, is swapped to the
 * config's asset and delivered to its recipient, and a refund goes to refundTo inside intents.near. The
 * address takes transfers for `deadlineMinutes.stablecoin` when the token is a stablecoin, else for
 * `deadlineMinutes.other`, since another token's price moves.
 */
export const buildQuoteRequest = <TDry extends boolean>({ topups, token, amount, now, dry }: BuildQuoteRequestInput & { readonly dry: TDry }): OneClickQuoteRequest & { readonly dry: TDry } => {
  if (amount <= 0n)
    throw new InvalidAmountError('A top-up amount must be more than 0');
  const minutes = isStablecoin(topups, token.symbol) ? topups.deadlineMinutes.stablecoin : topups.deadlineMinutes.other;

  return {
    dry,
    swapType: 'FLEX_INPUT',
    slippageTolerance: topups.slippageBps,
    originAsset: token.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: `nep141:${required(topups.asset, 'asset').address}`,
    amount: amount.toString(),
    refundTo: required(topups.refundTo, 'refundTo'),
    refundType: 'INTENTS',
    recipient: required(topups.recipient, 'recipient'),
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now.getTime() + minutes * 60_000).toISOString(),
  };
};

// A plain decimal: no sign, no exponent, no leading zeros
const tokenAmountRegExp = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
// More digits than any real top-up; keeps BigInt parsing bounded
const maxTokenAmountDigits = 30;

/**
 * Parses an amount the client typed in the token's units, such as `"1"`, `"0.5"` or `"0.00012"`, into
 * atomic units. Refuses an empty string, a sign, an exponent, zero, more decimals than the token has,
 * and more than 30 digits.
 */
export const parseTokenAmount = (value: string, decimals: number): bigint => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > maxAssetDecimals)
    throw new InvalidAmountError(`Token decimals must be an integer from 0 to ${maxAssetDecimals}`);
  if (value === '')
    throw new InvalidAmountError('The amount is empty');
  if (/^[+-]/.test(value))
    throw new InvalidAmountError('The amount takes no sign');
  if (/^[0-9.]+e[+-]?[0-9]*$/i.test(value))
    throw new InvalidAmountError('The amount takes no exponent: write it out, such as 0.0001');
  if (!tokenAmountRegExp.test(value))
    throw new InvalidAmountError('The amount must be a plain decimal, such as 1 or 0.5');

  const [whole = '', fraction = ''] = value.split('.');
  if (whole.length + fraction.length > maxTokenAmountDigits)
    throw new InvalidAmountError(`The amount has more than ${maxTokenAmountDigits} digits`);
  if (fraction.length > decimals)
    throw new InvalidAmountError(decimals === 0 ? 'The token takes no decimals' : `The token takes at most ${decimals} decimals`);

  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount === 0n)
    throw new InvalidAmountError('The amount must be more than 0');

  return amount;
};

/** Formats atomic units as the shortest exact decimal in the token's units, such as `"0.99"` or `"1"`. */
export const formatTokenAmount = (amount: bigint, decimals: number): string => {
  const unit = 10n ** BigInt(decimals);
  const fraction = decimals === 0 ? '' : (amount % unit).toString().padStart(decimals, '0').replace(/0+$/, '');

  return `${amount / unit}${fraction ? `.${fraction}` : ''}`;
};
