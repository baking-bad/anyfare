import { describe, expect, it } from 'vitest';
import { balance, createKey, keyStatus, noticeOf, shownLimits, signup } from '../src/platform.ts';
import { Stop } from '../src/util.ts';
import { fakeFetch } from './helpers.ts';

const API = 'https://api.example.test';
const PAY = 'https://pay.example.test';
// Made up, shaped like keys
const MASTER = `afm_live_${'M'.repeat(43)}`;
const PAYMENT = `af_live_${'P'.repeat(43)}`;

const answering = (route: string, body: unknown, status = 200) =>
  fakeFetch({ [route]: () => Response.json(body, { status, headers: { 'x-request-id': 'req-made-up-9' } }) });

async function stopOf(promise: Promise<unknown>): Promise<Stop> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Stop);
  return error as Stop;
}

describe('signup', () => {
  it('posts an empty object and reads the account', async () => {
    const { fetch, calls } = answering(`POST ${API}/v1/accounts`, {
      id: 'acct_madeup',
      createdAt: '2026-11-09T10:00:00.000Z',
      masterKey: MASTER,
      notice: 'Made up.',
    }, 201);
    const account = await signup(fetch, `${API}/`);
    expect(account).toMatchObject({ id: 'acct_madeup', masterKey: MASTER });
    expect(noticeOf(account.answer)).toBe('Made up.');
    expect(calls[0]?.body).toBe('{}');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('says an account may exist when the master key of a 201 can not be read', async () => {
    for (const masterKey of [undefined, 42, '', PAYMENT, 'afm_live_has space']) {
      const { fetch } = answering(`POST ${API}/v1/accounts`, { id: 'acct_madeup', masterKey }, 201);
      expect((await stopOf(signup(fetch, API))).message).toBe(
        "Anyfare's answer has no masterKey this app can read: an account may have been created, and its master key can't be saved. Sign up again.",
      );
    }
  });

  it('takes the master key when nothing else of the 201 can be read', async () => {
    const { fetch } = answering(`POST ${API}/v1/accounts`, { id: 7, masterKey: MASTER, notice: { text: 'x' } }, 201);
    const account = await signup(fetch, API);
    expect(account).toMatchObject({ id: undefined, masterKey: MASTER });
    expect(noticeOf(account.answer)).toBeUndefined();
  });

  it('turns an error into its line', async () => {
    const { fetch } = answering(`POST ${API}/v1/accounts`, { error: { code: 'rate_limited', message: 'x' } }, 429);
    expect((await stopOf(signup(fetch, API))).message).toBe('Too many requests; retry in a moment (request req-made-up-9).');
  });
});

describe('createKey', () => {
  const view = {
    id: 'key_madeup',
    label: 'demo',
    allowance: null,
    dailyBudget: '1',
    maxPrice: '0.02',
    expiresAt: null,
    createdAt: '2026-11-09T10:00:00.000Z',
    key: PAYMENT,
  };

  it('sends the limits with the master key and reads them back in micro-USD', async () => {
    const { fetch, calls } = answering(`POST ${API}/v1/keys`, view, 201);
    const created = await createKey(fetch, API, MASTER, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
    expect(created).toMatchObject({ id: 'key_madeup', key: PAYMENT });
    expect(shownLimits(created.answer)).toEqual({
      id: 'key_madeup',
      label: 'demo',
      dailyBudget: 1_000_000n,
      maxPrice: 20_000n,
      allowance: null,
      expiresAt: null,
    });
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${MASTER}`);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
  });

  it('takes the key when its limits can not be read, and shows those as unknown', async () => {
    const { fetch } = answering(`POST ${API}/v1/keys`, { ...view, id: null, label: 42, dailyBudget: 1, maxPrice: 'lots' }, 201);
    const created = await createKey(fetch, API, MASTER, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
    expect(created).toMatchObject({ id: undefined, key: PAYMENT });
    expect(shownLimits(created.answer)).toEqual({
      id: undefined,
      label: undefined,
      dailyBudget: undefined,
      maxPrice: undefined,
      allowance: null,
      expiresAt: null,
    });
    expect(shownLimits('not an object').dailyBudget).toBeUndefined();
  });

  it('says a payment key may exist when the key of a 201 can not be read', async () => {
    const { fetch } = answering(`POST ${API}/v1/keys`, { ...view, key: MASTER }, 201);
    expect((await stopOf(createKey(fetch, API, MASTER, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' }))).message).toBe(
      "Anyfare's answer has no key this app can read: a payment key may have been created, and it can't be saved. List the keys with the master key (GET /v1/keys), revoke that one, and create another.",
    );
  });
});

describe('balance and keyStatus', () => {
  it('read the amounts', async () => {
    const { fetch } = answering(`GET ${API}/v1/balance`, { available: '1.5', held: '0.011' });
    expect(await balance(fetch, API, MASTER)).toEqual({ available: 1_500_000n, held: 11_000n });
    const status = answering(`GET ${PAY}/_/key`, {
      id: 'key_madeup',
      label: null,
      allowance: '5',
      dailyBudget: '1',
      maxPrice: null,
      expiresAt: null,
      remaining: { allowance: '4.5', dailyBudget: '0.9', balance: '1.5' },
    });
    expect(await keyStatus(status.fetch, PAY, PAYMENT)).toMatchObject({
      label: null,
      allowance: 5_000_000n,
      maxPrice: null,
      remaining: { allowance: 4_500_000n, dailyBudget: 900_000n, balance: 1_500_000n },
    });
    expect(status.calls[0]?.headers['authorization']).toBe(`Bearer ${PAYMENT}`);
  });

  it('refuse a balance that is not an amount', async () => {
    for (const available of ['-1', '1e3', 1, null]) {
      const { fetch } = answering(`GET ${API}/v1/balance`, { available, held: '0' });
      expect((await stopOf(balance(fetch, API, MASTER))).message).toContain('available is missing or not valid');
    }
    const { fetch } = answering(`GET ${PAY}/_/key`, { id: 'key_madeup', dailyBudget: '1' });
    expect((await stopOf(keyStatus(fetch, PAY, PAYMENT))).message).toContain('remaining is missing or not valid');
  });

  it('give the proxy line for a master key on /_/key', async () => {
    const { fetch } = answering(`GET ${PAY}/_/key`, { error: { code: 'wrong_key_type', message: 'x' } }, 401);
    expect((await stopOf(keyStatus(fetch, PAY, MASTER))).message).toBe(
      'That is a master key; paid calls take a payment key (request req-made-up-9).',
    );
  });
});
