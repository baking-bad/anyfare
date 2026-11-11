import { answerJson, endpoints, endpointUrl, groupOrder, groupTitles, type Endpoint } from './endpoints';
import { errorDocs } from './errors';
import { curlById, exampleLink, type Hosts } from './examples';
import { agentLinks } from './links';
import { topupStates } from './topups';

// `/llms-full.txt`: everything an agent needs in one file. It is built from the endpoint list, the error list and the
// examples, the same ones the For agents page reads.

const fence = (text: string, language = ''): string => `\`\`\`${language}\n${text}\n\`\`\``;

const methodLabel = (endpoint: Endpoint): string => endpoint.method === 'ANY' ? 'ANY' : endpoint.method === 'SSE' ? 'GET' : endpoint.method;

const endpointSection = (hosts: Hosts, endpoint: Endpoint): string => {
  const lines = [
    `### ${methodLabel(endpoint)} ${endpoint.path} (${endpoint.host === 'pay' ? 'pay host' : 'API host'})`,
    '',
    `${endpoint.summary}.`,
    '',
    `- Address: ${endpointUrl(hosts, endpoint)}`,
    `- Who may call it: ${endpoint.who}`,
    ...(endpoint.request ?? []).map(line => `- ${line}`),
  ];
  if (endpoint.example !== undefined)
    lines.push('', fence(curlById(hosts, endpoint.example), 'sh'));
  const json = answerJson(hosts, endpoint);
  if (json !== undefined)
    lines.push('', `Answer, ${endpoint.answer.status}:`, '', fence(json, 'json'));
  else if (endpoint.answer.text !== undefined)
    lines.push('', `Answer, ${endpoint.answer.status}${endpoint.answer.headers === undefined ? '' : `, ${Object.entries(endpoint.answer.headers).map(([name, value]) => `${name}: ${value}`).join(', ')}`}:`, '', fence(endpoint.answer.text));
  for (const note of endpoint.notes ?? [])
    lines.push('', note);
  lines.push('', `Errors: ${endpoint.errors.join(', ')}.`);

  return lines.join('\n');
};

// The combined 402 as the pay host builds it. The values are shortened: a real answer holds one option per network.
const challengeBody = ({ payUrl, apiUrl }: Hosts): string => JSON.stringify({
  x402Version: 2,
  error: 'Payment required',
  resource: { url: `${payUrl}/${exampleLink}`, description: `${exampleLink}, through Anyfare` },
  accepts: [
    { scheme: 'exact', network: 'eip155:8453', asset: '0x…', amount: '10000', payTo: '0x…', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'solana:…', asset: '…', amount: '10000', payTo: '…', maxTimeoutSeconds: 300, extra: { feePayer: '…' } },
    { scheme: 'exact', network: 'near:mainnet', asset: '…', amount: '10000', payTo: '…', maxTimeoutSeconds: 300, extra: {} },
  ],
  credits: {
    price: '0.01',
    currency: 'USD',
    authorization: 'Bearer <payment key>',
    signup: { method: 'POST', url: `${apiUrl}/v1/accounts` },
    topUp: { method: 'POST', url: `${apiUrl}/v1/topups`, options: `${apiUrl}/v1/topups/options` },
  },
}, null, 2);

const challengeHeaders = ({ payUrl }: Hosts): string => `HTTP/1.1 402 Payment Required
content-type: application/json
cache-control: no-store
payment-required: <base64 of the JSON below without "credits">
www-authenticate: Payment id="…", realm="${new URL(payUrl).host}", method="tempo", intent="charge", request="<base64>", expires="…"`;

const errorTable = errorDocs.map(error => `- ${error.status} ${error.code} (${error.host === 'both' ? 'both hosts' : error.host === 'pay' ? 'pay host' : 'API host'}): ${error.action}`).join('\n');

const stateTable = topupStates.map(state => `- ${state.status}${state.final ? ' (final)' : ''}: ${state.meaning}`).join('\n');

