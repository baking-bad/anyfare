import type { Method } from './api';
import type { ConsolePageName } from './pages';

// The console's Agent view: the requests behind the open page, as an agent makes them. The console has no Markdown
// twin: it is behind the master key. A command names the key as `$ANYFARE_MASTER_KEY` and never holds a real one.
// A page that is built adds its requests here.

export interface ConsoleRequest {
  readonly method: Method;
  // The path on the API, with its query
  readonly path: string;
  // What it does or answers, in a few words
  readonly note: string;
  // The JSON text of the body
  readonly body?: string;
  // False for a request that needs no key
  readonly keyed: boolean;
}

export interface AgentPage {
  readonly title: string;
  // What an agent does on this page, when it says more than the requests
  readonly lead?: string;
  readonly requests: readonly ConsoleRequest[];
}

export const consoleAgentPages: Readonly<Record<ConsolePageName, AgentPage>> = {
  signin: {
    title: 'Console: sign in',
    lead: 'An agent makes an account with one request: no key, no body. The answer has the master key, once. The agent keeps it for its person, and makes itself a payment key with it.',
    requests: [
      { method: 'POST', path: '/v1/accounts', note: 'Makes an account. No key and no body. The answer has the master key, once', keyed: false },
      { method: 'GET', path: '/v1/account', note: 'Checks a master key: 200 when it works', keyed: true },
    ],
  },
  overview: {
    title: 'Console: overview',
    requests: [
      { method: 'GET', path: '/v1/balance', note: 'The balance: available, and held for calls in flight', keyed: true },
      { method: 'GET', path: '/v1/keys', note: 'Every key of the account, with what each spent today. The sum of spent.today is the day\'s spend', keyed: true },
      { method: 'GET', path: '/v1/payments?limit=5', note: 'The last 5 calls, newest first', keyed: true },
      { method: 'GET', path: '/v1/topups?limit=5', note: 'The last 5 top-ups, newest first. 503 topups_unavailable when top-ups are off', keyed: true },
    ],
  },
  keys: {
    title: 'Console: keys',
    lead: 'An agent makes its own payment key with the master key, once. The answer holds the key, shown once: the agent keeps it, and the master key stays with its person.',
    requests: [
      { method: 'GET', path: '/v1/keys', note: 'Every key of the account, revoked ones too, with its limits and what it spent', keyed: true },
      { method: 'POST', path: '/v1/keys', note: 'Makes a key. Every field is optional. The answer holds the payment key, once', body: '{"label":"my agent","dailyBudget":"5.00","maxPrice":"0.05","allowance":"20.00","expiresAt":"2026-12-31T23:59:59Z"}', keyed: true },
      { method: 'PATCH', path: '/v1/keys/<key id>', note: 'Changes limits. Send only what changes; null clears label, maxPrice, allowance or expiresAt', body: '{"dailyBudget":"10.00","maxPrice":null}', keyed: true },
      { method: 'DELETE', path: '/v1/keys/<key id>', note: 'Revokes a key. It stops at once, and calls in flight finish', keyed: true },
    ],
  },
  topup: { title: 'Console: top up', requests: [] },
  payments: {
    title: 'Console: payments',
    requests: [
      { method: 'GET', path: '/v1/payments?limit=20', note: 'The account\'s calls, newest first. Add after=<next> for the next page, state=paid|free|pending, keyId=<key id>, service=<host>', keyed: true },
      { method: 'GET', path: '/v1/keys', note: 'The keys, for the names of the key filter', keyed: true },
    ],
  },
  settings: {
    title: 'Console: settings',
    requests: [
      { method: 'GET', path: '/v1/account', note: 'The account id, and when it was made', keyed: true },
      { method: 'POST', path: '/v1/account/master-key/rotate', note: 'A new master key, once. The old one stops at once', keyed: true },
    ],
  },
};

/** What the Agent view says about the console. */
export const consoleAgentNote = 'The console has no Markdown twin: it is behind the master key. An agent does each step of this page with one request to the Anyfare API, with the master key in Authorization.';

// A URL with a character the shell reads is quoted
const shellUrl = (url: string): string => /[?&$<> ]/.test(url) ? `"${url}"` : url;

/** One request as a `curl` command, one option to a line. */
export const curlOfRequest = (apiUrl: string, { method, path, body, keyed }: ConsoleRequest): string => {
  const first = ['curl', ...method === 'GET' ? [] : ['-X', method], shellUrl(`${apiUrl}${path}`)].join(' ');
  const options = [
    ...keyed ? ['-H "Authorization: Bearer $ANYFARE_MASTER_KEY"'] : [],
    ...body === undefined ? [] : ['-H "Content-Type: application/json"', `-d '${body}'`],
  ];

  return [first, ...options.map(option => `  ${option}`)].join(' \\\n');
};

/** A page's requests as `curl` commands, a blank line between two. */
export const curlOfPage = (apiUrl: string, page: ConsolePageName): string =>
  consoleAgentPages[page].requests.map(request => curlOfRequest(apiUrl, request)).join('\n\n');
