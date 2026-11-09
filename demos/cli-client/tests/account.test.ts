import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare } from './fakeAnyfare.ts';
import type { Fetch } from '../src/http.ts';
import { ROOT_NOTE, RUNS_AS_ROOT, brokenAnswer, captureIo, tempAppDir } from './helpers.ts';
import type { IoOptions } from './helpers.ts';

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
  chmodSync(app.dir, 0o700);
  app.remove();
  for (const extra of extraDirs.splice(0)) extra.remove();
});

const extraDirs: { remove: () => void }[] = [];
function tempAppDirOf(): string {
  const extra = tempAppDir();
  extraDirs.push(extra);
  return extra.dir;
}
const envLocal = (): string => readFileSync(join(app.dir, '.env.local'), 'utf8');
const savedValue = (name: string): string | undefined =>
  new RegExp(`^${name}=(.*)$`, 'm').exec(envLocal())?.[1];

async function run(
  argv: readonly string[],
  env: Record<string, string> = {},
  options: IoOptions = {},
  wrap: (fetchFn: Fetch) => Fetch = (fetchFn) => fetchFn,
) {
  const { fetch, calls } = forwardingFetch(toolRoutes());
  const io = captureIo(wrap(fetch), { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...env }, { appDir: app.dir, ...options });
  const code = await runCli(argv, io.io);
  return { code, out: io.out(), err: io.err(), calls };
}

