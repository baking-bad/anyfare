import type { ApiResult } from '../api/reader';
import type { CallsPage, EndpointStats } from '../api/types';
import type { SiteSettings } from '../config';
import { paidWithName } from '../content/home';
import { count, ms, pct, usdOf } from '../format';
import type { CheckNumbers, PayableCheck } from '../check/answer';
import {
  askRows, asksSentence, checkAddress, checkDescription, cut, defaultMethod, knownMethod, offersPost, pathLines, tryPostLine, describedAs, emptyLine, linkParts, noCallsLine, periodName, refusalWords, titleFor, unavailableLine, unlistedLine, wayWords, ownPayLine, ownPayTitle,
} from '../check/content';
import type { CheckData } from '../check/data';
import { inexactLine, isHost, servicePath } from '../services/content';

// The Check page as Markdown: the same facts as the page, from the same reads. Text that came from the
// link's own API is put on one line and cut, so it can't add structure to the page.

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll(/\s+/g, ' ');

const oneLine = (text: string): string => text.replaceAll(/\s+/g, ' ').trim();

const unavailable = 'Not available right now.';

const quote = (check: PayableCheck): string => check.quote === undefined
  ? ''
  : `\n- Our quote: ${usdOf(check.quote.amount)}, fee ${usdOf(check.quote.fee)}`;

const payWith = (check: PayableCheck): string => check.payWith.length === 0
  ? 'No way to pay is listed right now.'
  : check.payWith.map(way => `- ${wayWords(way).name}: ${usdOf(way.amount)} (${wayWords(way).note})`).join('\n');

const numbers = (stats: ApiResult<EndpointStats>): string => {
  if (!stats.ok)
    return unavailable;
  const { stats: figures, byPaidWith } = stats.value;
  const ways = [...byPaidWith].sort((a, b) => b.calls - a.calls);

  return `- Paid calls: ${count(figures.calls)}
- Unique payers: ${count(figures.buyers)}
- Volume: ${usdOf(figures.volume)}
- Answered 2xx: ${figures.successRate === null ? '-' : pct(figures.successRate)}
- Median time: ${figures.p50Ms === null ? '-' : ms(figures.p50Ms)}
- Buyers paid with: ${ways.length === 0 ? 'no paid call in this period' : ways.map(way => `${paidWithName(way.paidWith)} ${count(way.calls)}`).join(', ')}

${stats.value.exact ? '' : `${inexactLine}\n\n`}Another period: add \`&period=7d\` to the address (today, 7d, 30d or all). Another page of calls: \`&page=2\`.`;
};

// The check's own 30-day numbers, for when the API's read of them failed
const checkNumbers = (figures: CheckNumbers): string => `- Paid calls: ${count(figures.calls)}
- Unique payers: ${count(figures.buyers)}
- Volume: ${usdOf(figures.volume)}
- Answered 2xx: ${figures.successRate === null ? '-' : pct(figures.successRate)}
- Median time: ${figures.p50Ms === null ? '-' : ms(figures.p50Ms)}

These are the numbers from the check. The other periods and the chart are not available right now.`;

const callsList = (siteUrl: string, calls: ApiResult<CallsPage>): string => {
  if (!calls.ok)
    return unavailable;
  const { value } = calls;
  if (value.calls.length === 0)
    return noCallsLine;

  const from = (value.page - 1) * value.size + 1;
  const to = Math.min(value.total, value.page * value.size);

  return `Page ${count(value.page)}, calls ${count(from)}–${count(to)} of ${count(value.total)}${value.totalCapped ? '+' : ''}. Newest first. Times are UTC.

| When | Paid with | Amount | Status |
|---|---|---|---|
${value.calls.map(call => `| ${call.at} | ${cell(paidWithName(call.paidWith))} | ${call.status === 'paid' ? usdOf(call.amount) : '$0'} | [${call.status === 'paid' ? 'Paid' : call.apiStatus === null ? 'free' : `${call.apiStatus} free`}](${siteUrl}/calls/${call.id}) |`).join('\n')}`;
};

