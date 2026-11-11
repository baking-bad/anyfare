import type { Receipt } from '../api/types';
import type { SiteSettings } from '../config';
import { paths } from '../api/endpoints';
import { usdOf } from '../format';
import { servicePath } from '../services/content';
import { callLine, chainName, explorerName, noApiLine, creditsLine, paidAmount, receiptTitle, safeExplorerUrl, seconds, sideLine, stepTime, stepWords, utcMoment, wouldHavePaid } from '../receipt/content';

// The receipt page as Markdown: the same facts as the page, from the same read. Transactions come whole,
// with their explorer link, for an agent to follow.

const transaction = (hash: string | null, explorerUrl: string | null): string => {
  if (hash === null)
    return '';
  const url = safeExplorerUrl(explorerUrl);

  return url === undefined ? `, tx ${hash}` : `, tx ${hash} on [${explorerName(url)}](${url})`;
};

/** `/calls/<id>.md`. */
export const receiptMarkdown = (settings: SiteSettings, receipt: Receipt): string => {
  const { buyer, api } = receipt;
  const credits = buyer.paidWith === 'credits';
  const paid = receipt.status === 'paid';
  const answered = receipt.apiStatus === null ? '' : ` The API answered ${receipt.apiStatus}${receipt.ms.api === null ? '' : ` in ${receipt.ms.api} ms`}.`;
  const buyerLine = credits
    ? `- Buyer: ${paid ? `paid ${sideLine(buyer)}. ${creditsLine}` : `was not charged. ${wouldHavePaid(buyer)}`}`
    : `- Buyer: ${buyer.payer === null ? '' : `${buyer.payer} `}${paid ? `paid ${sideLine(buyer)}` : `was not charged. ${wouldHavePaid(buyer)}`}${transaction(buyer.transaction, buyer.explorerUrl)}`;
  const steps = receipt.steps.map(({ step, at }) => {
    const words = stepWords(step, receipt);

    return `- ${stepTime(at)} UTC: ${words.title}${words.note === undefined ? '' : `. ${words.note}`}`;
  });

  return `# ${receiptTitle(receipt.id)}

- ${paid ? 'Paid' : 'Not charged'}: ${paidAmount(receipt)}.${answered}
- When: ${utcMoment(receipt.at)}${receipt.ms.total === null ? '' : `, ${seconds(receipt.ms.total)} end to end`}
- Service: [${receipt.service}](${settings.siteUrl}${servicePath(receipt.service)})
- Call: ${callLine(receipt)}
${buyerLine}
- API: ${api === null ? noApiLine : `we paid ${sideLine(api)} to ${receipt.service}${transaction(api.transaction, api.explorerUrl)}`}
- Route: ${chainName(buyer.paidWith)}${api === null ? '' : ` to ${chainName(api.paidWith)}`}
- API price: ${receipt.apiPrice === null ? '-' : usdOf(receipt.apiPrice)}
- Fee: ${receipt.fee === null ? '-' : usdOf(receipt.fee)}
${steps.length === 0 ? '' : `\n## Steps\n\n${steps.join('\n')}\n`}
The receipt as JSON: \`GET ${settings.apiUrl}${paths.call(receipt.id)}\`
`;
};

/** The twin of a receipt that can't be shown: no such call, or the API didn't answer. */
export const receiptUnavailableMarkdown = (): string => '# Not available\n\nWe couldn\'t load this receipt. Try again.\n';
