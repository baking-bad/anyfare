import '../../services.css';

import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

import { serverReader } from '../../../src/api/server';
import { PageView } from '../../../src/components/AgentView';
import { readSettings } from '../../../src/config';
import { socialTags } from '../../../src/seo/social';
import { markdownUrl } from '../../../src/markdown/negotiate';
import { serviceMarkdown } from '../../../src/markdown/service';
import { isHost, parsePeriod, serviceDescription } from '../../../src/services/content';
import { loadService, loadServiceCalls, serviceJson, serviceRequests } from '../../../src/services/data';
import { DailyChart } from '../../../src/services/DailyChart';
import { ServiceLive } from '../../../src/services/ServiceLive';
import { EndpointsTable, PaidWithTable, ServiceHead, ServiceStats, ServiceUnavailable, TopBuyers } from '../../../src/services/ServiceView';

type Props = {
  readonly params: Promise<{ readonly host: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

export const generateMetadata = async ({ params }: Props): Promise<Metadata> => {
  const host = (await params).host.toLowerCase();
  const { siteUrl } = readSettings();
  const url = `${siteUrl}/services/${encodeURIComponent(host)}`;
  const description = serviceDescription(host);

  return {
    title: host,
    description,
    alternates: { canonical: url, types: { 'text/markdown': `${siteUrl}${markdownUrl(`/services/${encodeURIComponent(host)}`)}` } },
    ...socialTags({ siteUrl, title: `${host} | Anyfare`, description, url }),
  };
};

const first = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;

/**
 * One service. proxy.ts has already answered a host that isn't one and a service the API doesn't know with
 * the 404 page. A read that fails otherwise, such as the API being down, shows the shared error state in
 * place of the numbers: a page can't choose a status other than 404, and the twin answers 503. The live
 * calls read on their own.
 */
const Service = async ({ params, searchParams }: Props) => {
  const host = (await params).host.toLowerCase();
  if (!isHost(host))
    notFound();
  const settings = readSettings();
  const period = parsePeriod(first((await searchParams)['period']));
  const read = serverReader(await headers(), settings);
  const [result, calls] = await Promise.all([loadService(read, host, period), loadServiceCalls(read, host)]);
  if (!result.ok && result.error.status === 404)
    notFound();
  const now = Date.now();
  const service = result.ok ? result.value : undefined;

  return (
    <PageView
      agent={{
        title: `${host}: stats through Anyfare`,
        markdown: serviceMarkdown(settings, host, result, calls),
        json: serviceJson(result, calls),
        requests: serviceRequests(settings, host, period),
        markdownUrl: `${settings.siteUrl}${markdownUrl(`/services/${host}`)}`,
      }}
    >
      <section className="band">
        <div className="container ruled page-pad svc-page">
          <ServiceHead host={host} service={service} />
          {service === undefined ? <ServiceUnavailable code={result.ok ? undefined : result.error.code} /> : (
            <>
              <EndpointsTable host={host} endpoints={service.endpoints} />
              <ServiceStats host={host} service={service} />
              <DailyChart daily={service.daily} />
              <PaidWithTable service={service} />
              <TopBuyers service={service} now={now} />
            </>
          )}
          <ServiceLive host={host} calls={calls.ok ? calls.value.calls : null} now={now} />
        </div>
      </section>
    </PageView>
  );
};

export default Service;