// Where the endpoint's service is, or why there is no page for it yet
const serviceLine = (siteUrl: string, check: PayableCheck): string =>
  check.listed && isHost(check.host) ? `Its service page: ${siteUrl}${servicePath(check.host)}` : unlistedLine;

const payable = (settings: SiteSettings, check: PayableCheck, data: CheckData): string => {
  const { params } = data;
  const fallen = data.stats !== undefined && !data.stats.ok && check.stats !== null;
  const probed = check.method === 'GET' ? '' : `${check.method} `;
  const lines = pathLines(check);
  const description = describedAs(check.asks);
  const rows = askRows(check);

  return `# ${probed}${check.host}${check.path}

Payable through Anyfare.${lines.length === 0 ? '' : ` ${lines.join(' ')}`}${check.checkedAt === undefined ? '' : ` Checked at ${check.checkedAt}${check.ms === undefined ? '' : `, ${ms(check.ms)}`}.`}

${serviceLine(settings.siteUrl, check)}

## What the API asks

${asksSentence(check).plain}
${rows.map(row => `\n- ${row.label}: ${oneLine(row.value)}`).join('')}${description === undefined ? '' : `\n\nIts own description: "${oneLine(description)}"`}

## Pay it through Anyfare
${quote(check)}
- Link: ${check.link}

${payWith(check)}

Put ${settings.payUrl}/ in front of any paid link. The price that counts is the one the API asks at call time.

## Through Anyfare, ${fallen ? periodName('30d') : periodName(params.period)}

${data.stats === undefined ? unavailable : fallen ? checkNumbers(check.stats!) : numbers(data.stats)}

## Last calls

${data.calls === undefined ? unavailable : callsList(settings.siteUrl, data.calls)}
`;
};

/**
 * `/check.md?url=`: the check of the link as the pay host answered, with this endpoint's numbers and its
 * last calls. A link that can't be paid says its reason. The twin's status is the check's: 200 for an
 * answer, the pay host's own for a refusal such as the limit, and 503 when the pay host didn't answer.
 */
export const checkMarkdown = (settings: SiteSettings, data: CheckData): { readonly status: number; readonly body: string } => {
  const { state, params } = data;
  if (state.kind === 'empty') {
    return {
      status: 200,
      body: `# ${titleFor('')}\n\n> ${checkDescription}\n\n${emptyLine} Ask as ${settings.siteUrl}/check.md?url=<link>\n`,
    };
  }
  if (state.kind === 'unavailable')
    return { status: 503, body: `# ${titleFor(params.url, params.method)}\n\n${unavailableLine}\n` };
  if (state.kind === 'own') {
    const payHost = new URL(settings.payUrl).host;
    const next = state.inner === '' ? '' : ` Ask as ${settings.siteUrl}${checkAddress({ ...params, url: state.inner }, '/check.md')}`;

    return { status: 200, body: `# ${titleFor(params.url, params.method)}\n\n${ownPayTitle}. ${ownPayLine(payHost)}${next}\n` };
  }
  if (state.kind === 'refused') {
    const { title, text } = refusalWords(state.refusal, params.method);
    const { host, path } = linkParts(params.url);
    const shown = host === '' ? cut(oneLine(params.url), 120) : `${host}${path}`;
    const method = state.refusal.method ?? knownMethod(params.method);
    const lines = pathLines(state.refusal, true);

    return {
      status: state.status,
      body: `# ${shown === '' ? titleFor('') : `${method === undefined || method === 'GET' ? '' : `${method} `}${shown}`}\n\nNot payable: ${title}. ${text}${lines.length === 0 ? '' : ` ${lines.join(' ')}`}${offersPost(state.refusal, params.method) ? ` ${tryPostLine} Ask as ${settings.siteUrl}${checkAddress({ ...params, method: 'POST' }, '/check.md')}` : ''}\n\nReason: \`${state.refusal.reason}\`\n\nAnyfare checks paid links only. Send the link of one paid endpoint, the one that answers 402.\n`,
    };
  }

  return { status: 200, body: payable(settings, state.check, data) };
};
