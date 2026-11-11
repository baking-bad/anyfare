import '../../console.css';

import type { Metadata } from 'next';

import { readSettings } from '../../../src/config';
import { consoleDescription, consoleTitle } from '../../../src/console/content';
import { topupAmount } from '../../../src/console/amount';
import { ConsoleView } from '../../../src/console/ConsoleView';
import { consoleLink } from '../../../src/hosts';

// Where the proxy sends the console host's paths. The Console page is not indexed, and its canonical URL is the console's.
// It sets its own social tags, so it doesn't inherit the share image, which the console host doesn't serve.
export const generateMetadata = (): Metadata => {
  const url = consoleLink(readSettings());

  return {
    title: consoleTitle,
    description: consoleDescription,
    robots: { index: false, follow: false },
    alternates: { canonical: url },
    openGraph: { type: 'website', siteName: 'Anyfare', title: `${consoleTitle} | Anyfare`, description: consoleDescription, url },
    twitter: { card: 'summary', title: `${consoleTitle} | Anyfare`, description: consoleDescription },
  };
};

export const dynamic = 'force-dynamic';

/** The page the console host serves for now, with the amount of a top-up link when it has a valid one. */
const Console = async ({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) => {
  const amount = topupAmount((await searchParams)['amount']);

  return <ConsoleView hosts={readSettings()} amount={amount} />;
};

export default Console;
