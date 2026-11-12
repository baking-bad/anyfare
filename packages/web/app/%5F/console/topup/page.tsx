import type { Metadata } from 'next';

import { amountParam, amountUnusedParam, topupAmount } from '../../../../src/console/amount';
import { ConsolePage } from '../../../../src/console/ConsolePage';
import { consoleMetadata } from '../../../../src/console/pages';

export const generateMetadata = (): Metadata => consoleMetadata('topup');

export const dynamic = 'force-dynamic';

/**
 * Top up. The proxy hands over a top-up link's amount as a number, or the flag that the link's amount was not used;
 * the amount is checked again here, and goes to the page as a number. An `amount` that is here but is no amount was
 * not used either, whatever carried it. No other part of the query is read.
 */
const Topup = async ({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) => {
  const params = await searchParams;
  const amount = topupAmount(params[amountParam]);
  const present = params[amountParam] !== undefined;

  return <ConsolePage page="topup" amount={amount} amountUnused={params[amountUnusedParam] === '1' || (present && amount === undefined)} />;
};

export default Topup;