describe('signup', () => {
  it('says the free Credits of the answer, only when they are above zero', async () => {
    fake.rewrite.signup = (body) => ({ ...body, freeCredits: '0.10' });
    const given = await run(['signup', '--yes']);
    expect(given.code).toBe(0);
    expect(given.out).toContain('You got $0.10 of free Credits');

    fake.rewrite.signup = (body) => ({ ...body, freeCredits: '0' });
    const none = await run(['signup', '--yes'], {}, { appDir: tempAppDirOf() });
    expect(none.code).toBe(0);
    expect(none.out).not.toContain('free Credits');
  });

  it('creates the account, saves the key, prints the notice, the balance and the next step', async () => {
    const result = await run(['signup', '--yes']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);

    const key = savedValue('ANYFARE_MASTER_KEY');
    expect(key).toMatch(/^afm_live_[0-9A-Za-z]{43}$/);
    const account = fake.account(key ?? '');
    expect(account).toBeDefined();
    expect(statSync(join(app.dir, '.env.local')).mode & 0o777).toBe(0o600);

    const out = result.out;
    expect(out).toContain('Account created');
    expect(out).toMatch(new RegExp(`Account\\s+${account?.id}`));
    expect(out).toMatch(new RegExp(`Master key\\s+${(key ?? '').slice(0, 10)}…`));
    expect(out).toContain('Saved to .env.local');
    expect(out).toContain('A made-up notice: store the master key now, it is shown only once.');
    expect(out).toContain('Your balance is $0. Credits come from a top-up, or from the operator.');
    expect(out.trimEnd().split('\n').at(-1)).toBe('Next: npm run demo -- key create');
    expect(`${out}${result.err}`).not.toContain(key);

    expect(fake.requests.map((item) => `${item.host} ${item.method} ${item.path}`)).toEqual([
      'api POST /v1/accounts',
      'api GET /v1/balance',
    ]);
    expect(fake.requests[1]?.headers['authorization']).toBe(`Bearer ${key}`);
  });

  it('says what a balance buys, at the prices of this run', async () => {
    // A made-up starting balance
    fake.startingBalance = '0.5';
    const result = await run(['signup', '--yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Your balance is $0.5.');
    expect(result.out).toContain('That pays for 45 CoinMarketCap calls at $0.011, or 416 3Route quotes at $0.0012.');
  });

  it('leaves out a quote it cannot read', async () => {
    fake.reset();
    fake.startingBalance = '0.5';
    fake.addTarget(toolTargets().cmc);
    const result = await run(['signup', '--yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('That pays for 45 CoinMarketCap calls at $0.011.');
    expect(result.out).not.toContain('3Route');
  });

  it('creates nothing when a master key is set in the environment', async () => {
    const result = await run(['signup', '--yes'], { ANYFARE_MASTER_KEY: 'afm_live_made-up' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      '✘ ANYFARE_MASTER_KEY is set already, so sign-up created nothing. balance and key create use that key.\n',
    );
    expect(fake.requests).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it('creates nothing when a master key is set in .env.local', async () => {
    writeFileSync(join(app.dir, '.env.local'), 'ANYFARE_MASTER_KEY=afm_live_made-up\n');
    const result = await run(['signup', '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('ANYFARE_MASTER_KEY is set already');
    expect(fake.requests).toEqual([]);
  });

  it('is a usage error without a terminal and without --yes, before any request', async () => {
    const result = await run(['signup']);
    expect(result.code).toBe(2);
    expect(result.err).toBe('✘ signup asks before it creates an account. Add --yes to go on without a terminal\n');
    expect(fake.requests).toEqual([]);
  });

  it('creates nothing on a "no" at the prompt', async () => {
    const result = await run(['signup'], {}, { isTerminal: true, input: 'n\n' });
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      'Sign up creates an Anyfare account and a master key. The key is shown only once, so the app saves it to .env.local. Go on? [y/N]',
    );
    expect(result.err).toBe('✘ Nothing was created.\n');
    expect(fake.requests).toEqual([]);
  });

  it('signs up on a "yes" at the prompt', async () => {
    const result = await run(['signup'], {}, { isTerminal: true, input: 'y\n' });
    expect(result.code).toBe(0);
    expect(savedValue('ANYFARE_MASTER_KEY')).toMatch(/^afm_live_/);
  });

  it('says when sign-up is rate limited, and saves nothing', async () => {
    fake.rateLimitSignup = true;
    const result = await run(['signup', '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^✘ Too many requests; retry in 30 seconds \(request req-made-up-\d+\)\.\n$/);
    expect(() => envLocal()).toThrow();
  });
});

describe('key create', () => {
  it('needs the master key', async () => {
    const result = await run(['key', 'create', '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ ANYFARE_MASTER_KEY is not set. Add it to .env.local. Run npm run demo -- signup first.\n');
    expect(fake.requests).toEqual([]);
  });

  it("sends the flags' values with the master key, saves the key and prints its limits", async () => {
    const account = fake.addAccount();
    const result = await run(['key', 'create', '--label', 'bot', '--daily', '2.5', '--max-price', '0.05', '--yes'], {
      ANYFARE_MASTER_KEY: account.masterKey,
    });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const sent = fake.requests.find((item) => item.path === '/v1/keys');
    expect(sent?.method).toBe('POST');
    expect(JSON.parse(sent?.body ?? '')).toEqual({ label: 'bot', dailyBudget: '2.5', maxPrice: '0.05' });
    expect(sent?.headers['authorization']).toBe(`Bearer ${account.masterKey}`);

    const key = savedValue('ANYFARE_PAYMENT_KEY') ?? '';
    expect(key).toMatch(/^af_live_[0-9A-Za-z]{43}$/);
    const out = result.out;
    expect(out).toContain('Payment key created');
    expect(out).toMatch(/Key ID\s+key_madeup\d+/);
    expect(out).toMatch(/Label\s+bot/);
    expect(out).toMatch(new RegExp(`Payment key\\s+${key.slice(0, 10)}…`));
    expect(out).toMatch(/Daily budget\s+\$2\.5/);
    expect(out).toMatch(/Per call\s+at most \$0\.05/);
    expect(out).toMatch(/Allowance\s+none/);
    expect(out).toContain('Saved to .env.local');
    expect(out).not.toContain(key);
    expect(out).not.toContain(account.masterKey);
  });

  it('sends the defaults', async () => {
    const account = fake.addAccount();
    expect((await run(['key', 'create', '--yes'], { ANYFARE_MASTER_KEY: account.masterKey })).code).toBe(0);
    const sent = fake.requests.find((item) => item.path === '/v1/keys');
    expect(JSON.parse(sent?.body ?? '')).toEqual({ label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
  });

  it("replaces an old payment key's line and says so", async () => {
    const account = fake.addAccount();
    const old = 'af_live_made-up-old';
    writeFileSync(join(app.dir, '.env.local'), `# Mine\nANYFARE_PAYMENT_KEY=${old}\nMAX_PAYMENT_USD=0.05\n`);
    const result = await run(['key', 'create', '--yes'], { ANYFARE_MASTER_KEY: account.masterKey, ANYFARE_PAYMENT_KEY: old });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      'ANYFARE_PAYMENT_KEY is set already. The new key replaces it in .env.local; the old key keeps working until it is revoked.',
    );
    const lines = envLocal().split('\n');
    expect(lines[0]).toBe('# Mine');
    expect(lines[1]).toMatch(/^ANYFARE_PAYMENT_KEY=af_live_[0-9A-Za-z]{43}$/);
    expect(lines[2]).toBe('MAX_PAYMENT_USD=0.05');
    expect(envLocal()).not.toContain(old);
  });

  it('asks first, with the limits, and creates nothing on a "no"', async () => {
    const account = fake.addAccount();
    const result = await run(['key', 'create'], { ANYFARE_MASTER_KEY: account.masterKey }, { isTerminal: true, input: 'no\n' });
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      'Create a payment key "demo": daily budget $1, at most $0.02 a call, saved to .env.local? [y/N]',
    );
    expect(fake.requests).toEqual([]);
  });

  it('is a usage error without a terminal and without --yes', async () => {
    const account = fake.addAccount();
    const result = await run(['key', 'create'], { ANYFARE_MASTER_KEY: account.masterKey });
    expect(result.code).toBe(2);
    expect(result.err).toContain('Add --yes');
    expect(fake.requests).toEqual([]);
  });

  it('says so when the master key is a payment key', async () => {
    const key = fake.addKey(fake.addAccount());
    const result = await run(['key', 'create', '--yes'], { ANYFARE_MASTER_KEY: key.key });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^✘ That is a payment key; the Platform API takes the master key \(request req-made-up-\d+\)\.\n$/);
    expect(() => envLocal()).toThrow();
  });
});

describe('balance', () => {
  it('shows available and held with the master key', async () => {
    // A made-up balance
    const account = fake.addAccount('1.25');
    const result = await run(['balance'], { ANYFARE_MASTER_KEY: account.masterKey });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Available\s+\$1\.25/);
    expect(result.out).toMatch(/Held\s+\$0/);
    expect(fake.requests.map((item) => `${item.host} ${item.path}`)).toEqual(['api /v1/balance']);
  });

  it("adds the payment key's limits with the payment key too", async () => {
    const account = fake.addAccount('1.25');
    const key = fake.addKey(account, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
    key.spentToday = 30000n;
    const result = await run(['balance'], { ANYFARE_MASTER_KEY: account.masterKey, ANYFARE_PAYMENT_KEY: key.key });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('The payment key "demo"');
    expect(result.out).toMatch(/Left today\s+\$0\.97 of \$1/);
    expect(result.out).toMatch(/Allowance\s+none/);
    expect(result.out).toMatch(/Per call\s+at most \$0\.02/);
    expect(result.out.match(/Available/g)).toHaveLength(1);
    expect(fake.requests.map((item) => `${item.host} ${item.path}`)).toEqual(['api /v1/balance', 'pay /_/key']);
    expect(fake.requests[1]?.headers['authorization']).toBe(`Bearer ${key.key}`);
  });

  it('shows the balance from /_/key with only the payment key', async () => {
    const key = fake.addKey(fake.addAccount('0.75'), { label: 'demo' });
    const result = await run(['balance'], { ANYFARE_PAYMENT_KEY: key.key });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Available\s+\$0\.75/);
    expect(result.out).toMatch(/Per call\s+no limit/);
    expect(fake.requests.map((item) => `${item.host} ${item.path}`)).toEqual(['pay /_/key']);
  });

  it('stops with the hint to sign up without a key', async () => {
    const result = await run(['balance']);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      '✘ Neither ANYFARE_MASTER_KEY nor ANYFARE_PAYMENT_KEY is set. Run npm run demo -- signup first.\n',
    );
    expect(fake.requests).toEqual([]);
  });

  it('says so when the key is refused', async () => {
    const result = await run(['balance'], { ANYFARE_MASTER_KEY: 'afm_live_made-up-unknown' });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^✘ The master key was refused: unknown or revoked \(request req-made-up-\d+\)\.\n$/);
  });
});

describe('saving a key that is shown once', () => {
  it('creates no account when the app directory can not be written', async ({ skip }) => {
    skip(RUNS_AS_ROOT, ROOT_NOTE);
    chmodSync(app.dir, 0o500);
    const result = await run(['signup', '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toBe("✘ The app can't write .env.local in its directory: EACCES. Nothing was created.\n");
    expect(fake.requests).toEqual([]);
  });

  it('creates no account when .env.local is a symbolic link', async () => {
    const other = tempAppDir();
    try {
      writeFileSync(join(other.dir, 'elsewhere.env'), 'A=1\n');
      symlinkSync(join(other.dir, 'elsewhere.env'), join(app.dir, '.env.local'));
      const result = await run(['signup', '--yes']);
      expect(result.code).toBe(1);
      expect(result.err).toBe(
        '✘ .env.local is a symbolic link, and the app writes keys only into a regular file: replace the link with a file. Nothing was created.\n',
      );
      expect(fake.requests).toEqual([]);
      expect(readFileSync(join(other.dir, 'elsewhere.env'), 'utf8')).toBe('A=1\n');
    } finally {
      other.remove();
    }
  });

  it('creates no payment key when .env.local can not be written', async ({ skip }) => {
    skip(RUNS_AS_ROOT, ROOT_NOTE);
    const account = fake.addAccount();
    writeFileSync(join(app.dir, '.env.local'), 'MAX_PAYMENT_USD=0.05\n', { mode: 0o400 });
    const result = await run(['key', 'create', '--yes'], { ANYFARE_MASTER_KEY: account.masterKey });
    expect(result.code).toBe(1);
    expect(result.err).toBe("✘ .env.local can't be read and written: EACCES. Nothing was created.\n");
    expect(fake.requests).toEqual([]);
  });

  it('says which account exists when its key still could not be saved', async ({ skip }) => {
    skip(RUNS_AS_ROOT, ROOT_NOTE);
    fake.during.signup = () => chmodSync(app.dir, 0o500);
    const result = await run(['signup', '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /^✘ The account acct_madeup\d+ was created, but its master key could not be saved: Could not write \.env\.local: EACCES\. The key can't be shown again, so that account can't be used\. Make \.env\.local writable, then sign up again\.\n$/,
    );
    expect(result.out).toBe('');
  });

  it('says which payment key exists, and to revoke it, when it still could not be saved', async ({ skip }) => {
    skip(RUNS_AS_ROOT, ROOT_NOTE);
    const account = fake.addAccount();
    fake.during.keys = () => chmodSync(app.dir, 0o500);
    const result = await run(['key', 'create', '--yes'], { ANYFARE_MASTER_KEY: account.masterKey });
    expect(result.code).toBe(1);
    const id = /key_madeup\d+/.exec(result.err)?.[0];
    expect(result.err).toBe(
      `✘ The payment key ${id} was created, but it could not be saved: Could not write .env.local: EACCES. Revoke it with the master key (DELETE /v1/keys/${id} on the Platform API), then create another.\n`,
    );
  });

  it('saves the master key when the rest of the 201 can not be read', async () => {
    fake.rewrite.signup = (body) => ({ ...body, id: 7, notice: ['not', 'text'] });
    const result = await run(['signup', '--yes']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(savedValue('ANYFARE_MASTER_KEY')).toMatch(/^afm_live_[0-9A-Za-z]{43}$/);
    expect(result.out).toMatch(/Account\s+-\n/);
    expect(result.out).not.toContain('notice');
  });

  it('saves the payment key when its limits can not be read, and shows them as -', async () => {
    const account = fake.addAccount();
    fake.rewrite.keys = (body) => ({ ...body, id: null, label: 42, dailyBudget: 'lots', maxPrice: 1, allowance: {}, expiresAt: false });
    const result = await run(['key', 'create', '--yes'], { ANYFARE_MASTER_KEY: account.masterKey });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(savedValue('ANYFARE_PAYMENT_KEY')).toMatch(/^af_live_[0-9A-Za-z]{43}$/);
    for (const label of ['Key ID', 'Label', 'Daily budget', 'Per call', 'Allowance', 'Expires']) {
      expect(result.out).toMatch(new RegExp(`${label}\\s+-\\n`));
    }
  });

  it('says a payment key may exist when the 201 holds no key it can read', async () => {
    const account = fake.addAccount();
    fake.rewrite.keys = (body) => ({ ...body, key: 'not a key' });
    const result = await run(['key', 'create', '--yes'], { ANYFARE_MASTER_KEY: account.masterKey });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      "✘ Anyfare's answer has no key this app can read: a payment key may have been created, and it can't be saved. List the keys with the master key (GET /v1/keys), revoke that one, and create another.\n",
    );
    expect(() => envLocal()).toThrow();
  });

  it('creates nothing when the question gets no answer', async () => {
    const result = await run(['signup'], {}, { isTerminal: true, input: '' });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ No more input. Nothing was created.\n');
    expect(fake.requests).toEqual([]);
  });
});

describe('a create request sent without a readable answer', () => {
  const apiHost = (): string => `127.0.0.1:${new URL(fake.apiUrl).port}`;

  /** The request reaches the fake, which creates, then `fail` decides what comes back for this path. */
  const after = (path: string, fail: (response: Response) => Promise<Response>) => (fetchFn: Fetch): Fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetchFn(input, init);
      if (new URL(String(input)).pathname !== path) return response;
      await response.arrayBuffer();
      return fail(response);
    }) as Fetch;
  const bodyBreaks = (path: string, code: string) => after(path, async (response) => brokenAnswer(response.status, code));
  const timesOut = (path: string) =>
    after(path, async () => {
      throw new DOMException('Made-up timeout', 'TimeoutError');
    });
  const refused = (path: string) => (fetchFn: Fetch): Fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === path) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('Made up'), { code: 'ECONNREFUSED' }) });
      }
      return fetchFn(input, init);
    }) as Fetch;

  it('says an account may exist when the body of the 201 broke', async () => {
    const result = await run(['signup', '--yes'], {}, {}, bodyBreaks('/v1/accounts', 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC'));
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `✘ ${apiHost()} answered 201, but its body broke: ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC. An account may have been created, and its master key can't be saved. Sign up again.\n`,
    );
    // The fake did create it
    expect(fake.requests.filter((item) => item.path === '/v1/accounts')).toHaveLength(1);
    expect(() => envLocal()).toThrow();
  });

  it('says an account may exist when the answer did not come in time', async () => {
    const result = await run(['signup', '--yes'], {}, {}, timesOut('/v1/accounts'));
    expect(result.err).toBe(
      `✘ ${apiHost()} did not answer within 20 seconds. An account may have been created, and its master key can't be saved. Sign up again.\n`,
    );
  });

  it('says nothing was created only when the request never left', async () => {
    const result = await run(['signup', '--yes'], {}, {}, refused('/v1/accounts'));
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ Could not reach ${apiHost()}: ECONNREFUSED. Nothing was created.\n`);
    expect(fake.requests).toEqual([]);
  });

  it('says a payment key may exist, and how to revoke it, when the body of the 201 broke', async () => {
    const account = fake.addAccount();
    const result = await run(['key', 'create', '--yes'], { ANYFARE_MASTER_KEY: account.masterKey }, {}, bodyBreaks('/v1/keys', 'ECONNRESET'));
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `✘ ${apiHost()} answered 201, but its body broke: ECONNRESET. A payment key may have been created, and it can't be saved. List the keys with the master key (GET /v1/keys), revoke that one, and create another.\n`,
    );
  });

  it('says no payment key was created when the request never left', async () => {
    const account = fake.addAccount();
    const result = await run(['key', 'create', '--yes'], { ANYFARE_MASTER_KEY: account.masterKey }, {}, refused('/v1/keys'));
    expect(result.err).toBe(`✘ Could not reach ${apiHost()}: ECONNREFUSED. Nothing was created.\n`);
  });
});
