// The amount a top-up link carries: `/topup?amount=5`. Only a plain decimal number inside the top-up limits is
// used. It is parsed to a number, and everything the page prints comes from that number, never from the query.

export const minTopupAmount = 1;
export const maxTopupAmount = 1_000;

const plainDecimal = /^\d+(?:\.\d{1,2})?$/;

/** The amount a query value stands for, or undefined for anything that is not a plain decimal from 1 to 1,000 with at most 2 decimals. */
export const topupAmount = (value: string | readonly string[] | null | undefined): number | undefined => {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || text.length > 12 || !plainDecimal.test(text))
    return undefined;
  const amount = Number(text);

  return amount >= minTopupAmount && amount <= maxTopupAmount ? amount : undefined;
};

/** What a top-up link's `amount` values are: no amount, an amount that is used, or one that was not used. */
export type LinkAmount =
  | { readonly kind: 'none' }
  | { readonly kind: 'used'; readonly amount: number }
  | { readonly kind: 'unused' };

/** The link's amount from every `amount` value of its query. The first one counts; one that isn't an amount is not used. */
export const linkAmount = (values: readonly string[]): LinkAmount => {
  if (values.length === 0)
    return { kind: 'none' };
  const amount = topupAmount(values);

  return amount === undefined ? { kind: 'unused' } : { kind: 'used', amount };
};

// How the proxy hands the link's amount to the Top up page's internal route: the number, or a flag that the
// link had an amount that was not used. A visitor can't set either: the proxy drops the visitor's own query.
export const amountParam = 'amount';
export const amountUnusedParam = 'amountUnused';
