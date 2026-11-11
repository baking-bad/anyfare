import { paths } from '../api/endpoints';
import type { ApiResult } from '../api/reader';
import type { ServicesPage } from '../api/types';
import type { SiteSettings } from '../config';
import { count, ms, pct, usdOf } from '../format';
import { cappedLine, firstRunLine, noMatchLine, payHowLine, servicesDescription, servicesLead, servicesTitle } from '../services/content';
import { apiServicesQuery, servicesHref, servicesPageSize, sortChoices, type ServicesFilters } from '../services/filters';

// The Services page as Markdown: the same facts as the page, from the same read.

const cell = (text: string): string => text.replaceAll('|', '\\|');

const row = (siteUrl: string, service: ServicesPage['services'][number]): string =>
  `| [${cell(service.host)}](${siteUrl}/services/${service.host}) | ${count(service.paidEndpoints)} | ${usdOf(service.priceFrom, 3)} | ${count(service.calls)} | ${count(service.buyers)} | ${usdOf(service.volume, 2)} | ${service.successRate === null ? '-' : pct(service.successRate)} | ${service.p50Ms === null ? '-' : ms(service.p50Ms)} |`;

const list = (siteUrl: string, page: ServicesPage, filters: ServicesFilters): string => {
  const pages = Math.max(1, Math.ceil(page.total / page.size));
  const from = page.total > 0 ? (page.page - 1) * page.size + 1 : 0;
  const to = Math.min(page.total, page.page * page.size);
  const next = page.page < pages ? `Next page: ${siteUrl}${servicesHref({ ...filters, page: page.page + 1 }, '/services.md')}` : 'This is the last page.';
  const table = page.services.length === 0
    ? filters.q !== undefined || page.totals.services > 0 ? noMatchLine : firstRunLine
    : `| Service | Paid endpoints | Price from | Calls, 30 days | Buyers | Volume | 2xx | Median |
|---|---|---|---|---|---|---|---|
${page.services.map(service => row(siteUrl, service)).join('\n')}`;

  return `${filters.q === undefined ? '' : `Search: ${filters.q}\n\n`}${table}

Page ${count(page.page)}, services ${count(from)}–${count(to)} of ${count(page.total)}. ${next}${page.totalCapped ? `\n\n${cappedLine}` : ''}`;
};

/** `/services.md`. `filters` are the ones the twin's query holds. */
export const servicesMarkdown = (settings: SiteSettings, result: ApiResult<ServicesPage>, filters: ServicesFilters): string => {
  const { siteUrl, apiUrl, payUrl } = settings;
  const numbers = result.ok
    ? `- Services paid through Anyfare: ${count(result.value.totals.services)}
- Paid endpoints on them: ${count(result.value.totals.paidEndpoints)}
- Calls through Anyfare, 30 days: ${count(result.value.totals.calls30d)}`
    : 'Not available right now.';

  return `# ${servicesTitle}

> ${servicesDescription}

${servicesLead}

## How to pay any of them

${payHowLine(payUrl)}

Each service has its own page with its endpoints and their pay links: \`${siteUrl}/services/<host>\`, and as Markdown \`${siteUrl}/services/<host>.md\`.

## Numbers

${numbers}

## Services

${result.ok ? list(siteUrl, result.value, filters) : 'Not available right now.'}

Search, sort and page go in the query: \`${siteUrl}/services.md?q=<part of the name or host>&sort=calls&page=2\`. sort is ${sortChoices.map(choice => choice.value).join(', ')} (${sortChoices.map(choice => choice.label.toLowerCase()).join('; ')}). Each page has ${servicesPageSize} services.

The same services as JSON: \`GET ${apiUrl}${paths.services(apiServicesQuery(filters))}\`
`;
};
