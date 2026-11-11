import type { ApiResult } from '../api/reader';
import type { Call, TopStats } from '../api/types';
import type { SiteSettings } from '../config';
import { callRules, callsDescription, callsLine, callsTitle, periodName, tokenName } from '../calls/content';
import type { CallsData } from '../calls/data';
import { apiFilter, apiQuery, callsHref, pageSize, type CallsFilters } from '../calls/filters';
import { paths } from '../api/endpoints';
import { paidWithFilterName, paidWithName } from '../content/home';
import { count, ms, usdOf } from '../format';

// The Calls page as Markdown: the same facts as the page, from the same reads. A part whose read failed
// says so and the rest stays.

const unavailable = 'Not available right now.';

const cell = (text: string): string => text.replaceAll('|', '\\|');

const section = <TValue>(result: ApiResult<TValue>, render: (value: TValue) => string): string => result.ok ? render(result.value) : unavailable;

const callRow = (call: Call): string => {
  const paid = call.status === 'paid';
  const status = paid ? 'Paid' : call.apiStatus === null ? 'free' : `${call.apiStatus} · free`;

  return `| ${call.at} | ${cell(call.service)} | ${cell(call.path)} | ${paidWithName(call.paidWith)} | ${call.apiPaidWith === null ? '-' : paidWithName(call.apiPaidWith)} | ${call.payer === null ? '-' : cell(call.payer)} | ${paid ? usdOf(call.amount, 3) : '$0'} | ${status} | ${call.ms === null ? '-' : ms(call.ms)} |`;
};

const filterLines = (filters: CallsFilters): string => [
  filters.paidWith === undefined ? undefined : `Paid with: ${paidWithFilterName(filters.paidWith)}`,
  filters.service === undefined ? undefined : `Service: ${filters.service}`,
  filters.endpoint === undefined ? undefined : `Endpoint: ${filters.endpoint}`,
  filters.status === undefined ? undefined : `Status: ${filters.status === 'paid' ? 'Paid' : 'Failed, free'}`,
].filter((line): line is string => line !== undefined).map(line => `- ${line}`).join('\n');

const topLists = (top: TopStats, siteUrl: string): string => {
  const services = top.services.length === 0 ? 'No paid calls yet.' : top.services.map(service => `- [${cell(service.host)}](${siteUrl}/services/${service.host}): ${count(service.calls)} calls`).join('\n');
  const endpoints = top.endpoints.length === 0 ? 'No paid calls yet.' : top.endpoints.map(endpoint => `- [${cell(endpoint.host)}${cell(endpoint.path)}](${siteUrl}/check?url=${endpoint.host}${endpoint.path}): ${count(endpoint.calls)} calls`).join('\n');
  const paid = top.paidWith.length === 0 ? 'No paid calls yet.' : [...top.paidWith].sort((a, b) => b.calls - a.calls).map(share => `- ${paidWithName(share.paidWith)}: ${count(share.calls)} calls`).join('\n');
  const tokens = top.topupTokens.length === 0 ? 'No top-ups yet.' : top.topupTokens.map(token => `- ${tokenName(token.token, token.network)}: ${count(token.count)}`).join('\n');

  return `### Services

${services}

### Endpoints

${endpoints}

### How buyers paid

${paid}

### Top-up tokens

${tokens}`;
};

/** `/calls.md`. `filters` are the ones the twin's query holds. */
export const callsMarkdown = (settings: SiteSettings, data: CallsData, filters: CallsFilters): string => {
  const { siteUrl, apiUrl } = settings;

  const today = section(data.live, ({ today: numbers }) => `- Paid calls: ${count(numbers.calls)}
- Volume: ${usdOf(numbers.volume, 2)}
- Buyers: ${count(numbers.buyers)}
- Paid from NEAR: ${Math.round(numbers.nearShare * 100)}%`);

  const list = section(data.calls, ({ calls, page, size, total, totalCapped }) => {
    const pages = Math.max(1, Math.ceil(total / size));
    const from = total > 0 ? (page - 1) * size + 1 : 0;
    const to = Math.min(total, page * size);
    const of = `${count(total)}${totalCapped ? '+' : ''}`;
    const filtered = filterLines(filters);
    const next = page < pages ? `Next page: ${siteUrl}${callsHref({ ...filters, page: page + 1 }, '/calls.md')}` : 'This is the last page.';
    const table = calls.length === 0
      ? filtered === '' ? 'No calls yet.' : 'No calls match these filters yet.'
      : `Newest first. Times are UTC.

| When | Service | Path | Paid with | API paid with | Buyer | Amount | Status | Time |
|---|---|---|---|---|---|---|---|---|
${calls.map(callRow).join('\n')}

Each call has its receipt at ${siteUrl}/calls/<id>.`;

    return `${filtered === '' ? '' : `Filters:\n\n${filtered}\n\n`}${table}

Page ${count(page)}, calls ${count(from)}–${count(to)} of ${of}. ${next}`;
  });

  const top = section(data.top, value => `${periodName(value.period).replace(/^./, letter => letter.toUpperCase())}. Another period: ${apiUrl}${paths.topStats('7d')} (period is today, 7d, 30d or all).

${topLists(value, siteUrl)}`);

  return `# ${callsTitle}

> ${callsDescription}

${callsLine}

## Today, UTC

${today}

## What a call shows

${callRules.map(rule => `- ${rule}`).join('\n')}

## Calls

${list}

Filters go in the query: \`${siteUrl}/calls.md?paidWith=near&service=<part of the host>&status=paid&page=2\`. paidWith is near, base, solana, tempo or credits. status is paid or free. Each page has ${pageSize} calls.

The same calls as JSON: \`GET ${apiUrl}${paths.calls(apiQuery(filters))}\`

Each call as it finishes, as server-sent events: \`GET ${apiUrl}${paths.callStream(apiFilter(filters))}\`

## Top 5, 30 days

${top}
`;
};
