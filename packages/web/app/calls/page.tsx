import '../calls.css';

import { headers } from 'next/headers';
import type { Metadata } from 'next';

import { serverReader } from '../../src/api/server';
import { PageView } from '../../src/components/AgentView';
import { readSettings } from '../../src/config';
import { CallsLive } from '../../src/calls/CallsLive';
import { callsDescription, callsTitle } from '../../src/calls/content';
import { callsJson, callsRequests, loadCalls, loadSuggestions } from '../../src/calls/data';
import { parseFilters } from '../../src/calls/filters';
import { TopFive } from '../../src/calls/TopFive';
import { callsMarkdown } from '../../src/markdown/calls';
import { markdownUrl } from '../../src/markdown/negotiate';

export const generateMetadata = (): Metadata => {
  const { siteUrl } = readSettings();
  const url = `${siteUrl}/calls`;

  return {
    title: callsTitle,
    description: callsDescription,
    alternates: { canonical: url, types: { 'text/markdown': `${siteUrl}${markdownUrl('/calls')}` } },
    openGraph: { type: 'website', siteName: 'Anyfare', title: `${callsTitle} | Anyfare`, description: callsDescription, url },
    twitter: { card: 'summary', title: `${callsTitle} | Anyfare`, description: callsDescription },
  };
};

/**
 * The Calls page. Each part reads its own data and survives alone: a read that failed shows that part's
 * error state, and an empty database shows zeros and empty states. The filters and the page come from the URL.
 */
const Calls = async ({ searchParams }: { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) => {
  const settings = readSettings();
  const read = serverReader(await headers(), settings);
  const filters = parseFilters(await searchParams);
  const [data, suggestions] = await Promise.all([loadCalls(read, filters), loadSuggestions(read)]);

  return (
    <PageView
      agent={{
        title: 'Calls: every paid call',
        markdown: callsMarkdown(settings, data, filters),
        json: callsJson(data),
        requests: callsRequests(settings, filters),
        markdownUrl: `${settings.siteUrl}${markdownUrl('/calls')}`,
      }}
    >
      <section className="band">
        <div className="container ruled page-pad">
          <CallsLive
            now={Date.now()}
            live={data.live.ok ? data.live.value : null}
            calls={data.calls}
            suggestions={suggestions}
          />
        </div>
      </section>
      <TopFive top={data.top} />
    </PageView>
  );
};

export default Calls;
