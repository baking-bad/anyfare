import type { SiteSettings } from '../config';

// Every `curl` line the agent files and the For agents page show. They are written once, here, as data:
// the files and the page print them with `curlOf`, so they can't drift from this list. Each says what it
// expects, so a test against a local stack can run them in order.

/** The hosts the examples use. */
export type Hosts = Pick<SiteSettings, 'siteUrl' | 'apiUrl' | 'payUrl' | 'consoleUrl'>;

export interface CurlExample {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  // The JSON text of the body
  readonly body?: string;
  // Extra curl flags, such as `-i` to see the headers and `-N` to stream
  readonly flags?: readonly string[];
  // A file the answer is written to
  readonly saveTo?: string;
  // What the answer must be: its status, the top-level fields of its JSON, and the headers it must carry
  readonly expect: { readonly status: number; readonly fields: readonly string[]; readonly headers?: readonly string[] };
  // The shell variables the example reads, and so the values a runner must set
  readonly needs: readonly string[];
  // True when running it changes the account for good, such as a rotation or a revoke
  readonly destructive?: boolean;
}

/** An API that asks for payment only on POST, the one the home page's second link tries. */
export const exampleLinkPost = 'merchant-near.mikedotexe.com/v1/evidence/account';

/** The link the examples check and call: the one the home page offers to try. */
export const exampleLink = 'pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest';
// The same API with the query it needs for an answer
export const exampleCall = `${exampleLink}?symbol=BTC&convert=USD`;

const master = { authorization: 'Bearer $ANYFARE_MASTER_KEY' } as const;
const payment = { authorization: 'Bearer $ANYFARE_PAYMENT_KEY' } as const;
const json = { 'content-type': 'application/json' } as const;

const titleCase = (name: string): string => name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('-');

