import type { SiteSettings } from '../config';
import { curlById } from './examples';
import { agentLinks, skillName } from './links';

type Hosts = Pick<SiteSettings, 'siteUrl' | 'apiUrl' | 'payUrl' | 'consoleUrl'>;

export interface AgentSkill {
  readonly name: string;
  readonly description: string;
  readonly body: (hosts: Hosts) => string;
}

const buyer: AgentSkill = {
  name: skillName,
  description: 'Pay for API calls through Anyfare with a payment key that has limits, or from a wallet over x402 or MPP. Use when the user wants an agent to call a paid API, to check what a paid link costs, to sign up for Anyfare, to top up, to make a payment key, or to check spending.',
  body: hosts => {
    const { siteUrl, apiUrl, payUrl, consoleUrl } = hosts;
    const links = agentLinks(hosts);
    const curl = (id: string): string => curlById(hosts, id);

    return `# Anyfare for buyers

Anyfare pays any x402 or MPP API for you. Put ${payUrl}/ in front of the API's link, without https://, and call it with a payment key. You pay the API's price and only for a 2xx answer. The full reference, every endpoint and error: ${links.llmsFull}

Rules, always:

- Ask the user before you sign up, make a key, top up, or spend above a limit.
- Keep the master key in anyfare-account.json, readable only by the user. Never print it, paste it into a chat, put it in a URL, or log it.
- Call with a payment key (ANYFARE_PAYMENT_KEY), never the master key (ANYFARE_MASTER_KEY).
- Never raise a limit on your own.

## 1. Check the link

Free, no key, and it pays nothing. Do it before the first call to any API.

\`\`\`sh
${curl('check')}
\`\`\`

"payable": true comes with "price" (what the API asks) and "quote" (what you pay). A paid link you check joins the list of services, as checked, until someone pays it. If the quote is above what the user allowed, ask. "payable": false has a "reason" and a "message". When the reason is "not_payable" for a link the user says is paid, it may ask only on another method: the check takes method (GET, POST, PUT, PATCH or DELETE; left out, it tries GET, then POST), and every method but GET needs the header X-Anyfare-Check: 1. "exampleBody" is the API's own example body, or null, and "tried" lists the tries. Otherwise use another API.

A check with POST:

\`\`\`sh
${curl('check-post')}
\`\`\`

## 2. Find a key, or sign up

Look for ANYFARE_PAYMENT_KEY in the environment, or anyfare-account.json in the working directory. If you have a payment key, go to step 4.

With no key at all, ask the user: "I need an Anyfare account to pay for this. May I sign up? A new account may get free Credits to try." If they agree:

\`\`\`sh
umask 077
${curl('signup-to-file')}
\`\`\`

The file holds "masterKey" and "freeCredits", the free Credits of this sign-up in USD ("0" when none). Tell the user what the account got. Tell them the master key is in anyfare-account.json, and that a lost master key can't be recovered, so they should keep a copy. Do not print the file.

## 3. Make a payment key with limits

Agree the limits with the user first: a daily budget (USD per UTC day), a highest price per call, and if they want, an allowance (USD in all) and an end time. Then:

\`\`\`sh
ANYFARE_MASTER_KEY=$(jq -r .masterKey anyfare-account.json)
${curl('make-key')}
\`\`\`

The answer's "key" is shown once. Store it as ANYFARE_PAYMENT_KEY in a file only the user can read, and keep "id" (in the answer of making a key, and of listing keys) as ANYFARE_KEY_ID. Do not print the key. Change limits with the user's leave:

\`\`\`sh
${curl('change-key')}
\`\`\`

Revoke a key the user no longer wants:

\`\`\`sh
${curl('revoke-key')}
\`\`\`

## 4. Call

\`\`\`sh
${curl('paid-call')}
\`\`\`

A 2xx answer is yours and costs the price. It carries Anyfare-Receipt: id="pay_…", amount="0.01", currency="USD". Any other answer costs nothing. Pass the API's query, body and headers as you would to the API itself.

## 5. Read the receipt and what is left

Set ANYFARE_CALL_ID to the id in the receipt header.

\`\`\`sh
${curl('receipt')}
\`\`\`

How much the key may still spend, and the balance:

\`\`\`sh
${curl('key-status')}
\`\`\`

"remaining.dailyBudget", "remaining.allowance" (null when there is no limit) and "remaining.balance" are in USD. Tell the user when the balance is low.

## 6. When a call fails

Every error is {"error": {"code", "message"}}.

- 402 insufficient_balance: the balance does not cover the price. Ask the user to top up (step 7).
- 402 key_budget_exceeded: the daily budget is spent. It resets at 00:00 UTC. Ask the user before you raise it.
- 402 key_allowance_exceeded: the key's allowance is spent. Ask for a new key or a higher allowance.
- 402 key_price_limit: the price is above the key's highest price per call. Ask before you raise it.
- 401 invalid_key: the key is revoked, expired, or wrong. Ask the user for a new one.
- 401 wrong_key_type: you sent the master key to the pay host, or a payment key to the API host.
- 400 host_not_allowed, 400 not_payable: Anyfare can't route to this API. Use another.
- 429 rate_limited: wait Retry-After seconds, then send it again once.
- 502 or 503: nothing was charged. Retry once after a few seconds. If it fails again, tell the user.

## 7. Top up (ask the user first)

The user pays; you only ask for an address. List what a top-up takes, then ask for an address and tell the user where to send:

\`\`\`sh
${curl('topup-options')}
\`\`\`

\`\`\`sh
${curl('topup')}
\`\`\`

Tell the user to send at least "sendAtLeast" of "token" on "network" to "depositAddress" (with "depositMemo" when it is not null) before "payBy". Then read it until "status" is "credited", or a final state ("expired", "failed", "refunded", "quote_failed", "quote_unknown"):

\`\`\`sh
${curl('topup-status')}
\`\`\`

The people's page: ${consoleUrl}/topup. Keep it for a user who prefers to top up by hand.

## 8. Without an account

An agent with its own wallet needs no account. A call with no payment answers 402 with the ways to pay: x402 on NEAR, Base or Solana, and MPP on Tempo. How to pay each: ${links.llmsFull}

## More

- Short guide: ${links.llms}
- OpenAPI: ${links.openapi.api} and ${links.openapi.pay}
- The calls and services others paid, with a Markdown twin: ${siteUrl}/services.md
- The API's base: ${apiUrl}
`;
  },
};

export const agentSkills: readonly AgentSkill[] = [buyer];

/** A skill by its name, or undefined. */
export const findSkill = (name: string): AgentSkill | undefined => agentSkills.find(skill => skill.name === name);

/** The skill as a SKILL.md document: the front matter an agent needs, then the steps. */
export const skillDocument = (skill: AgentSkill, hosts: Hosts): string => `---
name: ${skill.name}
description: ${skill.description}
---

${skill.body(hosts)}`;
