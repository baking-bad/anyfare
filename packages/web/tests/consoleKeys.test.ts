import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider } from '../src/components/Settings';
import { changeKey, ConsoleApiError, createKey, isTopupsOff, listKeys, listPayments, listTopups, revokeKey, type Payment, type PaymentKey, type Topup } from '../src/console/api';
import { ConsolePlacesProvider } from '../src/console/context';
import { shortUtc, utcDate } from '../src/console/format';
import { barClass, budgetShare, changeBody, emptyKeyForm, endOfDay, formOfKey, formProblems, isActive, isExpired, isHot, keyName, keysInOrder, newKeyBody, spentToday, type KeyForm } from '../src/console/keys';
import { KeysPage } from '../src/console/KeysPage';
import { PaymentRow } from '../src/console/PaymentRow';
import { PaymentsPage } from '../src/console/PaymentsPage';
import { cursorNow, filtersOfQuery, firstPage, hasFilters, hasNewer, hostOf, newer, older, paymentAmount, paymentBadge, queryOfFilters, receiptUrl } from '../src/console/payments';
import { resetSessionForTests, signIn } from '../src/console/session';
import { networkName, topupBadge, topupCredits } from '../src/console/topup/status';
import { TopupRow } from '../src/console/topup/TopupRow';
import { ToastProvider } from '../src/console/components/Toast';

// Keys, Payments and the Overview's lists: what is worked out from the API's answers and from a form, how the requests
// go out, and what the pages print for text that comes from outside. The keys here are made up for these tests.

const apiUrl = 'https://api.example.test';
const masterKey = 'afm_test_0123456789abcdef0123456789ab3f9a';
const now = Date.parse('2026-11-12T10:00:00.000Z');

const keyOf = (overrides: Partial<PaymentKey> = {}): PaymentKey => ({
  id: 'key_aaaaaaaaaaaa',
  label: 'research agent',
  allowance: '20',
  dailyBudget: '5',
  maxPrice: '0.05',
  expiresAt: '2026-12-31T23:59:59.000Z',
  createdAt: '2026-11-11T09:00:00.000Z',
  revokedAt: null,
  spent: { today: '1', total: '12.4' },
  remaining: { allowance: '7.6', dailyBudget: '4' },
  ...overrides,
});

const paymentOf = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'pay_sample0001',
  requestId: 'req_1',
  rail: 'near',
  targetHost: 'api.example.com',
  targetPath: '/v1/sample/lookup',
  amount: '0.01',
  status: 'paid',
  createdAt: '2026-11-12T09:12:00.000Z',
  updatedAt: '2026-11-12T09:12:01.000Z',
  keyId: 'key_aaaaaaaaaaaa',
  upstreamStatus: 200,
  state: 'paid',
  ...overrides,
});

const topupOf = (overrides: Partial<Topup> = {}): Topup => ({
  id: 'top_1',
  status: 'credited',
  message: 'Added to your balance.',
  network: 'base',
  token: 'USDC',
  amount: '20',
  credited: '19.99',
  estimatedCredits: null,
  createdAt: '2026-11-12T08:00:00.000Z',
  ...overrides,
});

