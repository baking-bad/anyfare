import { paths } from '../api/endpoints';
import type { ApiResult } from '../api/reader';
import type { ServicesPage } from '../api/types';
import type { SiteSettings } from '../config';
import { count, ms, pct, usdOf } from '../format';
import { addServiceLine, cappedLine, firstRunLine, noMatchLine, notPaidYet, payHowLine, rowStatus, servicePath, servicesDescription, servicesLead, servicesNumberLabels, servicesTitle } from '../services/content';
import { apiServicesQuery, servicesHref, servicesPageSize, sortChoices, type ServicesFilters } from '../services/filters';

// The Services page as Markdown: the same facts as the page, from the same read.

const cell = (text: string): string => text.replaceAll('|', '\\|');

const row = (siteUrl: string, service: ServicesPage['services'][number], now: number): string => {
  const { notPaid, checked } = rowStatus(service, now);
  const link = `[${cell(service.host)}](${siteUrl}${servicePath(service.host)})`;
  const start = `| ${link} | ${service.status} | ${count(service.paidEndpoints)} | ${usdOf(service.priceFrom)}`;

  // A checked service has no numbers: its calls say so, and the day it was checked is the last cell
  return notPaid
    ? `${start} | ${notPaidYet} | - | - | - | - | ${checked ?? '-'} |`
    : `${start} | ${count(service.calls)} | ${count(service.buyers)} | ${usdOf(service.volume)} | ${service.successRate === null ? '-' : pct(service.successRate)} | ${service.p50Ms === null ? '-' : ms(service.p50Ms)} | - |`;
};

const list = (siteUrl: string, page: ServicesPage, filters: ServicesFilters, now: number): string => {
  const pages = Math.max(1, Math.ceil(page.total / page.size));
  const from = page.total > 0 ? (page.page - 1) * page.size + 1 : 0;
  const to = Math.min(page.total, page.page * page.size);
  const next = page.page < pages ? `Next page: ${siteUrl}${servicesHref({ ...filters, page: page.page + 1 }, '/services.md')}` : 'This is the last page.';
  const table = page.services.length === 0
    ? filters.q !== undefined || page.totals.services > 0 ? noMatchLine : firstRunLine
    : `| Service | Status | Paid endpoints | Price from | Calls, 30 days | Buyers | Volume | 2xx | Median | Checked |
|---|---|---|---|---|---|---|---|---|---|
${page.services.map(service => row(siteUrl, service, now)).join('\n')}`;

  return `${filters.q === undefined ? '' : `Search: ${filters.q}\n\n`}${table}

Page ${count(page.page)}, services ${count(from)}–${count(to)} of ${count(page.total)}. ${next}${page.totalCapped ? `\n\n${cappedLine}` : ''}`;
};

/** `/services.md`. `filters` are the ones the twin's query holds. `now` is the clock "Checked <day>" counts from. */
export const servicesMarkdown = (settings: SiteSettings, result: ApiResult<ServicesPage>, filters: ServicesFilters, now: number = Date.now()): string => {
  const { siteUrl, apiUrl, payUrl } = settings;
  const numbers = result.ok
    ? `- ${servicesNumberLabels.listed}: ${count(result.value.totals.services)}
- ${servicesNumberLabels.paid}: ${count(result.value.totals.paidServices)}
- ${servicesNumberLabels.calls}: ${count(result.value.totals.calls30d)}`
    : 'Not available right now.';

  return `# ${servicesTitle}

> ${servicesDescription}

${servicesLead}

## How to pay any of them

${payHowLine(payUrl)}

Each service has its own page with its endpoints and their pay links: \`${siteUrl}/services/<host>\`, and as Markdown \`${siteUrl}/services/<host>.md\`.

## How to add one

${addServiceLine}

A service's \`status\` is \`paid\` when an agent paid it through Anyfare, and \`checked\` when only a check listed it: its calls read "${notPaidYet}", and the last column says the day it was checked.

## Numbers

${numbers}

## Services

${result.ok ? list(siteUrl, result.value, filters, now) : 'Not available right now.'}

Search, sort and page go in the query: \`${siteUrl}/services.md?q=<part of the name or host>&sort=calls&page=2\`. sort is ${sortChoices.map(choice => choice.value).join(', ')} (${sortChoices.map(choice => choice.label.toLowerCase()).join('; ')}). Each page has ${servicesPageSize} services.

The same services as JSON: \`GET ${apiUrl}${paths.services(apiServicesQuery(filters))}\`
`;
};
