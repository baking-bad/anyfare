import type { ApiResult } from '../api/reader';
import type { Call, Period } from '../api/types';
import type { SiteSettings } from '../config';
import { agentPrompt, agentsText, hero, homeDescription, homeTitle, paidWithName, questions, statsText, topText, tryHref, tryLinks, ways } from '../content/home';
import { count, ms, usdOf } from '../format';
import { servicePath } from '../services/content';
import { withAllTimeAtLeast30Days } from '../home/allTime';
import { changeOf, formatChange } from '../home/change';
import type { HomeData } from '../home/data';

// The home page as Markdown: the same facts as the page, from the same reads. A section whose read
// failed says so and the rest stays.

const unavailable = 'Not available right now.';

const money = (value: string | null): string => usdOf(value);

const cell = (text: string): string => text.replaceAll('|', '\\|');

const callRow = (call: Call): string => {
  const amount = call.status === 'paid' ? money(call.amount) : `free${call.apiStatus === null ? '' : ` (${call.apiStatus})`}`;

  return `| ${call.at} | ${cell(call.service)} | ${cell(call.path)} | ${paidWithName(call.paidWith)} | ${call.apiPaidWith === null ? '-' : paidWithName(call.apiPaidWith)} | ${amount} | ${call.ms === null ? '-' : ms(call.ms)} |`;
};

const section = <TValue>(result: ApiResult<TValue>, render: (value: TValue) => string): string => result.ok ? render(result.value) : unavailable;

const periods: readonly { readonly id: Period; readonly label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
];

/** `/index.md` */
export const homeMarkdown = (settings: SiteSettings, data: HomeData): string => {
  const { siteUrl, payUrl, apiUrl } = settings;

  const live = section(data.live, ({ last24h, today }) => {
    const change = changeOf(last24h.volume, last24h.volumeBefore);

    return `- Paid through Anyfare in the last 24 hours: ${money(last24h.volume)}${change === null ? '' : ` (${formatChange(change)} against the 24 hours before)`}
- Paid calls today: ${count(today.calls)}`;
  });

  const lastCalls = section(data.calls, ({ calls }) => calls.length === 0
    ? 'No calls yet.'
    : `Newest first. Times are UTC.

| When | Service | Path | Buyer paid with | API was paid with | Amount | API time |
|---|---|---|---|---|---|---|
${calls.map(callRow).join('\n')}

Each call has its receipt at ${siteUrl}/calls/<id>. Every call: ${siteUrl}/calls`);

  const stats = section(data.stats, counted => {
    const value = withAllTimeAtLeast30Days(counted);

    return `${statsText.lead}

| Period | ${statsText.calls.label} | ${statsText.volume.label} | ${statsText.buyers.label} | ${statsText.services.label} |
|---|---|---|---|---|
${periods.map(({ id, label }) => `| ${label} | ${count(value.calls[id])} | ${money(value.volume[id])} | ${count(value.buyers[id])} | ${count(value.services[id])} |`).join('\n')}

### Paid calls per day, 30 days (UTC days)

${value.daily.every(day => day.calls === 0) ? 'No paid calls yet.' : `| Day | Paid calls |\n|---|---|\n${value.daily.map(day => `| ${day.day} | ${count(day.calls)} |`).join('\n')}`}

### How buyers paid, 30 days

${value.byPaidWith['30d'].length === 0 ? 'No paid calls yet.' : value.byPaidWith['30d'].map(share => `- ${paidWithName(share.paidWith)}: ${count(share.calls)} calls, ${money(share.volume)}`).join('\n')}

Details: ${siteUrl}/calls`;
  });

  const top = section(data.services, ({ services }) => services.length === 0
    ? 'No paid services yet.'
    : `${topText.lead}

| Service | Paid endpoints | Price from | Calls through Anyfare | Buyers | Volume |
|---|---|---|---|---|---|
${services.map(service => `| [${cell(service.host)}](${siteUrl}${servicePath(service.host)}) | ${count(service.paidEndpoints)} | ${money(service.priceFrom)} | ${count(service.calls)} | ${count(service.buyers)} | ${money(service.volume)} |`).join('\n')}

All services: ${siteUrl}/services`);

  return `# ${homeTitle}

> ${homeDescription}

${hero.lead}

## Check a link

\`GET ${payUrl}/_/check?url=<link>\`

Answers whether the link can be paid through Anyfare, what it asks, and what it costs. No payment is made and no sign-up is needed. On the website: ${siteUrl}/check?url=<link>

Some APIs ask for payment only on POST. Add \`&method=POST\` (GET is the default) to the check, on the website and on the pay host. On the pay host a POST check also needs the header \`X-Anyfare-Check: 1\`.

Try: ${tryLinks.map(link => `[${link.label}, ${link.note}](${siteUrl}${tryHref(link)})`).join(', ')}.

${hero.freeCredits}

## Live calls

${live}

### Last calls

${lastCalls}

## ${ways.heading}

${ways.lead} NEAR Intents moves our money between the two.

### ${ways.wallet.title}

${ways.wallet.text}

${ways.wallet.notes.map(note => `- ${note}`).join('\n')}

### ${ways.key.title}

${ways.key.text}

Top up: ${settings.consoleUrl}/topup. Make a key: ${settings.consoleUrl}/keys. The API is at ${apiUrl}.

## ${statsText.heading}

${stats}

## ${topText.heading}

${top}

## ${agentsText.heading}

${agentsText.lead.replace('Try Agent in the header.', 'Add `.md` to a page\'s URL, or ask for it with `Accept: text/markdown`.')}

\`\`\`
${agentPrompt(siteUrl)}
\`\`\`

For agents: ${siteUrl}/agents. The guide: ${siteUrl}/llms.txt

## Questions

${questions.map(({ q, a }) => `**${q}**\n${a}`).join('\n\n')}
`;
};
