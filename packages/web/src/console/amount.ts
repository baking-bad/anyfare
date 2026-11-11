// The amount a top-up link carries: `/topup?amount=5`. Only a plain decimal number inside the top-up limits is
// used. It is parsed to a number, and everything the page prints comes from that number, never from the query.

export const minTopupAmount = 1;
export const maxTopupAmount = 10_000;

const plainDecimal = /^\d+(?:\.\d{1,2})?$/;

/** The amount a query value stands for, or undefined for anything that is not a plain decimal from 1 to 10,000 with at most 2 decimals. */
export const topupAmount = (value: string | string[] | null | undefined): number | undefined => {
  const text = Array.isArray(value) ? value[0] : value;
  if (text === undefined || text === null || text.length > 12 || !plainDecimal.test(text))
    return undefined;
  const amount = Number(text);

  return amount >= minTopupAmount && amount <= maxTopupAmount ? amount : undefined;
};
