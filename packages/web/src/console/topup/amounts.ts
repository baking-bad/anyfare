import { usd } from '../../format';
import { isDollarToken, type TokenChoice } from './options';

// The amount of a top-up as the person types it: checked before it is sent, as a decimal string, never as a float.

/** What is wrong with an amount, or `ok` and the amount as it is sent. */
export type AmountCheck =
  | { readonly ok: true; readonly amount: string }
  | { readonly ok: false; readonly problem: string };

const plain = /^\d{1,30}(?:\.\d{1,30})?$/;

/** The amount, trimmed, when it is a positive decimal with at most the token's decimals; otherwise what is wrong with it. */
export const checkAmount = (text: string, choice: Pick<TokenChoice, 'symbol' | 'decimals'>): AmountCheck => {
  const amount = text.trim();
  if (amount === '')
    return { ok: false, problem: `Enter how much ${choice.symbol} to send.` };
  // A comma could be a decimal point or a thousands separator: the page doesn't guess which
  if (amount.includes(','))
    return { ok: false, problem: 'Use a point for decimals, such as 5.50, and no thousands separator.' };
  if (!plain.test(amount))
    return { ok: false, problem: 'Enter a number, such as 5 or 5.50.' };
  const fraction = amount.split('.')[1] ?? '';
  if (fraction.length > choice.decimals)
    return { ok: false, problem: choice.decimals === 0 ? `${choice.symbol} has no decimals.` : `${choice.symbol} has at most ${choice.decimals} decimals.` };
  if (!/[1-9]/.test(amount))
    return { ok: false, problem: 'Enter an amount above 0.' };

  return { ok: true, amount };
};

/** A decimal string without its leading zeros and the zeros at the end of its fraction: "005.50" is "5.5". */
export const plainDecimal = (amount: string): string => {
  const [whole = '', fraction = ''] = amount.trim().split('.');
  const wholePart = whole.replace(/^0+(?=\d)/, '') || '0';
  const fractionPart = fraction.replace(/0+$/, '');

  return fractionPart === '' ? wholePart : `${wholePart}.${fractionPart}`;
};

/** Whether two decimal strings are the same number: "5.50" and "5.5". */
export const sameAmount = (one: string, other: string): boolean => plainDecimal(one) === plainDecimal(other);

/** Whether a dollar token's amount is under the network's least, in USD. Undefined for any other token: the API checks it. */
export const underMinimum = (amount: string, choice: Pick<TokenChoice, 'symbol' | 'minimum'>): boolean | undefined =>
  isDollarToken(choice.symbol) ? Number(amount) < Number(choice.minimum) : undefined;

/** The amount of a top-up link as the field shows it: 5 is "5", 7.25 is "7.25". */
export const linkAmountText = (amount: number): string => String(amount);

/**
 * What a link's amount does to the form for a token: a dollar token's field is filled with it, and says it came from
 * the link; any other token's field stays empty, with a line that says what the link asked for.
 */
export const linkFill = (amount: number, symbol: string): { readonly kind: 'fill'; readonly value: string } | { readonly kind: 'ask'; readonly line: string } =>
  isDollarToken(symbol)
    ? { kind: 'fill', value: linkAmountText(amount) }
    : { kind: 'ask', line: `The link asked for about ${usd(amount)}. Enter how much ${symbol} to send for that.` };

/**
 * The amount the field keeps when the person picks another token. Between two dollar tokens it stays; otherwise it is
 * emptied, so an amount typed for one token is never sent as another. A link's amount fills a dollar token's field.
 */
export const amountAfterPick = (before: string, from: Pick<TokenChoice, 'symbol'> | undefined, to: Pick<TokenChoice, 'symbol'>, link: number | undefined): string => {
  if (link !== undefined) {
    const fill = linkFill(link, to.symbol);

    return fill.kind === 'fill' && (before.trim() === '' || from === undefined || !isDollarToken(from.symbol)) ? fill.value : fill.kind === 'fill' ? before : '';
  }

  return from !== undefined && isDollarToken(from.symbol) && isDollarToken(to.symbol) ? before : '';
};
