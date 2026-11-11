import type { SiteSettings } from '../config';
import { curlById } from './examples';
import { agentLinks } from './links';

type Hosts = Pick<SiteSettings, 'siteUrl' | 'apiUrl' | 'payUrl' | 'consoleUrl'>;

/**
 * `/llms.txt`: the short guide an agent reads first. Plain text in the llms.txt form: a title, a quote line, then
 * sections of links and steps. The commands are the ones in examples.ts.
 */
export const platformGuide = (hosts: Hosts): string => {
  const { siteUrl, apiUrl, payUrl, consoleUrl } = hosts;
  const links = agentLinks(hosts);
  const curl = (id: string): string => curlById(hosts, id);

  return `# Anyfare

> Anyfare is a payment router for AI agents. Put the pay host in front of the link of any x402 or MPP API and pay it from the chain you are on, or with a payment key against a balance of Credits. You pay only for calls the API answered with 2xx.

## Hosts

- Pay: ${payUrl}. A routed call is ${payUrl}/<host>/<path>: the API's link without https://.
- API: ${apiUrl}. Sign up, payment keys, top-ups, and public reads of calls and numbers.
- Website: ${siteUrl}. Every page has a Markdown twin: add .md to its URL.
- Console: ${consoleUrl}. For people.

## Rules

- Ask your user before you sign up, make a key, or top up.
- Keep the master key in a file only the user can read. Never print it, paste it into a chat, or put it in a URL.
- Pay with a payment key, never the master key. The master key works on the API host only.

## Steps

1. Check a link. Free, no key. "payable": true comes with the price and our quote. A link that asks for payment only on POST is "not_payable" to this GET check: add \`&method=POST\` and the header \`X-Anyfare-Check: 1\` to the check:

\`\`\`sh
${curl('check-post')}
\`\`\`

\`\`\`sh
${curl('check')}
\`\`\`

2. Sign up. A new account may get free Credits: the answer says how much. "masterKey" is shown once: the command saves the answer to anyfare-account.json, which only the user can read.

\`\`\`sh
umask 077
${curl('signup-to-file')}
\`\`\`

3. Make a payment key with the limits your user sets. "key" is shown once: save it as ANYFARE_PAYMENT_KEY.

\`\`\`sh
ANYFARE_MASTER_KEY=$(jq -r .masterKey anyfare-account.json)
${curl('make-key')}
\`\`\`

4. Call. Only a 2xx answer is charged, and it carries Anyfare-Receipt: id="pay_...". Read the receipt at ${apiUrl}/v1/calls/<id>.

\`\`\`sh
${curl('paid-call')}
\`\`\`

5. No account, a wallet instead. A call with no payment answers 402 with every way to pay: the JSON body and the PAYMENT-REQUIRED header list x402 options (USDC on NEAR, Base or Solana), the WWW-Authenticate: Payment header holds the MPP charge (USDC.e on Tempo), and "credits" says how to use a key. Pay one option and send the same call again with PAYMENT-SIGNATURE (x402) or Authorization: Payment (MPP). Your payment settles only after a 2xx answer. Each option, step by step: ${links.llmsFull}, section "The 402".

6. Top up with any token NEAR Intents takes. GET ${apiUrl}/v1/topups/options lists networks, tokens and minimums. POST ${apiUrl}/v1/topups with network, token and amount (master key) answers a deposit address. Send there, then read GET ${apiUrl}/v1/topups/<id> until status is credited.

7. Before you spend: GET ${payUrl}/_/key with the payment key shows its limits and what is left. On 402 insufficient_balance ask your user to top up. On 402 key_budget_exceeded or key_price_limit ask before you raise a limit. On 429 wait Retry-After seconds. On 503 nothing was charged.

## Read more

- [Every endpoint, request and answer](${links.llmsFull}): llms-full.txt, with the 402, the errors and the limits
- [Agent skill](${links.skill}): the steps above as a skill to install
- [OpenAPI, API host](${links.openapi.api})
- [OpenAPI, pay host](${links.openapi.pay})
- [For agents](${links.page}): the same, with the API as a table. Twin: ${links.twin}
- [Services](${siteUrl}/services.md): the services agents paid, and [calls](${siteUrl}/calls.md), newest first
- [Check a link](${siteUrl}/check.md?url=<link>): the check, with the numbers of the API behind it
- A call's receipt: ${siteUrl}/calls/<id>.md or ${apiUrl}/v1/calls/<id>
`;
};