describe('the form of a key', () => {
  const form = (overrides: Partial<KeyForm> = {}): KeyForm => ({ ...emptyKeyForm, ...overrides });

  it('starts with a budget of 5.00 a day and no other limit', () => {
    expect(emptyKeyForm).toEqual({ label: '', dailyBudget: '5.00', maxPrice: '', allowance: '', expires: '' });
    expect(formProblems(emptyKeyForm, now)).toEqual({});
  });

  it('wants numbers with at most 6 decimals, above zero, and says which field is wrong', () => {
    expect(Object.keys(formProblems(form({ dailyBudget: '' }), now))).toEqual(['dailyBudget']);
    expect(Object.keys(formProblems(form({ dailyBudget: '1.1234567' }), now))).toEqual(['dailyBudget']);
    expect(Object.keys(formProblems(form({ dailyBudget: '1,5' }), now))).toEqual(['dailyBudget']);
    expect(Object.keys(formProblems(form({ dailyBudget: '0' }), now))).toEqual(['dailyBudget']);
    expect(Object.keys(formProblems(form({ dailyBudget: '-1' }), now))).toEqual(['dailyBudget']);
    expect(Object.keys(formProblems(form({ maxPrice: 'abc', allowance: '1e3' }), now)).sort()).toEqual(['allowance', 'maxPrice']);
    expect(formProblems(form({ dailyBudget: '0.000001', maxPrice: '0.05', allowance: '100.5' }), now)).toEqual({});
  });

  it('allows a name of 60 characters and no more', () => {
    expect(formProblems(form({ label: 'n'.repeat(60) }), now)).toEqual({});
    expect(Object.keys(formProblems(form({ label: 'n'.repeat(61) }), now))).toEqual(['label']);
  });

  it('wants an expiry that is a real day in the future, and sends the end of that day in UTC', () => {
    expect(endOfDay('2026-12-31')).toBe('2026-12-31T23:59:59.000Z');
    expect(endOfDay('2026-11-31')).toBeUndefined();
    expect(endOfDay('tomorrow')).toBeUndefined();
    expect(formProblems(form({ expires: '2026-11-12' }), now)).toEqual({});
    expect(Object.keys(formProblems(form({ expires: '2026-11-11' }), now))).toEqual(['expires']);
    expect(Object.keys(formProblems(form({ expires: '2026-13-01' }), now))).toEqual(['expires']);
  });

  it('sends only the fields that are filled for a new key', () => {
    expect(newKeyBody(emptyKeyForm)).toEqual({ dailyBudget: '5.00' });
    expect(newKeyBody(form({ label: '  my agent ', maxPrice: '0.05', allowance: ' 20 ', expires: '2026-12-31' }))).toEqual({
      label: 'my agent',
      dailyBudget: '5.00',
      maxPrice: '0.05',
      allowance: '20',
      expiresAt: '2026-12-31T23:59:59.000Z',
    });
  });

  it('fills the form from a key', () => {
    expect(formOfKey(keyOf())).toEqual({ label: 'research agent', dailyBudget: '5', maxPrice: '0.05', allowance: '20', expires: '2026-12-31' });
    expect(formOfKey(keyOf({ label: null, maxPrice: null, allowance: null, expiresAt: null }))).toEqual({ label: '', dailyBudget: '5', maxPrice: '', allowance: '', expires: '' });
  });

  it('sends only what changed in a change, and null for a field that was emptied', () => {
    const key = keyOf();

    expect(changeBody(formOfKey(key), key)).toEqual({});
    expect(changeBody({ ...formOfKey(key), dailyBudget: '10.00' }, key)).toEqual({ dailyBudget: '10.00' });
    // The same number written another way is no change
    expect(changeBody({ ...formOfKey(key), dailyBudget: '5.00', allowance: '20.0' }, key)).toEqual({});
    expect(changeBody({ ...formOfKey(key), label: '', maxPrice: '', allowance: '', expires: '' }, key)).toEqual({ label: null, maxPrice: null, allowance: null, expiresAt: null });
    expect(changeBody({ ...formOfKey(key), label: ' renamed ' }, key)).toEqual({ label: 'renamed' });
    // A new limit on a key that had none
    const open = keyOf({ maxPrice: null, allowance: null, expiresAt: null, label: null });
    expect(changeBody({ ...formOfKey(open), maxPrice: '0.1', expires: '2027-01-15' }, open)).toEqual({ maxPrice: '0.1', expiresAt: '2027-01-15T23:59:59.000Z' });
  });

  it('keeps the time of an expiry whose day was not changed', () => {
    const key = keyOf({ expiresAt: '2026-12-31T10:30:00.000Z' });

    expect(changeBody(formOfKey(key), key)).toEqual({});
    expect(changeBody({ ...formOfKey(key), expires: '2027-01-01' }, key)).toEqual({ expiresAt: '2027-01-01T23:59:59.000Z' });
  });
});

