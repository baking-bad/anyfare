import '../services.css';

import { headers } from 'next/headers';
import type { Metadata } from 'next';

import { serverReader } from '../../src/api/server';
import { PageView } from '../../src/components/AgentView';
import { readSettings } from '../../src/config';
import { servicesDescription, servicesLead, servicesTitle } from '../../src/services/content';
import { loadServices, servicesJson, servicesRequests } from '../../src/services/data';
import { parseServicesFilters, servicesHref } from '../../src/services/filters';
import { ServicesList } from '../../src/services/ServicesList';
import { servicesMarkdown } from '../../src/markdown/services';
import { socialTags } from '../../src/seo/social';
import { twinHref } from '../../src/seo/twin';

type Props = { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> };

export const generateMetadata = async ({ searchParams }: Props): Promise<Metadata> => {
  const { siteUrl } = readSettings();
  const url = `${siteUrl}/services`;

  return {
    title: servicesTitle,
    description: servicesDescription,
    alternates: { canonical: url, types: { 'text/markdown': `${siteUrl}${twinHref('/services', await searchParams)}` } },
    ...socialTags({ siteUrl, title: `${servicesTitle} | Anyfare`, description: servicesDescription, url }),
  };
};

/**
 * The Services page: the paid APIs agents paid or checked through Anyfare. The search, the sort and the page come from
 * the URL, and the server renders the same page for the same URL. A read that failed shows the shared error
 * state, and an empty database shows the first-run empty state.
 */
const Services = async ({ searchParams }: Props) => {
  const settings = readSettings();
  const query = await searchParams;
  const filters = parseServicesFilters(query);
  const result = await loadServices(serverReader(await headers(), settings), filters);

  return (
    <PageView
      agent={{
        title: 'Services: paid or checked through Anyfare',
        markdown: servicesMarkdown(settings, result, filters),
        json: servicesJson(result),
        requests: servicesRequests(settings, filters),
        markdownUrl: `${settings.siteUrl}${twinHref('/services', query)}`,
        source: { kind: 'services' },
        readAt: Date.now(),
      }}
    >
      <section className="band">
        <div className="container ruled page-pad svc-page">
          <div className="stack svc-intro">
            <h1 className="page-title">{servicesTitle}</h1>
            <p className="muted">{servicesLead}</p>
          </div>
          <ServicesList first={result} firstKey={servicesHref(filters)} now={Date.now()} />
        </div>
      </section>
    </PageView>
  );
};

export default Services;
