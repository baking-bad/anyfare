import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { parseReceipt } from '../src/credits.ts';
import { CMC_URL, EVIDENCE_URL, ROUTE_URL, forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAccount, FakeAnyfare, FakeKey, KeyLimits } from './fakeAnyfare.ts';
import { brokenAnswer, captureIo, tempAppDir } from './helpers.ts';
import type { IoOptions } from './helpers.ts';
import type { PaidAnswer } from './fakeAnyfare.ts';

let fake: FakeAnyfare;
let app: { dir: string; remove: () => void };

beforeAll(async () => {
  fake = await startFakeAnyfare();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  for (const target of Object.values(toolTargets())) fake.addTarget(target);
  app = tempAppDir();
});
afterEach(() => {
  app.remove();
});

const routedPath = (url: string): string => `/${url.replace(/^https:\/\//, '')}`;

/** An account with a made-up balance, and a payment key of it. */
function funded(balance = '1', limits: KeyLimits = { label: 'demo', dailyBudget: '1', maxPrice: '0.02' }): {
  account: FakeAccount;
  key: FakeKey;
} {
  const account = fake.addAccount(balance);
  return { account, key: fake.addKey(account, limits) };
}

async function call(argv: readonly string[], env: Record<string, string> = {}, options: IoOptions & { readonly fetch?: typeof fetch } = {}) {
  const { fetch, calls } = forwardingFetch(toolRoutes());
  const io = captureIo(options.fetch ?? fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...env }, { appDir: app.dir, ...options });
  const code = await runCli(['call', ...argv], io.io);
  return { code, out: io.out(), err: io.err(), calls };
}

/** The routed requests that carried a payment. */
const paidRequests = () => fake.routed().filter((item) => item.headers['authorization'] !== undefined);

/** Whether a request is the paid one: it carries the key, and is not the free GET /_/key before it. */
const isPaid = (input: string | URL | Request, init?: RequestInit): boolean =>
  new Headers(init?.headers).has('authorization') && !String(input).endsWith('/_/key');