/** Every example, with the hosts of this deployment. */
export const curlExamples = ({ apiUrl, payUrl }: Hosts): readonly CurlExample[] => [
  { id: 'check', method: 'GET', url: `${payUrl}/_/check?url=${exampleLink}`, headers: {}, expect: { status: 200, fields: ['payable', 'target', 'price', 'quote', 'link'] }, needs: [] },
  {
    id: 'check-post', method: 'GET', url: `${payUrl}/_/check?url=${exampleLinkPost}&method=POST`, headers: { 'x-anyfare-check': '1' },
    expect: { status: 200, fields: ['payable', 'target', 'price', 'quote', 'link', 'method'] }, needs: [],
  },
  {
    id: 'unpaid', method: 'GET', url: `${payUrl}/${exampleCall}`, headers: {}, flags: ['-i'],
    expect: { status: 402, fields: ['x402Version', 'error', 'resource', 'accepts', 'credits'], headers: ['payment-required', 'www-authenticate'] }, needs: [],
  },
  {
    id: 'paid-call', method: 'GET', url: `${payUrl}/${exampleCall}`, headers: payment, flags: ['-i'],
    expect: { status: 200, fields: [], headers: ['anyfare-receipt'] }, needs: ['ANYFARE_PAYMENT_KEY'],
  },
  {
    id: 'key-status', method: 'GET', url: `${payUrl}/_/key`, headers: payment,
    expect: { status: 200, fields: ['id', 'label', 'allowance', 'dailyBudget', 'maxPrice', 'expiresAt', 'createdAt', 'spent', 'remaining'] }, needs: ['ANYFARE_PAYMENT_KEY'],
  },
  { id: 'signup', method: 'POST', url: `${apiUrl}/v1/accounts`, headers: {}, expect: { status: 201, fields: ['id', 'createdAt', 'masterKey', 'freeCredits', 'notice'] }, needs: [] },
  {
    id: 'signup-to-file', method: 'POST', url: `${apiUrl}/v1/accounts`, headers: {}, flags: ['-s'], saveTo: 'anyfare-account.json',
    expect: { status: 201, fields: ['id', 'createdAt', 'masterKey', 'freeCredits', 'notice'] }, needs: [],
  },
  { id: 'account', method: 'GET', url: `${apiUrl}/v1/account`, headers: master, expect: { status: 200, fields: ['id', 'createdAt'] }, needs: ['ANYFARE_MASTER_KEY'] },
  { id: 'rotate', method: 'POST', url: `${apiUrl}/v1/account/master-key/rotate`, headers: master, expect: { status: 200, fields: ['masterKey'] }, needs: ['ANYFARE_MASTER_KEY'], destructive: true },
  {
    id: 'make-key', method: 'POST', url: `${apiUrl}/v1/keys`, headers: { ...master, ...json }, body: '{"label":"research","dailyBudget":"5","maxPrice":"0.05"}',
    expect: { status: 201, fields: ['id', 'label', 'allowance', 'dailyBudget', 'maxPrice', 'expiresAt', 'createdAt', 'revokedAt', 'spent', 'remaining', 'key'] }, needs: ['ANYFARE_MASTER_KEY'],
  },
  { id: 'list-keys', method: 'GET', url: `${apiUrl}/v1/keys`, headers: master, expect: { status: 200, fields: ['keys'] }, needs: ['ANYFARE_MASTER_KEY'] },
  {
    id: 'change-key', method: 'PATCH', url: `${apiUrl}/v1/keys/$ANYFARE_KEY_ID`, headers: { ...master, ...json }, body: '{"dailyBudget":"10","maxPrice":null}',
    expect: { status: 200, fields: ['id', 'label', 'allowance', 'dailyBudget', 'maxPrice', 'expiresAt', 'createdAt', 'revokedAt', 'spent', 'remaining'] }, needs: ['ANYFARE_MASTER_KEY', 'ANYFARE_KEY_ID'],
  },
  {
    id: 'revoke-key', method: 'DELETE', url: `${apiUrl}/v1/keys/$ANYFARE_KEY_ID`, headers: master, expect: { status: 200, fields: ['id', 'revokedAt'] },
    needs: ['ANYFARE_MASTER_KEY', 'ANYFARE_KEY_ID'], destructive: true,
  },
  { id: 'balance', method: 'GET', url: `${apiUrl}/v1/balance`, headers: master, expect: { status: 200, fields: ['available', 'held'] }, needs: ['ANYFARE_MASTER_KEY'] },
  { id: 'payments', method: 'GET', url: `${apiUrl}/v1/payments?limit=5`, headers: master, expect: { status: 200, fields: ['payments', 'next'] }, needs: ['ANYFARE_MASTER_KEY'] },
  { id: 'topup-options', method: 'GET', url: `${apiUrl}/v1/topups/options`, headers: {}, expect: { status: 200, fields: ['asset', 'networks'] }, needs: [] },
  {
    id: 'topup', method: 'POST', url: `${apiUrl}/v1/topups`, headers: { ...master, ...json }, body: '{"network":"base","token":"USDC","amount":"20"}',
    expect: { status: 201, fields: ['id', 'status', 'message', 'network', 'token', 'amount', 'depositAddress', 'depositMemo', 'send', 'sendAtLeast', 'estimatedCredits', 'payBy', 'addressExpiresAt', 'createdAt', 'updatedAt', 'deposited', 'credited', 'transaction', 'refunded', 'refundReason'] },
    needs: ['ANYFARE_MASTER_KEY'],
  },
  {
    id: 'topup-status', method: 'GET', url: `${apiUrl}/v1/topups/$ANYFARE_TOPUP_ID`, headers: master,
    expect: { status: 200, fields: ['id', 'status', 'message', 'network', 'token', 'amount', 'depositAddress', 'depositMemo', 'send', 'sendAtLeast', 'estimatedCredits', 'payBy', 'addressExpiresAt', 'createdAt', 'updatedAt', 'deposited', 'credited', 'transaction', 'refunded', 'refundReason'] },
    needs: ['ANYFARE_MASTER_KEY', 'ANYFARE_TOPUP_ID'],
  },
  { id: 'catalog', method: 'GET', url: `${apiUrl}/v1/catalog?limit=3`, headers: {}, expect: { status: 200, fields: ['endpoints', 'next'] }, needs: [] },
  { id: 'calls', method: 'GET', url: `${apiUrl}/v1/calls?status=paid&size=3`, headers: {}, expect: { status: 200, fields: ['calls', 'page', 'size', 'total', 'totalCapped'] }, needs: [] },
  { id: 'calls-stream', method: 'GET', url: `${apiUrl}/v1/calls/stream`, headers: {}, flags: ['-N'], expect: { status: 200, fields: [], headers: ['content-type'] }, needs: [] },
  {
    id: 'receipt', method: 'GET', url: `${apiUrl}/v1/calls/$ANYFARE_CALL_ID`, headers: {},
    expect: { status: 200, fields: ['id', 'at', 'status', 'apiStatus', 'service', 'method', 'path', 'buyer', 'api', 'apiPrice', 'fee', 'ms', 'steps'] }, needs: ['ANYFARE_CALL_ID'],
  },
  {
    id: 'stats', method: 'GET', url: `${apiUrl}/v1/stats`, headers: {},
    expect: { status: 200, fields: ['updatedAt', 'allUpdatedAt', 'calls', 'volume', 'buyers', 'services', 'byPaidWith', 'topups', 'daily'] }, needs: [],
  },
  { id: 'stats-live', method: 'GET', url: `${apiUrl}/v1/stats/live`, headers: {}, expect: { status: 200, fields: ['at', 'today', 'last24h', 'perMinute'] }, needs: [] },
  {
    id: 'stats-top', method: 'GET', url: `${apiUrl}/v1/stats/top?period=7d`, headers: {},
    expect: { status: 200, fields: ['period', 'updatedAt', 'services', 'endpoints', 'paidWith', 'topupTokens'] }, needs: [],
  },
  {
    id: 'services', method: 'GET', url: `${apiUrl}/v1/services?sort=calls&size=3`, headers: {},
    expect: { status: 200, fields: ['services', 'page', 'size', 'total', 'totalCapped', 'totals', 'updatedAt'] }, needs: [],
  },
  {
    id: 'service', method: 'GET', url: `${apiUrl}/v1/services/$ANYFARE_SERVICE_HOST?period=30d`, headers: {},
    expect: { status: 200, fields: ['host', 'period', 'updatedAt', 'paidEndpoints', 'stats', 'endpoints', 'daily', 'byPaidWith', 'topBuyers', 'exact'] }, needs: ['ANYFARE_SERVICE_HOST'],
  },
  {
    id: 'endpoint-stats', method: 'GET', url: `${apiUrl}/v1/endpoints/stats?host=$ANYFARE_SERVICE_HOST&path=$ANYFARE_SERVICE_PATH&period=30d`, headers: {},
    expect: { status: 200, fields: ['host', 'path', 'period', 'updatedAt', 'stats', 'daily', 'byPaidWith', 'exact'] }, needs: ['ANYFARE_SERVICE_HOST', 'ANYFARE_SERVICE_PATH'],
  },
];

// A URL with a character the shell reads is quoted
const shellUrl = (url: string): string => /[?&$]/.test(url) ? `"${url}"` : url;

/** The example as a `curl` command, one option to a line. */
export const curlOf = (example: CurlExample): string => {
  const first = ['curl', ...example.flags ?? [], ...example.method === 'GET' ? [] : ['-X', example.method], shellUrl(example.url)].join(' ');
  const options = [
    ...Object.entries(example.headers).map(([name, value]) => `-H "${titleCase(name)}: ${value}"`),
    ...example.body === undefined ? [] : [`-d '${example.body}'`],
  ];
  const lines = [first, ...options.map(option => `  ${option}`)];
  const command = lines.join(' \\\n');

  return example.saveTo === undefined ? command : `${command} > ${example.saveTo}`;
};

/** One example by its id. */
export const exampleOf = (hosts: Hosts, id: string): CurlExample => {
  const found = curlExamples(hosts).find(example => example.id === id);
  if (found === undefined)
    throw new Error(`No curl example is called ${id}`);

  return found;
};

/** One example as its `curl` command. */
export const curlById = (hosts: Hosts, id: string): string => curlOf(exampleOf(hosts, id));
