import { paths } from '../api/endpoints';
import type { ApiResult } from '../api/reader';
import type { CallsPage, ServiceDetail } from '../api/types';
import type { SiteSettings } from '../config';
import { paidWithName } from '../content/home';
import { count, ms, pct, usdOf } from '../format';
import { shortAddress } from '../calls/address';
import { callsChange, comparedWith, perBuyer, periodSentence, serviceDescription, togetherLine, failedLine, checkHref, inexactLine } from '../services/content';
import { serviceCallsSize } from '../services/data';
import { formatChange } from '../home/change';

// The Service page as Markdown: the same facts as the page, from the same read.

const cell = (text: string): string => text.replaceAll('|', '\\|');

const unavailable = 'Not available right now.';

const numbers = (service: ServiceDetail): string => {
  const { stats, period } = service;
  const change = callsChange(stats.calls, stats.callsBefore);

  return `- Paid calls: ${count(stats.calls)}${change === null ? '' : ` (${formatChange(change, true)} against ${comparedWith(period)})`}
- Volume: ${usdOf(stats.volume)}
- Unique buyers: ${count(stats.buyers)}
- Came back: ${pct(stats.returningShare)} (buyers who paid on 2 or more days)
- Answered 2xx: ${stats.successRate === null ? '-' : pct(stats.successRate)} (${failedLine(stats.failedCalls)})
- Median time: ${stats.p50Ms === null ? '-' : ms(stats.p50Ms)}${stats.p95Ms === null ? '' : `, p95 ${ms(stats.p95Ms)}`}`;
};

const byPaidWith = (service: ServiceDetail): string => service.byPaidWith.length === 0
  ? 'No paid calls in this period.'
  : `| Buyer paid with | Paid calls | Share | Buyers | Volume | Avg. per buyer |
|---|---|---|---|---|---|
${service.byPaidWith.map(way => {
    const average = perBuyer(way.volume, way.buyers);

    return `| ${cell(paidWithName(way.paidWith))} | ${count(way.calls)} | ${pct(way.share)} | ${count(way.buyers)} | ${usdOf(way.volume)} | ${average === null ? '-' : usdOf(String(average))} |`;
  }).join('\n')}`;

const endpoints = (service: ServiceDetail): string => service.endpoints.length === 0
  ? 'No paid endpoints.'
  : `| Endpoint | Price now | Paid calls | Buyers | Volume | 2xx | Median | Pay link |
|---|---|---|---|---|---|---|---|
${service.endpoints.map(endpoint => `| ${endpoint.method === null ? '' : `${endpoint.method} `}${cell(endpoint.path)} | ${usdOf(endpoint.priceNow)} | ${count(endpoint.calls)} | ${count(endpoint.buyers)} | ${usdOf(endpoint.volume)} | ${endpoint.successRate === null ? '-' : pct(endpoint.successRate)} | ${endpoint.p50Ms === null ? '-' : ms(endpoint.p50Ms)} | ${endpoint.link} |`).join('\n')}`;

const topBuyers = (service: ServiceDetail): string => service.topBuyers.buyers.length === 0
  ? 'No buyers in this period.'
  : `${togetherLine(service.topBuyers.share)}.

| Buyer | Paid with | Calls | Spent | Last call |
|---|---|---|---|---|
${service.topBuyers.buyers.map(buyer => `| ${buyer.payer === null ? 'A Credits account' : cell(shortAddress(buyer.payer, 64))} | ${cell(paidWithName(buyer.paidWith))} | ${count(buyer.calls)} | ${usdOf(buyer.spent)} | ${buyer.lastCallAt} |`).join('\n')}`;

/** `/services/<host>.md`: the service as the API read it for the period, and the last calls to it. */
export const serviceMarkdown = (settings: SiteSettings, host: string, result: ApiResult<ServiceDetail>, calls: ApiResult<CallsPage>): string => {
  const { siteUrl, apiUrl, payUrl } = settings;
  const service = result.ok ? result.value : undefined;
  const period = service?.period ?? '30d';
  const first = service === undefined ? undefined : [...service.endpoints].sort((a, b) => b.calls - a.calls)[0];

  return `# ${host}

> ${serviceDescription(host)}

Pay any of its endpoints at ${payUrl}/${host}/<path>, in any way we take. Each endpoint has its own pay link. To see what an endpoint asks before you pay: ${siteUrl}${checkHref(host, first?.path, first?.method)}

## Through Anyfare, ${periodSentence(period)}

${service === undefined ? unavailable : `${count(service.paidEndpoints)} paid endpoints.\n\n${numbers(service)}${service.exact ? '' : `\n\n${inexactLine}`}`}

Another period: \`${apiUrl}${paths.service(host, period === '7d' ? '30d' : '7d')}\` (period is today, 7d, 30d or all). On the page: \`${siteUrl}/services/${host}.md?period=7d\`.

## By payment method

${service === undefined ? unavailable : byPaidWith(service)}

## Endpoints

Paths only. A query string can hold a buyer's data, so it is never shown.

${service === undefined ? unavailable : endpoints(service)}

## Top 5 buyers

A Credits buyer is never named.

${service === undefined ? unavailable : topBuyers(service)}

## Last calls

${calls.ok ? callsList(siteUrl, calls.value) : unavailable}

Calls to this service as they finish, as server-sent events: \`GET ${apiUrl}${paths.callStream({ host })}\`
`;
};

const callsList = (siteUrl: string, page: CallsPage): string => page.calls.length === 0
  ? 'No calls yet.'
  : `Newest first, up to ${serviceCallsSize}. Times are UTC.

| When | Path | Paid with | Amount | Status |
|---|---|---|---|---|
${page.calls.map(call => `| ${call.at} | [${cell(call.path)}](${siteUrl}/calls/${call.id}) | ${cell(paidWithName(call.paidWith))} | ${call.status === 'paid' ? usdOf(call.amount) : '$0'} | ${call.status === 'paid' ? 'Paid' : call.apiStatus === null ? 'free' : `${call.apiStatus} · free`} |`).join('\n')}`;

/** The twin of a service the API doesn't know. */
export const serviceMissingMarkdown = (line: string): string => `# Not found\n\n${line}\n`;