describe('what the table of keys works out', () => {
  it('sums what the keys spent today without float noise', () => {
    const keys = [keyOf({ spent: { today: '0.1', total: '1' } }), keyOf({ spent: { today: '0.2', total: '1' } }), keyOf({ spent: { today: '0.000001', total: '1' } })];

    expect(spentToday(keys)).toBe(0.300001);
    expect(spentToday([])).toBe(0);
  });

  it('counts a key as active when it is neither revoked nor expired', () => {
    expect(isActive(keyOf(), now)).toBe(true);
    expect(isActive(keyOf({ expiresAt: null }), now)).toBe(true);
    expect(isActive(keyOf({ revokedAt: '2026-11-12T09:00:00.000Z' }), now)).toBe(false);
    expect(isActive(keyOf({ expiresAt: '2026-11-12T09:59:59.000Z' }), now)).toBe(false);
    expect(isExpired(keyOf({ expiresAt: '2026-11-12T10:00:00.000Z' }), now)).toBe(true);
    expect(isExpired(keyOf({ expiresAt: null }), now)).toBe(false);
  });

  it('shows the revoked keys after the active ones, each group in the API\'s order', () => {
    const [a, b, c, d] = [keyOf({ id: 'a' }), keyOf({ id: 'b', revokedAt: '2026-11-12T09:00:00.000Z' }), keyOf({ id: 'c' }), keyOf({ id: 'd', revokedAt: '2026-11-12T09:00:00.000Z' })];

    expect(keysInOrder([a!, b!, c!, d!]).map(key => key.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('turns the budget bar yellow above 80 %, in steps of 5 %', () => {
    expect(budgetShare(keyOf({ spent: { today: '4', total: '0' } }))).toBe(0.8);
    expect(isHot(0.8)).toBe(false);
    expect(isHot(0.81)).toBe(true);
    expect(budgetShare(keyOf({ spent: { today: '9', total: '0' } }))).toBe(1);
    expect(budgetShare(keyOf({ dailyBudget: '0' }))).toBe(0);
    expect(barClass(0)).toBe('bar-0');
    expect(barClass(0.84)).toBe('bar-85');
    expect(barClass(1)).toBe('bar-100');
  });

  it('names a key by its label, or says it has no name', () => {
    expect(keyName(keyOf())).toBe('research agent');
    expect(keyName(keyOf({ label: null }))).toBe('No name');
  });

  it('prints dates in UTC', () => {
    expect(shortUtc('2026-11-12T09:12:45.000Z')).toBe('12 Nov, 09:12');
    expect(shortUtc('nope')).toBe('-');
    expect(utcDate('2026-12-31T23:59:59.000Z')).toBe('31 Dec 2026');
  });
});

describe('the filters of the Payments page', () => {
  const keyIds = ['key_aaaaaaaaaaaa', 'key_bbbbbbbbbbbb'];

  it('read back a key of the account, a host and a state', () => {
    expect(filtersOfQuery('?key=key_bbbbbbbbbbbb&service=API.Example.com&state=free', keyIds)).toEqual({ key: 'key_bbbbbbbbbbbb', service: 'api.example.com', state: 'free' });
    expect(filtersOfQuery('', keyIds)).toEqual({});
  });

  it('drop a state that is none of the three', () => {
    for (const state of ['paid ', 'PAID', 'refunded', '', '<script>', 'paid&state=free'])
      expect(filtersOfQuery(`?state=${encodeURIComponent(state)}`, keyIds), state).toEqual({});
  });

  it('drop a service that is not a host', () => {
    for (const service of ['<img onerror=1>', 'a b.com', 'https://api.example.com/x', 'api.example.com/path', '-bad.com', '', 'a'.repeat(300), 'api..com'])
      expect(filtersOfQuery(`?service=${encodeURIComponent(service)}`, keyIds), service).toEqual({});
    expect(filtersOfQuery('?service=fake-api.test%3A8186', keyIds)).toEqual({ service: 'fake-api.test:8186' });
  });

  it('drop a key that is not in the account\'s list, and every key while the list is not known', () => {
    expect(filtersOfQuery('?key=key_zzzzzzzzzzzz', keyIds)).toEqual({});
    expect(filtersOfQuery('?key=%3Cscript%3E', keyIds)).toEqual({});
    expect(filtersOfQuery('?key=key_aaaaaaaaaaaa', [])).toEqual({});
  });

  it('ignore every other parameter, and read only the first of a repeated one', () => {
    expect(filtersOfQuery('?next=%2F%2Fevil.test&limit=1000&after=x&state=paid&state=free', keyIds)).toEqual({ state: 'paid' });
  });

  it('write back only filters that passed, in the address', () => {
    expect(queryOfFilters({})).toBe('');
    expect(queryOfFilters({ key: 'key_aaaaaaaaaaaa', service: 'api.example.com', state: 'paid' })).toBe('?key=key_aaaaaaaaaaaa&service=api.example.com&state=paid');
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ state: 'free' })).toBe(true);
  });

  it('take a host in any case with spaces around it, and nothing else', () => {
    expect(hostOf('  Api.Example.COM ')).toBe('api.example.com');
    expect(hostOf('localhost')).toBe('localhost');
    expect(hostOf('')).toBeUndefined();
    expect(hostOf('exa mple.com')).toBeUndefined();
  });
});

describe('the cursors of the pager', () => {
  it('keep the cursor of each page that was seen, and go back through them', () => {
    let cursors = firstPage;
    expect(cursorNow(cursors)).toBeUndefined();
    expect(hasNewer(cursors)).toBe(false);
    cursors = older(cursors, 'cur_b');
    cursors = older(cursors, 'cur_c');

    expect(cursors.seen).toEqual([undefined, 'cur_b', 'cur_c']);
    expect(cursorNow(cursors)).toBe('cur_c');
    expect(hasNewer(cursors)).toBe(true);
    cursors = newer(cursors);
    expect(cursorNow(cursors)).toBe('cur_b');
    cursors = newer(newer(cursors));
    expect(cursorNow(cursors)).toBeUndefined();
    expect(cursors).toStrictEqual(firstPage);
  });
});

describe('the badges and amounts of a payment', () => {
  it('shows a paid call as Paid and its amount charged, by the site\'s money rule', () => {
    expect(paymentBadge(paymentOf())).toEqual({ tone: 'success', text: 'Paid' });
    expect(paymentAmount(paymentOf())).toEqual({ text: '−$0.01', muted: false });
    expect(paymentAmount(paymentOf({ amount: '12.5' }))).toEqual({ text: '−$12.50', muted: false });
  });

  it('shows a free call with its API status, or as Free without one, and its amount as $0', () => {
    expect(paymentBadge(paymentOf({ state: 'free', status: 'free', upstreamStatus: 502 }))).toEqual({ tone: 'danger', text: '502 · free' });
    expect(paymentBadge(paymentOf({ state: 'free', status: 'free', upstreamStatus: null }))).toEqual({ tone: 'danger', text: 'Free' });
    expect(paymentAmount(paymentOf({ state: 'free', amount: '0.01' }))).toEqual({ text: '$0', muted: false });
  });

  it('shows a call in flight as In flight, with its amount in a muted tone', () => {
    expect(paymentBadge(paymentOf({ state: 'pending', upstreamStatus: null }))).toEqual({ tone: 'info', text: 'In flight' });
    expect(paymentAmount(paymentOf({ state: 'pending' }))).toEqual({ text: '$0.01', muted: true });
  });

  it('leads a finished call to its public receipt, and a call in flight to none', () => {
    expect(receiptUrl('https://site.example.test', paymentOf())).toBe('https://site.example.test/calls/pay_sample0001');
    expect(receiptUrl('https://site.example.test', paymentOf({ state: 'free' }))).toBe('https://site.example.test/calls/pay_sample0001');
    expect(receiptUrl('https://site.example.test', paymentOf({ state: 'pending' }))).toBeUndefined();
    expect(receiptUrl('https://site.example.test', paymentOf({ id: 'a/../b' }))).toBe('https://site.example.test/calls/a%2F..%2Fb');
  });
});

describe('the badge of a top-up', () => {
  it('has a color for each status', () => {
    const tones = Object.fromEntries(['credited', 'quoting', 'waiting', 'processing', 'incomplete', 'refunded', 'expired', 'failed', 'quote_failed', 'quote_unknown'].map(status => [status, topupBadge(status).tone]));

    expect(tones).toEqual({
      credited: 'success',
      quoting: 'info',
      waiting: 'info',
      processing: 'info',
      incomplete: 'warning',
      refunded: 'warning',
      expired: 'warning',
      failed: 'danger',
      quote_failed: 'danger',
      quote_unknown: 'danger',
    });
    expect(topupBadge('credited').label).toBe('Added');
    expect(topupBadge('something_new')).toEqual({ tone: 'neutral', label: 'something new' });
  });

  it('shows the Credits added, an estimate while the top-up is open, and nothing otherwise', () => {
    expect(topupCredits(topupOf())).toEqual({ text: '+$19.99', tone: 'added' });
    expect(topupCredits(topupOf({ status: 'processing', credited: null, estimatedCredits: '19.84' }))).toEqual({ text: '≈ $19.84', tone: 'estimate' });
    expect(topupCredits(topupOf({ status: 'processing', credited: null, estimatedCredits: null }))).toBeNull();
    expect(topupCredits(topupOf({ status: 'failed', credited: null, estimatedCredits: '19.84' }))).toBeNull();
    expect(['near', 'base', 'arbitrum', 'solana', 'ethereum', 'bitcoin', 'tempo'].map(networkName)).toEqual(['NEAR', 'Base', 'Arbitrum', 'Solana', 'Ethereum', 'Bitcoin', 'Tempo']);
    expect(networkName('toString')).toBe('ToString');
  });
});

// ---------- The requests ----------

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

let sent: Sent[];
let answer: () => Response;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  sent = [];
  answer = () => json(200, {});
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (name: string) => store.get(name) ?? null, setItem: (name: string, value: string) => void store.set(name, value), removeItem: (name: string) => void store.delete(name), clear: () => store.clear() });
  vi.stubGlobal('location', { origin: 'https://console.example.test' });
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });

    return answer();
  }));
  resetSessionForTests();
  signIn(masterKey);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSessionForTests();
});

