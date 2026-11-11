import type { Metadata } from 'next';

import { amountParam, amountUnusedParam, topupAmount } from '../../../../src/console/amount';
import { ConsolePage } from '../../../../src/console/ConsolePage';
import { consoleMetadata } from '../../../../src/console/pages';

export const generateMetadata = (): Metadata => consoleMetadata('topup');

export const dynamic = 'force-dynamic';

/**
 * Top up. The proxy hands over a top-up link's amount as a number, or the flag that the link's amount was not used;
 * the amount is checked again here, and goes to the page as a number. No other part of the query is read.
 */
const Topup = async ({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) => {
  const params = await searchParams;

  return <ConsolePage page="topup" amount={topupAmount(params[amountParam])} amountUnused={params[amountUnusedParam] === '1'} />;
};

export default Topup;
