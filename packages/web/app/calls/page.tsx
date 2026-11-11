import '../calls.css';

import { headers } from 'next/headers';
import type { Metadata } from 'next';

import { serverReader } from '../../src/api/server';
import { PageView } from '../../src/components/AgentView';
import { readSettings } from '../../src/config';
import { CallsLive } from '../../src/calls/CallsLive';
import { callsDescription, callsTitle } from '../../src/calls/content';
import { callsJson, callsRequests, loadCalls, loadSuggestions } from '../../src/calls/data';
import { callsHref, parseFilters } from '../../src/calls/filters';
import { TopFive } from '../../src/calls/TopFive';
import { callsMarkdown } from '../../src/markdown/calls';
import { socialTags } from '../../src/seo/social';
import { twinHref } from '../../src/seo/twin';

type Props = { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> };

export const generateMetadata = async ({ searchParams }: Props): Promise<Metadata> => {
  const { siteUrl } = readSettings();
  const url = `${siteUrl}/calls`;

  return {
    title: callsTitle,
    description: callsDescription,
    alternates: { canonical: url, types: { 'text/markdown': `${siteUrl}${twinHref('/calls', await searchParams)}` } },
    ...socialTags({ siteUrl, title: `${callsTitle} | Anyfare`, description: callsDescription, url }),
  };
};

/**
 * The Calls page. Each part reads its own data and survives alone: a read that failed shows that part's
 * error state, and an empty database shows zeros and empty states. The filters and the page come from the URL.
 */
const Calls = async ({ searchParams }: Props) => {
  const settings = readSettings();
  const read = serverReader(await headers(), settings);
  const query = await searchParams;
  const filters = parseFilters(query);
  const [data, suggestions] = await Promise.all([loadCalls(read, filters), loadSuggestions(read)]);

  return (
    <PageView
      agent={{
        title: 'Calls: every paid call',
        markdown: callsMarkdown(settings, data, filters),
        json: callsJson(data),
        requests: callsRequests(settings, filters),
        markdownUrl: `${settings.siteUrl}${twinHref('/calls', query)}`,
        source: { kind: 'calls' },
        readAt: Date.now(),
      }}
    >
      <section className="band">
        <div className="container ruled page-pad">
          <CallsLive
            firstKey={callsHref(filters)}
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