describe('the requests of Keys, Payments and the Overview', () => {
  it('list the keys with the master key, and check the shape of each', async () => {
    answer = () => json(200, { keys: [keyOf(), keyOf({ id: 'key_b', label: null, maxPrice: null, allowance: null, expiresAt: null, remaining: { allowance: null, dailyBudget: '5' } })] });

    expect((await listKeys(apiUrl)).map(key => key.id)).toEqual(['key_aaaaaaaaaaaa', 'key_b']);
    expect(sent[0]!.url).toBe('https://api.example.test/v1/keys');
    expect((sent[0]!.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${masterKey}`);
    for (const bad of [{}, { keys: 'no' }, { keys: [{}] }, { keys: [{ ...keyOf(), dailyBudget: 'lots' }] }, { keys: [{ ...keyOf(), spent: { today: '1' } }] }, { keys: [{ ...keyOf(), expiresAt: 'soon' }] }]) {
      answer = () => json(200, bad);
      await expect(listKeys(apiUrl)).rejects.toMatchObject({ code: 'unexpected_answer' });
    }
  });

  it('make a key with only the fields given, and hand back the payment key beside the key', async () => {
    const secret = 'af_test_0123456789abcdef0123456789abcdef';
    answer = () => json(201, { ...keyOf(), key: secret });

    const made = await createKey(apiUrl, { label: 'my agent', dailyBudget: '5.00' });

    expect(made.paymentKey).toBe(secret);
    expect(made.key).not.toHaveProperty('key');
    expect(JSON.stringify(made.key)).not.toContain(secret);
    expect(sent[0]!.init.method).toBe('POST');
    expect(sent[0]!.url).not.toContain(secret);
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({ label: 'my agent', dailyBudget: '5.00' });
    answer = () => json(201, keyOf());
    await expect(createKey(apiUrl, { dailyBudget: '5' })).rejects.toMatchObject({ code: 'unexpected_answer' });
  });

  it('change and revoke a key on its own path, with the id encoded', async () => {
    answer = () => json(200, keyOf({ maxPrice: null }));
    expect((await changeKey(apiUrl, 'key_a/../b', { maxPrice: null })).maxPrice).toBeNull();
    answer = () => json(200, { id: 'key_a', revokedAt: '2026-11-12T10:00:00.000Z' });
    expect(await revokeKey(apiUrl, 'key_a')).toEqual({ id: 'key_a', revokedAt: '2026-11-12T10:00:00.000Z' });

    expect(sent.map(request => `${request.init.method} ${request.url}`)).toEqual([
      'PATCH https://api.example.test/v1/keys/key_a%2F..%2Fb',
      'DELETE https://api.example.test/v1/keys/key_a',
    ]);
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({ maxPrice: null });
  });

  it('carry the API\'s refusal of a field, with its message, as an error', async () => {
    answer = () => json(400, { error: { code: 'invalid_request', message: 'dailyBudget is a USD amount' } });

    await expect(createKey(apiUrl, { dailyBudget: 'x' })).rejects.toMatchObject({ status: 400, code: 'invalid_request', message: 'dailyBudget is a USD amount' });
    answer = () => json(404, { error: { code: 'not_found', message: 'There is no such key' } });
    await expect(changeKey(apiUrl, 'key_x', { label: 'a' })).rejects.toBeInstanceOf(ConsoleApiError);
  });

  it('list payments with only the parameters the API knows, and none that are unset', async () => {
    answer = () => json(200, { payments: [paymentOf()], next: 'cur_pay_sample0001' });

    const page = await listPayments(apiUrl, { limit: 20, after: 'cur_x', state: 'free', keyId: 'key_a', service: 'api.example.com' });
    await listPayments(apiUrl, { limit: 5 });

    expect(page).toEqual({ payments: [paymentOf()], next: 'cur_pay_sample0001' });
    const names = (request: Sent): string[] => [...new URL(request.url).searchParams.keys()].sort();
    expect(names(sent[0]!)).toEqual(['after', 'keyId', 'limit', 'service', 'state']);
    expect(names(sent[1]!)).toEqual(['limit']);
    expect(new URL(sent[0]!.url).pathname).toBe('/v1/payments');
  });

  it('check the shape of each payment, and of the cursor', async () => {
    for (const bad of [{ payments: [{ ...paymentOf(), state: 'refunded' }], next: null }, { payments: [{ ...paymentOf(), amount: 'x' }], next: null }, { payments: [{ ...paymentOf(), upstreamStatus: '502' }], next: null }, { payments: [paymentOf()], next: 5 }, { payments: {} }]) {
      answer = () => json(200, bad);
      await expect(listPayments(apiUrl, { limit: 20 })).rejects.toMatchObject({ code: 'unexpected_answer' });
    }
    answer = () => json(200, { payments: [{ ...paymentOf(), requestId: null, keyId: null, upstreamStatus: null }], next: null });
    expect((await listPayments(apiUrl, { limit: 20 })).payments[0]).toMatchObject({ requestId: null, keyId: null, upstreamStatus: null });
  });

  it('list top-ups with only limit and after, and know when top-ups are off', async () => {
    answer = () => json(200, { topups: [topupOf()], next: null });

    expect((await listTopups(apiUrl, 5)).topups).toHaveLength(1);
    await listTopups(apiUrl, 5, 'cur_a');
    expect([...new URL(sent[0]!.url).searchParams.keys()]).toEqual(['limit']);
    expect([...new URL(sent[1]!.url).searchParams.keys()].sort()).toEqual(['after', 'limit']);
    answer = () => json(503, { error: { code: 'topups_unavailable', message: 'Top-ups are off' } });
    const off = await listTopups(apiUrl, 5).catch((error: unknown) => error);
    expect(isTopupsOff(off)).toBe(true);
    expect(isTopupsOff(new ConsoleApiError(503, 'api_unavailable', 'x'))).toBe(false);
    answer = () => json(200, { topups: [{ ...topupOf(), amount: 'many' }], next: null });
    await expect(listTopups(apiUrl, 5)).rejects.toMatchObject({ code: 'unexpected_answer' });
  });
});

// ---------- What the pages print ----------

const settings = { apiUrl, payUrl: 'https://pay.example.test', consoleUrl: 'https://console.example.test' };
const page = (child: ReactElement): string => renderToStaticMarkup(
  createElement(SettingsProvider, {
    value: settings,
    children: createElement(ConsolePlacesProvider, { value: { siteUrl: 'https://site.example.test', overviewPath: '/' }, children: createElement(ToastProvider, { children: child }) }),
  }),
);

describe('what the pages print', () => {
  it('renders the server\'s Keys and Payments as loading shells, with no account data and no query text', () => {
    for (const element of [createElement(KeysPage), createElement(PaymentsPage)]) {
      const html = page(element);

      expect(html).not.toContain(masterKey);
      expect(html).not.toMatch(/af_(live|test)_/);
      expect(html).not.toMatch(/<form\b|\sstyle="/);
    }
    expect(page(createElement(KeysPage))).toContain('One key per agent.');
    expect(page(createElement(KeysPage))).toContain('curl https://pay.example.test/_/key -H &quot;Authorization: Bearer $ANYFARE_PAYMENT_KEY&quot;');
    expect(page(createElement(PaymentsPage))).toContain('Every paid call of your keys, newest first.');
  });

  it('prints a host, a path and a key name from outside as text, in a link to the receipt that opens in a new tab', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = page(createElement('table', null, createElement('tbody', null, createElement(PaymentRow, {
      payment: paymentOf({ targetHost: evil, targetPath: `/${evil}` }),
      keyNames: new Map([['key_aaaaaaaaaaaa', evil]]),
      siteUrl: 'https://site.example.test',
    }))));

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('href="https://site.example.test/calls/pay_sample0001"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });

  it('gives a call in flight no link, a free call its danger badge, and a key it does not know a dash', () => {
    const row = (payment: Payment): string => page(createElement('table', null, createElement('tbody', null, createElement(PaymentRow, { payment, keyNames: new Map(), siteUrl: 'https://site.example.test', chevron: true }))));

    expect(row(paymentOf({ state: 'pending', upstreamStatus: null }))).not.toContain('<a ');
    expect(row(paymentOf({ state: 'pending', upstreamStatus: null }))).toContain('In flight');
    expect(row(paymentOf({ state: 'free', upstreamStatus: 502 }))).toContain('502 · free');
    expect(row(paymentOf({ keyId: 'key_unknown' }))).toContain('<span class="muted">-</span>');
    expect(row(paymentOf())).toContain('class="stack-row pay-row click"');
  });

  it('prints a top-up\'s amount, token, network, badge and Credits', () => {
    const html = page(createElement('table', null, createElement('tbody', null, createElement(TopupRow, { topup: topupOf() }))));

    expect(html).toContain('20 USDC');
    expect(html).toContain('on Base');
    expect(html).toContain('stack-row');
    expect(html).toContain('badge success');
    expect(html).toContain('+$19.99');
  });
});
