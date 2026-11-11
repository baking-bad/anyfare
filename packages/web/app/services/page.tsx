import '../services.css';

import { headers } from 'next/headers';
import type { Metadata } from 'next';

import { serverReader } from '../../src/api/server';
import { PageView } from '../../src/components/AgentView';
import { readSettings } from '../../src/config';
import { servicesDescription, servicesLead, servicesTitle } from '../../src/services/content';
import { loadServices, servicesJson, servicesRequests } from '../../src/services/data';
import { parseServicesFilters } from '../../src/services/filters';
import { ServicesList } from '../../src/services/ServicesList';
import { servicesMarkdown } from '../../src/markdown/services';
import { markdownUrl } from '../../src/markdown/negotiate';

export const generateMetadata = (): Metadata => {
  const { siteUrl } = readSettings();
  const url = `${siteUrl}/services`;

  return {
    title: servicesTitle,
    description: servicesDescription,
    alternates: { canonical: url, types: { 'text/markdown': `${siteUrl}${markdownUrl('/services')}` } },
    openGraph: { type: 'website', siteName: 'Anyfare', title: `${servicesTitle} | Anyfare`, description: servicesDescription, url },
    twitter: { card: 'summary', title: `${servicesTitle} | Anyfare`, description: servicesDescription },
  };
};

/**
 * The Services page: the services agents paid through Anyfare. The search, the sort and the page come from
 * the URL, and the server renders the same page for the same URL. A read that failed shows the shared error
 * state, and an empty database shows the first-run empty state.
 */
const Services = async ({ searchParams }: { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) => {
  const settings = readSettings();
  const filters = parseServicesFilters(await searchParams);
  const result = await loadServices(serverReader(await headers(), settings), filters);

  return (
    <PageView
      agent={{
        title: 'Services: paid through Anyfare',
        markdown: servicesMarkdown(settings, result, filters),
        json: servicesJson(result),
        requests: servicesRequests(settings, filters),
        markdownUrl: `${settings.siteUrl}${markdownUrl('/services')}`,
      }}
    >
      <section className="band">
        <div className="container ruled page-pad svc-page">
          <div className="stack svc-intro">
            <h1 className="page-title">{servicesTitle}</h1>
            <p className="muted">{servicesLead}</p>
          </div>
          <ServicesList first={result} />
        </div>
      </section>
    </PageView>
  );
};

export default Services;
