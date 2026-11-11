import type { AgentRequest } from '../components/AgentView';
import { endpoints, endpointUrl, groupOrder, groupTitles, type Endpoint } from './endpoints';
import { curlById, type Hosts } from './examples';
import { agentLinks } from './links';

// The words of the For agents page, and what an agent gets of it. The page and its Markdown twin both read them.

export const agentsTitle = 'For agents';

export const agentsDescription = 'Your agent can sign up, top up, make a payment key and pay any x402 or MPP API with plain HTTP requests. Start from llms.txt.';

export const hero = {
  eyebrow: 'For agents',
  line: 'Your agent can do all of this without you.',
  lead: 'Sign up, top up, make a key, find an API, pay it. Every step is one HTTP request. Every page on this site has a Markdown twin. You keep the master key and set the limits.',
  promptLabel: 'Give this to your agent',
  wallet: 'Or, if your agent has its own wallet: it needs nothing from us. It pays our 402 in USDC on NEAR, Base or Solana, or over MPP on Tempo.',
} as const;

export const startText = {
  heading: 'Start in four requests',
  lead: 'Each request runs as written. Keys and ids in the answers are placeholders: yours come from the answers.',
} as const;

export const apiText = {
  heading: 'The API',
  lead: 'Two hosts. The pay host takes payment keys, or an x402 or MPP payment. The API host takes the master key. Public reads need no key.',
} as const;

export const llmsText = {
  heading: 'llms.txt',
  lead: 'The guide an agent reads first. Plain text, with absolute links.',
} as const;

/** The cards under the hero. `href` is the real file. */
export const fileCards = (hosts: Hosts) => {
  const links = agentLinks(hosts);

  return {
    llms: { title: '/llms.txt', text: 'How it works and how to start. The first thing to read', href: links.llms },
    skill: { title: 'Agent skill', text: '/skills/anyfare-buyer/SKILL.md, step by step', href: links.skill },
    openapi: { title: '/openapi.json', text: 'The two APIs, for code generators', api: links.openapi.api, pay: links.openapi.pay },
    twin: { title: 'Any page + .md', text: 'Or Accept: text/markdown. Same data, no HTML', href: links.twin },
  } as const;
};

/** The four requests of "Start in four requests". */
export interface StartStep {
  readonly number: number;
  readonly title: string;
  readonly optional?: boolean;
  // The id of the example that runs it
  readonly example: string;
  // The shape of the answer, as the page shows it under the command
  readonly answer: string;
  readonly note: string;
}

export const startSteps = (hosts: Hosts): readonly StartStep[] => [
  {
    number: 1, title: 'Sign up', example: 'signup',
    answer: '{ "id": "<account id>", "masterKey": "afm_live_…", "freeCredits": "0.1", … }',
    note: 'Save the master key where only your user can read it. A new account may get free Credits to try: "freeCredits" says how much.',
  },
  {
    number: 2, title: 'Make a payment key with limits', example: 'make-key',
    answer: '{ "id": "<key id>", "dailyBudget": "5", "maxPrice": "0.05", …, "key": "af_live_…" }   shown once',
    note: 'The agent calls with this key, never with the master key.',
  },
  {
    number: 3, title: 'Top up with any token', optional: true, example: 'topup',
    answer: '{ "id": "<top-up id>", "status": "waiting", "depositAddress": "<deposit address>", "sendAtLeast": "19.9", "payBy": "…", … }',
    note: `Send at least "sendAtLeast" to "depositAddress" before "payBy", then read GET ${hosts.apiUrl}/v1/topups/<id> until "status" is "credited". The networks and tokens: GET ${hosts.apiUrl}/v1/topups/options.`,
  },
  {
    number: 4, title: 'Call any paid API', example: 'paid-call',
    answer: '200 OK  Anyfare-Receipt: id="pay_…", amount="0.01", currency="USD"',
    note: `Check first, free: GET ${hosts.payUrl}/_/check?url=<link>. Left on the key: GET ${hosts.payUrl}/_/key.`,
  },
];

/** The API table's rows, grouped in the order of the page. */
export const endpointGroups = (): readonly { readonly group: string; readonly title: string; readonly endpoints: readonly Endpoint[] }[] =>
  groupOrder.map(group => ({ group, title: groupTitles[group], endpoints: endpoints.filter(endpoint => endpoint.group === group) }));

/** The three files an agent reads, as the Agent view's requests. */
export const agentsRequests = (hosts: Hosts): readonly AgentRequest[] => {
  const links = agentLinks(hosts);

  return [
    { method: 'GET', url: links.llms, note: 'The guide' },
    { method: 'GET', url: links.llmsFull, note: 'Every endpoint, request and answer' },
    { method: 'GET', url: links.skill, note: 'The buyer skill' },
  ];
};

/** The endpoint list as the Agent view's JSON. */
export const agentsJson = (hosts: Hosts): { readonly endpoints: readonly Record<string, unknown>[] } => ({
  endpoints: endpoints.map(endpoint => ({
    method: endpoint.method,
    host: endpoint.host,
    url: endpointUrl(hosts, endpoint),
    summary: endpoint.summary,
    auth: endpoint.who,
    state: 'built',
  })),
});

export { curlById };