describe('call --pay credits', () => {
  it('pays a CoinMarketCap call from Credits, with the receipt and the story line', async () => {
    const { account, key } = funded();
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const out = result.out;
    expect(out).toContain('CoinMarketCap: BTC in USD');
    expect(out).toMatch(/The API asks\s+\$0\.01 in USDC on Base/);
    expect(out).toMatch(/Anyfare's quote\s+\$0\.011, with a fee of \$0\.001/);
    expect(out).toMatch(/You pay\s+\$0\.011 of Credits/);
    expect(out).toContain('Bitcoin Real (BTC)');
    expect(out).toContain('Price       12,345.68 USD');
    expect(out).toMatch(/Receipt pay_madeup\d+: \$0\.011 of Credits/);
    expect(out.trimEnd().split('\n').at(-1)).toBe(
      '✔ You paid with Credits. Anyfare paid CoinMarketCap in USDC on Base from its own wallet.',
    );
    expect(account.available).toBe(989000n);

    const paid = paidRequests();
    expect(paid).toHaveLength(1);
    expect(paid[0]?.method).toBe('GET');
    expect(paid[0]?.path).toBe(routedPath(CMC_URL));
    expect(paid[0]?.headers['authorization']).toBe(`Bearer ${key.key}`);
    expect(`${out}${result.err}`).not.toContain(key.key);
  });

  it('pays a 3Route quote', async () => {
    const { key } = funded();
    const result = await call(['--tool', '3route', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('1 USDC → 0.00025 WETH');
    expect(result.out).toMatch(/Receipt pay_madeup\d+: \$0\.0012 of Credits/);
    expect(result.out).toContain('Anyfare paid 3Route in USDC on Base from its own wallet.');
    expect(paidRequests().map((item) => item.path)).toEqual([routedPath(ROUTE_URL)]);
  });

  it('pays the evidence API, a POST, at the price of the routing link\'s 402', async () => {
    const { key } = funded();
    const result = await call(['--tool', 'evidence', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/The API asks\s+\$0\.001 in USDC on NEAR/);
    expect(result.out).toMatch(/You pay\s+\$0\.002 of Credits/);
    expect(result.out).toContain('This one takes a while.');
    expect(result.out).toContain('Account     anyfare.near');
    expect(result.out).toMatch(/Receipt pay_madeup\d+: \$0\.002 of Credits/);
    expect(result.out).toContain('Anyfare paid the evidence API in USDC on NEAR from its own wallet.');
    const paid = paidRequests();
    expect(paid).toHaveLength(1);
    expect(paid[0]?.method).toBe('POST');
    expect(paid[0]?.path).toBe(routedPath(EVIDENCE_URL));
    expect(paid[0]?.body).toBe('{"accountId":"anyfare.near"}');
    expect(paid[0]?.headers['content-type']).toBe('application/json');
    expect(fake.requests.some((item) => item.path.startsWith('/_/check'))).toBe(false);
  });

  it('prints the whole plan with --explain, marking Credits', async () => {
    const { key } = funded();
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--explain', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(0);
    expect(result.out).toContain('▸ What CoinMarketCap asks, without Anyfare');
    expect(result.out).toMatch(/\$0\.011 of Credits\s+--pay credits\s+← you pay this one/);
    expect(result.out).not.toContain('The API asks');
  });

  it('refuses a quote above the cap and sends no payment', async () => {
    const { account, key } = funded();
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], {
      ANYFARE_PAYMENT_KEY: key.key,
      MAX_PAYMENT_USD: '0.01',
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ Anyfare quotes $0.011, above your cap MAX_PAYMENT_USD of $0.01. Not charged.\n');
    expect(paidRequests()).toEqual([]);
    // The only routed request is the plan's unpaid one
    expect(fake.routed()).toHaveLength(1);
    expect(account.available).toBe(1000000n);
  });

  it("refuses at the cap on the routing link's 402 price when /_/check quotes less", async () => {
    const { account, key } = funded();
    const cmc = toolTargets().cmc;
    // Made up: /_/check quotes under the cap, the 402 asks over it
    fake.addTarget({ ...cmc, price: '0.03', check: { ...cmc.check!, quote: '0.011' } });
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'Anyfare quotes $0.011 at GET /_/check and $0.03 in its 402 for this call. The app takes the higher, $0.03.\n' +
        '✘ Anyfare quotes $0.03, above your cap MAX_PAYMENT_USD of $0.02. Not charged.\n',
    );
    expect(paidRequests()).toEqual([]);
    expect(account.available).toBe(1000000n);
  });

  it('refuses at the cap on the /_/check quote when the 402 asks less', async () => {
    const { key } = funded();
    const cmc = toolTargets().cmc;
    fake.addTarget({ ...cmc, price: '0.011', check: { ...cmc.check!, quote: '0.03' } });
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.err).toContain('✘ Anyfare quotes $0.03, above your cap MAX_PAYMENT_USD of $0.02. Not charged.\n');
    expect(paidRequests()).toEqual([]);
  });

  it('shows, confirms and checks the receipt against the one amount it pays', async () => {
    const { account, key } = funded();
    const cmc = toolTargets().cmc;
    // Made up: the 402 asks more than /_/check quoted, and the proxy holds the 402's price
    fake.addTarget({ ...cmc, price: '0.012', check: { ...cmc.check!, quote: '0.011' } });
    const result = await call(['--tool', 'cmc', '--pay', 'credits'], { ANYFARE_PAYMENT_KEY: key.key }, { isTerminal: true, input: 'y\n' });
    expect(result.code).toBe(0);
    expect(result.err).toBe(
      'Anyfare quotes $0.011 at GET /_/check and $0.012 in its 402 for this call. The app takes the higher, $0.012.\n',
    );
    expect(result.out).toMatch(/You pay\s+\$0\.012 of Credits/);
    expect(result.out).toMatch(/Anyfare's quote\s+\$0\.012, with a fee of \$0\.002/);
    expect(result.out).toContain('Pay $0.012 of Credits? [y/N]');
    expect(result.out).not.toContain('0.011');
    expect(result.out).toMatch(/Receipt pay_madeup\d+: \$0\.012 of Credits/);
    expect(account.available).toBe(988000n);
  });

  it('shows in --explain the amount the call pays, and refuses it at the cap', async () => {
    const { key } = funded();
    const cmc = toolTargets().cmc;
    // Made up: /_/check quotes under the cap, the 402 asks over it
    fake.addTarget({ ...cmc, price: '0.03', check: { ...cmc.check!, quote: '0.011' } });
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--explain', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/You pay\s+\$0\.03\n/);
    expect(result.out).toMatch(/Anyfare's fee\s+\$0\.02\n/);
    expect(result.out).toContain('Your cap, MAX_PAYMENT_USD, is $0.02. This quote is over it, so a call would not go ahead.');
    expect(result.out).not.toContain('within it');
    expect(result.err).toContain('✘ Anyfare quotes $0.03, above your cap MAX_PAYMENT_USD of $0.02. Not charged.');
    expect(paidRequests()).toEqual([]);
  });

  it('shows in --explain the amount it then confirms and pays', async () => {
    const { key } = funded();
    const cmc = toolTargets().cmc;
    fake.addTarget({ ...cmc, price: '0.012', check: { ...cmc.check!, quote: '0.011' } });
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--explain'], { ANYFARE_PAYMENT_KEY: key.key }, { isTerminal: true, input: 'y\n' });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/You pay\s+\$0\.012\n/);
    expect(result.out).toContain('This quote is within it.');
    expect(result.out).toContain('Pay $0.012 of Credits? [y/N]');
    expect(result.out).toMatch(/Receipt pay_madeup\d+: \$0\.012 of Credits/);
  });

  it.each([
    ['a quote in another currency', { check: { currency: 'EUR' } }, 'cmc', `Anyfare's quote from GET /_/check is in "EUR", not US dollars.`],
    ['a quote without a currency', { check: { currency: null } }, 'cmc', "Anyfare's quote from GET /_/check is in no currency, not US dollars."],
    ['a 402 price in another currency', { creditsCurrency: 'EUR' }, 'cmc', `The Credits price of Anyfare's 402 is in "EUR", not US dollars.`],
    ['a 402 price without a currency', { creditsCurrency: null }, 'evidence', "The Credits price of Anyfare's 402 is in no currency, not US dollars."],
  ] as const)('refuses %s before any payment', async (_what, change, tool, line) => {
    const { account, key } = funded();
    const target = toolTargets()[tool];
    fake.addTarget({
      ...target,
      ...('creditsCurrency' in change && { creditsCurrency: change.creditsCurrency }),
      ...('check' in change && target.check !== undefined && { check: { ...target.check, ...change.check } }),
    });
    const result = await call(['--tool', tool, '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ ${line} Not charged.\n`);
    expect(paidRequests()).toEqual([]);
    expect(account.available).toBe(1000000n);
  });

  it("reads an error body with a code the proxy doesn't answer as the API's own", async () => {
    const { account, key } = funded();
    fake.nextPaid = { status: 404, body: { error: { code: 'not_found', message: 'No such symbol' } } };
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /^✘ CoinMarketCap answered 404: \{"error":\{"code":"not_found","message":"No such symbol"\}\} \(request req-made-up-\d+\)\. Not charged\.\n$/,
    );
    expect(account.available).toBe(1000000n);
  });

  it("says so when the price is above the key's highest price per call", async () => {
    const { account, key } = funded('1', { label: 'demo', maxPrice: '0.005' });
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /^✘ The price is above the payment key's highest price per call \(request req-made-up-\d+\)\. Not charged\.\n$/,
    );
    expect(paidRequests()).toHaveLength(1);
    expect(account.available).toBe(1000000n);
  });

  it("says so when Anyfare refuses a call the Credits don't cover, after their balance could not be read", async () => {
    const { key } = funded('0');
    // GET /_/key answers 503, made up: the check before the question can't read the balance
    const { fetch } = forwardingFetch(toolRoutes());
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/_/key') ? new Response('', { status: 503 }) : fetch(input, init)) as typeof fetch;
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key }, { fetch: wrapped });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      "Could not read the Credits balance: Anyfare answered 503. Anyfare refuses a call the Credits can't cover.\n" +
        `✘ Your Credits don't cover this call. Top up, or ask the operator (request ${/request (req-made-up-\d+)/.exec(result.err)?.[1] ?? ''}). Not charged.\n`,
    );
    expect(paidRequests()).toHaveLength(1);
  });

  it("passes the API's own 400 through, not charged", async () => {
    const { account, key } = funded();
    fake.nextPaid = { status: 400, body: { status: { error_code: 400, error_message: 'Invalid value for "symbol"' } } };
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /^✘ CoinMarketCap answered 400: \{"status":\{"error_code":400,"error_message":"Invalid value for \\"symbol\\""\}\} \(request req-made-up-\d+\)\. Not charged\.\n$/,
    );
    expect(account.available).toBe(1000000n);
  });

  it('prints the answer of a 2xx without a receipt, with a warning', async () => {
    const { key } = funded();
    fake.nextPaid = { status: 200, noReceipt: true };
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Bitcoin Real (BTC)');
    expect(result.out).not.toContain('Receipt');
    expect(result.err).toBe('No receipt came with the answer. npm run demo -- balance shows what was paid.\n');
    expect(result.out).toContain('You paid with Credits.');
  });

  it('warns about an unreadable receipt and still prints the answer', async () => {
    const { key } = funded();
    fake.nextPaid = { status: 200, headers: { 'anyfare-receipt': 'id=pay_1, amount=0.011' } };
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Bitcoin Real (BTC)');
    expect(result.err).toBe('The receipt that came with the answer is unreadable.\n');
  });

  it('sends one request and follows no redirect', async () => {
    const { account, key } = funded();
    fake.nextPaid = { status: 302, headers: { location: routedPath(CMC_URL) } };
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^✘ CoinMarketCap answered 302 \(request req-made-up-\d+\)\. Not charged\.\n$/);
    expect(paidRequests()).toHaveLength(1);
    expect(account.available).toBe(1000000n);
  });

  it('refuses a master key in ANYFARE_PAYMENT_KEY before any request', async () => {
    const { account } = funded();
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: account.masterKey });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ That is a master key. Paid calls take a payment key.\n');
    expect(fake.requests).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it('needs a payment key', async () => {
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      '✘ ANYFARE_PAYMENT_KEY is not set. Add it to .env.local. Run npm run demo -- signup, then npm run demo -- key create.\n',
    );
    expect(fake.requests).toEqual([]);
  });

  it('is a usage error without --yes and without a terminal, before any request', async () => {
    const { key } = funded();
    const result = await call(['--tool', 'cmc', '--pay', 'credits'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(2);
    expect(result.err).toBe('✘ call asks before it pays. Add --yes to pay without a terminal\n');
    expect(fake.requests).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it('sends nothing on a "no" at the prompt', async () => {
    const { account, key } = funded();
    const result = await call(['--tool', 'cmc', '--pay', 'credits'], { ANYFARE_PAYMENT_KEY: key.key }, { isTerminal: true, input: 'n\n' });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Pay $0.011 of Credits? [y/N]');
    expect(result.err).toBe('✘ Nothing was sent. Not charged.\n');
    expect(paidRequests()).toEqual([]);
    expect(account.available).toBe(1000000n);
  });

  it.each([
    ['ends', '', 'No more input'],
    ['gets three answers that are neither yes nor no', 'maybe\nperhaps\nlater\n', 'No valid answer'],
  ])('sends nothing when the question %s', async (_what, input, reason) => {
    const { account, key } = funded();
    const result = await call(['--tool', 'cmc', '--pay', 'credits'], { ANYFARE_PAYMENT_KEY: key.key }, { isTerminal: true, input });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ ${reason}. Nothing was sent. Not charged.\n`);
    expect(paidRequests()).toEqual([]);
    expect(account.available).toBe(1000000n);
  });

  it('pays on a "yes" at the prompt', async () => {
    const { key } = funded();
    const result = await call(['--tool', 'cmc', '--pay', 'credits'], { ANYFARE_PAYMENT_KEY: key.key }, { isTerminal: true, input: 'y\n' });
    expect(result.code).toBe(0);
    expect(paidRequests()).toHaveLength(1);
  });

  it('stops, not charged, when Anyfare cannot pay the call', async () => {
    fake.reset();
    const { key } = funded();
    const result = await call(['--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      "✘ Anyfare cannot pay this call: The target didn't ask for a payment: Anyfare routes paid calls only. Not charged.\n",
    );
    expect(paidRequests()).toEqual([]);
  });
});

describe('a paid request that fails on the way', () => {
  /** A fetch like `call`'s, whose paid request fails with `failure` instead of reaching the fake. */
  async function failing(failure: () => never) {
    const { key } = funded();
    const { fetch } = forwardingFetch(toolRoutes());
    const sent: string[] = [];
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      if (isPaid(input, init)) {
        sent.push(String(input));
        failure();
      }
      return fetch(input, init);
    }) as typeof fetch;
    const io = captureIo(wrapped, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ANYFARE_PAYMENT_KEY: key.key }, { appDir: app.dir });
    const code = await runCli(['call', '--tool', 'cmc', '--pay', 'credits', '--yes'], io.io);
    expect(sent).toHaveLength(1);
    return { code, err: io.err() };
  }
  const networkError = (code: string) => (): never => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(`Made up: ${code}`), { code }) });
  };

  /** The paid request reaches the fake, which answers and charges, then the body breaks on the way back. */
  async function breaking(code: string, paid?: PaidAnswer) {
    const { account, key } = funded();
    if (paid !== undefined) fake.nextPaid = paid;
    const { fetch } = forwardingFetch(toolRoutes());
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (!isPaid(input, init)) return response;
      await response.arrayBuffer();
      return brokenAnswer(response.status, code, response.headers);
    }) as typeof fetch;
    const io = captureIo(wrapped, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ANYFARE_PAYMENT_KEY: key.key }, { appDir: app.dir });
    const exit = await runCli(['call', '--tool', 'cmc', '--pay', 'credits', '--yes'], io.io);
    return { exit, err: io.err(), account };
  }

  it.each(['ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ECONNREFUSED', 'ECONNRESET'])(
    'never says "Not charged" when a 2xx was charged and its body broke: %s',
    async (code) => {
      const result = await breaking(code);
      // The fake charged the call
      expect(result.account.available).toBe(989000n);
      expect(result.exit).toBe(1);
      expect(result.err).toBe(
        `✘ 127.0.0.1:${new URL(fake.payUrl).port} answered 200, but its body broke: ${code}. The call was most likely paid, and its answer is lost: npm run demo -- balance shows the Credits.\n`,
      );
    },
  );

  it('says the outcome is not known when the body of another answer broke', async () => {
    const result = await breaking('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC', { status: 400, body: 'Bad symbol' });
    expect(result.err).toContain('answered 400, but its body broke');
    expect(result.err).toContain('Whether the call was paid is not known');
    expect(result.err).not.toContain('Not charged');
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])(
    'says "Not charged" when no connection was made: %s',
    async (code) => {
      const result = await failing(networkError(code));
      expect(result.code).toBe(1);
      expect(result.err).toBe(`✘ Could not reach 127.0.0.1:${new URL(fake.payUrl).port}: ${code}. The request was never sent. Not charged.\n`);
    },
  );

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'])('says the outcome is not known after a broken connection: %s', async (code) => {
    const result = await failing(networkError(code));
    expect(result.code).toBe(1);
    expect(result.err).toContain('Whether the call was paid is not known');
    expect(result.err).not.toContain('Not charged');
  });

  it('says the outcome is not known after a timeout', async () => {
    const result = await failing(() => {
      throw new DOMException('Made-up timeout', 'TimeoutError');
    });
    expect(result.err).toBe(
      `✘ 127.0.0.1:${new URL(fake.payUrl).port} did not answer within 60 seconds. Whether the call was paid is not known: npm run demo -- balance shows the Credits.\n`,
    );
  });
});

describe('parseReceipt', () => {
  it('reads the three members', () => {
    expect(parseReceipt('id="pay_1", amount="0.01", currency="USD"')).toEqual({ kind: 'ok', id: 'pay_1', amount: 10000n });
    expect(parseReceipt('currency="USD",amount="0.000001",\tid="pay_2"')).toEqual({ kind: 'ok', id: 'pay_2', amount: 1n });
    expect(parseReceipt(null)).toEqual({ kind: 'missing' });
  });

  it.each([
    '',
    'id="pay_1", amount="0.01"',
    'id="pay_1", amount="0.01", currency="USD", extra="x"',
    'id="pay_1", amount="0.01", currency="EUR"',
    'id=pay_1, amount="0.01", currency="USD"',
    'id="pay_1", amount=0.01, currency="USD"',
    'id="pay_1", amount="1e-2", currency="USD"',
    'id="pay_1", amount="-0.01", currency="USD"',
    'id="", amount="0.01", currency="USD"',
    'id="pay_1", id="pay_2", amount="0.01", currency="USD"',
    'id="pay\\"1", amount="0.01", currency="USD"',
    'id="pay_1"; amount="0.01"; currency="USD"',
  ])('refuses %j', (value) => {
    expect(parseReceipt(value)).toEqual({ kind: 'unreadable' });
  });
});