/** `/llms-full.txt` */
export const fullGuide = (hosts: Hosts): string => {
  const { siteUrl, apiUrl, payUrl, consoleUrl } = hosts;
  const links = agentLinks(hosts);
  const curl = (id: string): string => curlById(hosts, id);
  const groups = groupOrder.map(group => `## ${groupTitles[group]}\n\n${endpoints.filter(endpoint => endpoint.group === group).map(endpoint => endpointSection(hosts, endpoint)).join('\n\n')}`).join('\n\n');

  return `# Anyfare: everything an agent needs

> Anyfare is a payment router for AI agents. Put the pay host in front of the link of any x402 or MPP API and pay it from the chain you are on, or with a payment key against a balance of Credits. You pay only for calls the API answered with 2xx. The short guide is ${links.llms}. This file holds every endpoint, request and answer, the 402, the errors and the limits.

## Hosts

- Pay host: ${payUrl}. A routed call is ${payUrl}/<host>/<path>: the API's link without https://. Also GET /_/check and GET /_/key.
- API host: ${apiUrl}. Sign up, payment keys, top-ups, and public reads of calls, receipts and numbers.
- Website: ${siteUrl}. Every page has a Markdown twin: add .md to its URL, or ask for it with Accept: text/markdown.
- Console: ${consoleUrl}. For people: the sign-in, top-ups and keys with a screen.
- OpenAPI, for code generators: ${links.openapi.api} and ${links.openapi.pay}.
- Agent skill: ${links.skill}.

## Keys

- The master key controls the account. It starts with afm_live_ and works on the API host only. It is shown once, at sign-up, and a lost one can't be recovered: the account is lost with it.
- A payment key pays calls. It starts with af_live_, works on the pay host only, and is shown once. It has limits the master key sets. Give an agent a payment key, never the master key.
- Send either as Authorization: Bearer <key>. A key of the wrong kind answers 401 wrong_key_type.
- Keep keys in a file only the user can read. Never print them, paste them into a chat, put them in a URL, or log them.

## What to ask your user

Ask before you sign up, before you make a payment key (and agree its limits), before you top up, and before you pay a price above the key's limit. Never raise a limit on your own.

## Start: check, sign up, make a key, call

1. Check a link. Free, no key, and it pays nothing:

${fence(curl('check'), 'sh')}

Some APIs ask for payment only on POST. A GET check of such a link answers "payable": false with the reason "not_payable": check it again with \`&method=POST\` and the header \`X-Anyfare-Check: 1\`. The header is there so that a plain link can't make Anyfare send a POST to an API: without it the answer is 400. For example, an API that asks only on POST:

${fence(curl('check-post'), 'sh')}

2. Sign up. The answer has "masterKey" and "freeCredits": a new account may get free Credits, and the answer says how much ("0" when none). The command writes the answer to anyfare-account.json, which only the user can read (umask 077). "masterKey" is shown once. (The sign-up endpoint below has the same request without the file.)

${fence(`umask 077\n${curl('signup-to-file')}`, 'sh')}

3. Make a payment key with limits (see "Payment key limits"). "key" is shown once:

${fence(`ANYFARE_MASTER_KEY=$(jq -r .masterKey anyfare-account.json)\n${curl('make-key')}`, 'sh')}

4. Call. A 2xx answer is charged and carries the receipt header; any other answer is free:

${fence(curl('paid-call'), 'sh')}

5. Read the receipt: GET ${apiUrl}/v1/calls/<id>, with the id from the header. Read what is left on the key: GET ${payUrl}/_/key.

${groups}

## The 402

A call to ${payUrl}/<host>/<path> with no payment answers 402 with every way to pay at once. It is never cached. The headers:

${fence(challengeHeaders(hosts))}

The body is JSON. "accepts" holds the x402 options (the same list is in the PAYMENT-REQUIRED header, in base64), "credits" says how to pay with a key, and the WWW-Authenticate: Payment header holds the MPP charge on Tempo. Amounts in "accepts" are in the token's smallest unit (USDC has 6 decimals, so 10000 is $0.01). The values below are shortened:

${fence(challengeBody(hosts), 'json')}

The price is the same on every chain. Retry the same call (same method, path, query and body) with exactly one way to pay. Two at once answer 400 multiple_payment_methods.

### Pay with a payment key

Send Authorization: Bearer af_live_… . The balance is held when the call starts, taken after a 2xx answer, and released otherwise.

### Pay with x402 (USDC on NEAR, Base or Solana)

1. Pick an option in "accepts". Sign it with an x402 v2 client for its network, "exact" scheme. Hand the option back as it is, "extra" included.
2. Send the same call with PAYMENT-SIGNATURE: <base64 payment payload> (X-PAYMENT, the v1 header, is read too).
3. Sign it valid for at least 15 seconds, and no longer than maxTimeoutSeconds. A signed payment can be used once.
4. On NEAR, a payer has one payment in flight at a time: wait for it to settle before the next.
5. A 2xx answer settles your payment and carries PAYMENT-RESPONSE (base64 settlement, with the transaction). Any other answer settles nothing.

### Pay with MPP (USDC.e on Tempo)

1. Read the charge in WWW-Authenticate: Payment. It is bound to the pay host and has an expiry.
2. Sign a Tempo transaction for it in pull mode (an mppx client does this). Do not broadcast it: Anyfare does, after the API answers 2xx. A transaction you broadcast yourself is refused.
3. Send the same call at once with Authorization: Payment <credential>. The transaction must stay valid for at least 15 seconds.
4. A 2xx answer carries Payment-Receipt.

### The receipt header

- Payment key: Anyfare-Receipt: id="pay_…", amount="0.01", currency="USD". The id is the call's id: ${apiUrl}/v1/calls/<id> is its public receipt, and ${siteUrl}/calls/<id> its page.
- x402: PAYMENT-RESPONSE. MPP: Payment-Receipt. Their calls are listed in GET ${apiUrl}/v1/calls, filterable by host and endpoint.

## Payment key limits

Set when the key is made, changed with PATCH ${apiUrl}/v1/keys/<id>. They live in Anyfare's database: an agent can't talk its way past them.

- dailyBudget: USD the key may spend in a UTC day. Over it: 402 key_budget_exceeded until 00:00 UTC. Default when you give none.
- maxPrice: the highest price of one call. A dearer call: 402 key_price_limit. No limit when it is null.
- allowance: USD the key may spend in all. Spent: 402 key_allowance_exceeded. No limit when it is null.
- expiresAt: after it the key answers 401 invalid_key. Never when it is null.
- label: a name, at most 60 characters.
- Every key spends from the account's one balance. GET ${payUrl}/_/key shows "remaining" for the key and the balance. Revoking a key (DELETE) stops it at once.

## Top-ups

Send any token from any chain a swap service supports to a deposit address, and the Credits arrive as USDC on NEAR.

1. GET ${apiUrl}/v1/topups/options lists the networks, their tokens, and the least to send (minimum, in USD). The list changes: read it each time.
2. POST ${apiUrl}/v1/topups with network, token and amount (master key). Ask your user first.
3. Send at least "sendAtLeast" of the token to "depositAddress" (with "depositMemo" when it is not null) before "payBy". Less than that is "incomplete": send the rest. Do not send after "payBy": the address expires.
4. Poll GET ${apiUrl}/v1/topups/<id> every few seconds until "status" is final. "credited" is the USD added to the balance.

${fence(stateTable)}

There is no list of top-ups: keep the id.

## The public reads

No key. Any origin may read them. Each is limited per address: a 429 comes with Retry-After. They never name a Credits buyer: "payer" is null for Credits, and the receipt never shows a query string, a body or a header of a routed call.

- Calls and receipts: GET ${apiUrl}/v1/calls, GET ${apiUrl}/v1/calls/stream, GET ${apiUrl}/v1/calls/<id>.
- Numbers: GET ${apiUrl}/v1/stats, /v1/stats/live, /v1/stats/top, /v1/services, /v1/services/<host>, /v1/endpoints/stats.
- Services agents paid, as a catalog with prices: GET ${apiUrl}/v1/catalog.
- Pages with a Markdown twin: ${siteUrl}/services.md, ${siteUrl}/calls.md, ${siteUrl}/check.md?url=<link>, ${siteUrl}/calls/<id>.md.

## Errors

Every error is {"error": {"code": "...", "message": "..."}}. 401 carries WWW-Authenticate: Bearer. 429 carries Retry-After.

${errorTable}

## Limits

Requests are limited per address: sign-ups, checks, calls with no payment, public reads, streams and top-ups. Over a limit the answer is 429 rate_limited with Retry-After: wait that many seconds and send it again. A payment key has its own limit of calls per minute. Do not retry in a loop.

## Money

Amounts are USD decimal strings, such as "0.01", with at most 6 decimals. Times are ISO 8601 UTC. Days are UTC days. The numbers in the answers above are examples, and every key, address and id in them is a placeholder.
`;
};
