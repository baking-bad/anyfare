import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from '../src/components/CopyButton';
import { SettingsProvider } from '../src/components/Settings';
import { agentPageOf, curlOfPage } from '../src/console/agentRequests';
import { ConsoleApiError, createTopup, createTopupTimeoutMs, listTopups, readTopup, readTopupOptions, topupOf, type Topup, type TopupOptions } from '../src/console/api';
import { ConsoleDataProvider, ConsolePlacesProvider, latestTopupsSize, onItsWayRefreshMs, topupOnItsWay } from '../src/console/context';
import { resetSessionForTests, signIn } from '../src/console/session';
import { amountAfterPick, checkAmount, linkFill, plainDecimal, sameAmount, underMinimum } from '../src/console/topup/amounts';
import { apiRequests, createSender, isUnanswered, matchOf, recoveryListSize, refusalOf, requestAddress } from '../src/console/topup/create';
import { DepositAddress } from '../src/console/topup/DepositAddress';
import { defaultChoice, filterChoices, isDollarToken, tokenChoices, tokenParam, tokensMissing } from '../src/console/topup/options';
import { pollMs, startPolling, type PollClock, type PollPage } from '../src/console/topup/poll';
import { QrCode, qrModules, qrPath } from '../src/console/topup/QrCode';
import { TopupForm } from '../src/console/topup/TopupForm';
import { afterFailedRead, afterRead, cardInView, listPageSize, openingView, restoreListSize } from '../src/console/topup/TopupPage';
import { TopupRow, topupTransactionLink } from '../src/console/topup/TopupRow';
import { TopupView } from '../src/console/topup/TopupView';
import { countdownText, isOpenStatus, saysTheSame, showsAddress, stepMarks, timeLeft, topupStatuses, utcClock, viewOf } from '../src/console/topup/view';

// The console's Top up page: the amount and token checks, the link's amount, the view of each status, the one POST
// that is never sent twice, the reads every few seconds, and the address that is the API's string everywhere it shows.
// Every address, key and hash here is a plain sample.

const apiUrl = 'https://api.example.test';
const masterKey = 'afm_test_0123456789abcdef0123456789ab3f9a';
const now = Date.parse('2026-11-12T10:00:00.000Z');
const address = `0x${'a'.repeat(40)}`;

const topupOfTest = (overrides: Partial<Topup> = {}): Topup => ({
  id: 'top_sample1',
  status: 'waiting',
  message: 'Waiting for your transfer',
  network: 'base',
  token: 'USDC',
  amount: '20',
  depositAddress: address,
  depositMemo: null,
  send: '20',
  sendAtLeast: '19.9',
  estimatedCredits: '19.98',
  payBy: '2026-11-12T11:00:00.000Z',
  addressExpiresAt: '2026-11-12T11:00:00.000Z',
  createdAt: '2026-11-12T09:59:30.000Z',
  updatedAt: '2026-11-12T09:59:30.000Z',
  deposited: null,
  credited: null,
  transaction: null,
  refunded: null,
  refundReason: null,
  ...overrides,
});

const options: TopupOptions = {
  asset: 'USDC on NEAR',
  networks: [
    { name: 'bitcoin', minimum: '10', tokens: [{ symbol: 'BTC', decimals: 8 }] },
    { name: 'base', minimum: '1', tokens: [{ symbol: 'ETH', decimals: 18 }, { symbol: 'USDC', address: `0x${'1'.repeat(40)}`, decimals: 6 }] },
    { name: 'arbitrum', minimum: '1', tokens: [{ symbol: 'USDC', address: `0x${'2'.repeat(40)}`, decimals: 6 }, { symbol: 'USDC', address: `0x${'8'.repeat(40)}`, decimals: 6 }] },
    { name: 'near', minimum: '1', tokens: [{ symbol: 'wNEAR', address: 'wrap.sample.near', decimals: 24 }] },
  ],
};

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

let sent: Sent[];
let answers: (() => Response | Promise<Response>)[];

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  sent = [];
  answers = [];
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => void storage.set(name, value), removeItem: (name: string) => void storage.delete(name), clear: () => storage.clear(), key: () => null, length: 0 });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('location', { origin: 'https://console.example.test' });
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    const next = answers.shift();
    if (next === undefined)
      throw new TypeError('No answer');

    return next();
  }));
  resetSessionForTests();
  signIn(masterKey);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionForTests();
});

const providers = (child: ReactElement): ReactElement => createElement(SettingsProvider, {
  value: { apiUrl, payUrl: 'https://pay.example.test', consoleUrl: 'https://console.example.test' },
  children: createElement(ConsolePlacesProvider, { value: { siteUrl: 'https://site.example.test', overviewPath: '/' }, children: createElement(ConsoleDataProvider, { children: child }) }),
});
const render = (child: ReactElement): string => renderToStaticMarkup(providers(child));

describe('the amount of a top-up', () => {
  const usdc = { symbol: 'USDC', decimals: 6 };

  it('is a positive decimal with at most the token\'s decimals', () => {
    expect(checkAmount('20', usdc)).toEqual({ ok: true, amount: '20' });
    expect(checkAmount(' 5.123456 ', usdc)).toEqual({ ok: true, amount: '5.123456' });
    expect(checkAmount('5.1234567', usdc)).toEqual({ ok: false, problem: 'USDC has at most 6 decimals.' });
    expect(checkAmount('0.00000001', { symbol: 'BTC', decimals: 8 })).toMatchObject({ ok: true });
    expect(checkAmount('0.000000001', { symbol: 'BTC', decimals: 8 })).toMatchObject({ ok: false });
    expect(checkAmount(`0.${'0'.repeat(23)}1`, { symbol: 'wNEAR', decimals: 24 })).toMatchObject({ ok: true });
    expect(checkAmount('1.5', { symbol: 'XYZ', decimals: 0 })).toEqual({ ok: false, problem: 'XYZ has no decimals.' });
    for (const bad of ['', '0', '0.000', '-1', '1e3', 'abc', '.5', '5.', '+5', '0x10', '1 000', 'Infinity'])
      expect(checkAmount(bad, usdc).ok, bad).toBe(false);
    // A comma is never read as a point, nor as a thousands separator
    expect(checkAmount('1,000', usdc)).toEqual({ ok: false, problem: 'Use a point for decimals, such as 5.50, and no thousands separator.' });
  });

  it('is checked against the network\'s least only for a dollar token', () => {
    for (const symbol of ['USDC', 'USDT', 'USDC.e', 'DAI', 'usdc'])
      expect(isDollarToken(symbol), symbol).toBe(true);
    for (const symbol of ['ETH', 'BTC', 'wNEAR', 'USDC2', 'SOL'])
      expect(isDollarToken(symbol), symbol).toBe(false);
    expect(underMinimum('4.99', { symbol: 'USDC', minimum: '5' })).toBe(true);
    expect(underMinimum('5', { symbol: 'USDT', minimum: '5' })).toBe(false);
    // Any other token is the API's to check: it answers amount_too_small
    expect(underMinimum('0.0001', { symbol: 'ETH', minimum: '5' })).toBeUndefined();
  });

  it('compares as a decimal, never as a float', () => {
    expect(plainDecimal('005.50')).toBe('5.5');
    expect(plainDecimal('20.000')).toBe('20');
    expect(sameAmount('5.50', '5.5')).toBe(true);
    expect(sameAmount('0.1', '0.10000000000000000001')).toBe(false);
  });
});

describe('a top-up link\'s amount', () => {
  it('fills a dollar token\'s field, and leaves any other token\'s empty with a line', () => {
    expect(linkFill(5, 'USDC')).toEqual({ kind: 'fill', value: '5' });
    expect(linkFill(7.25, 'DAI')).toEqual({ kind: 'fill', value: '7.25' });
    expect(linkFill(5, 'ETH')).toEqual({ kind: 'ask', line: 'The link asked for about $5.00. Enter how much ETH to send for that.' });
  });

  it('is never kept as another token\'s amount when the person picks one', () => {
    expect(amountAfterPick('5', { symbol: 'USDC' }, { symbol: 'ETH' }, 5)).toBe('');
    expect(amountAfterPick('', { symbol: 'ETH' }, { symbol: 'USDC' }, 5)).toBe('5');
    expect(amountAfterPick('9', { symbol: 'USDC' }, { symbol: 'USDT' }, 5)).toBe('9');
    // Without a link, an amount stays only between two dollar tokens
    expect(amountAfterPick('20', { symbol: 'USDC' }, { symbol: 'DAI' }, undefined)).toBe('20');
    expect(amountAfterPick('20', { symbol: 'USDC' }, { symbol: 'BTC' }, undefined)).toBe('');
    expect(amountAfterPick('0.1', { symbol: 'ETH' }, { symbol: 'USDC' }, undefined)).toBe('');
  });

  const form = (link: Parameters<typeof TopupForm>[0]['link'], value: TopupOptions = options, inProgress?: Topup, sending = false): string => render(createElement(TopupForm, {
    options: { state: 'ok', value }, optionsAgain: () => undefined, link, inProgress, sending, refusal: undefined, onOpen: () => undefined, onSend: () => undefined, onChange: () => undefined,
  }));

  it('fills the form for the first USDC and says it came from the link', () => {
    const html = form({ kind: 'used', amount: 5 });

    expect(html).toContain('$5.00 from the link');
    expect(html).toContain('Only the amount came from it.');
    expect(html).toMatch(/<input[^>]*id="topup-amount"[^>]*value="5"/);
    expect(html).toContain('From the link');
    expect(html).toContain('USDC · Base');
    expect(html).toContain('At least $1.00');
    expect(html).toContain('inputMode="decimal"');
  });

  it('leaves a token that is not a dollar empty, with the line of what the link asked for', () => {
    const html = form({ kind: 'used', amount: 5 }, { asset: 'USDC on NEAR', networks: [options.networks[0]!] });

    expect(html).toMatch(/<input[^>]*id="topup-amount"[^>]*value=""/);
    expect(html).toContain('The link asked for about $5.00. Enter how much BTC to send for that.');
    expect(html).not.toContain('From the link');
  });

  it('says an amount that was not used, and links the top-up in progress', () => {
    const html = form({ kind: 'unused' }, options, topupOfTest());

    expect(html).toContain('The amount in the link was not used');
    expect(html).toContain('It wasn&#x27;t a number from $1 to $1,000. Enter the amount yourself.');
    expect(html).toContain('You have a top-up in progress');
    expect(html).toContain('Open it');
    expect(form({ kind: 'none' })).not.toMatch(/from the link|was not used/);
  });

  it('keeps a form shown again disabled while the page\'s request runs, and says an address is being made', () => {
    const html = form({ kind: 'none' }, options, undefined, true);

    expect(html).toMatch(/<button[^>]*class="btn primary xl loading topup-go"[^>]*disabled=""/);
    expect(html).toContain('A deposit address is being made');
    expect(form({ kind: 'none' })).not.toContain('is being made');
  });

  it('opens the form, never a top-up, whatever is open', () => {
    const newest = { state: 'ok' as const, value: { topups: [topupOfTest()], readAt: now } };

    expect(openingView({ kind: 'used', amount: 5 }, newest)).toEqual({ kind: 'form' });
    expect(openingView({ kind: 'unused' }, newest)).toEqual({ kind: 'form' });
    // The newest top-up is a snapshot from the list: its address waits for its own read
    expect(openingView({ kind: 'none' }, newest)).toMatchObject({ kind: 'topup', topup: { id: 'top_sample1' }, confirmed: false });
    expect(openingView({ kind: 'none' }, { state: 'ok', value: { topups: [topupOfTest({ status: 'credited' }), topupOfTest({ id: 'top_older' })], readAt: now } })).toEqual({ kind: 'form' });
    expect(openingView({ kind: 'none' }, { state: 'loading' })).toBeUndefined();
    expect(openingView({ kind: 'none' }, { state: 'failed', error: new Error('x') })).toEqual({ kind: 'form' });
    expect([restoreListSize, listPageSize]).toEqual([20, 10]);
  });
});

describe('the tokens', () => {
  const choices = tokenChoices(options);

  it('start with USDC on the first network that has it, else the first token', () => {
    expect(defaultChoice(choices)).toMatchObject({ network: 'base', symbol: 'USDC' });
    expect(defaultChoice(tokenChoices({ asset: 'x', networks: [options.networks[0]!, options.networks[3]!] }))).toMatchObject({ symbol: 'BTC' });
    expect(defaultChoice([])).toBeUndefined();
  });

  it('name a token by its address when two of the network share its symbol', () => {
    const arbitrum = choices.filter(choice => choice.network === 'arbitrum');

    expect(arbitrum.map(tokenParam)).toEqual([`0x${'2'.repeat(40)}`, `0x${'8'.repeat(40)}`]);
    expect(tokenParam(defaultChoice(choices)!)).toBe('USDC');
    expect(new Set(choices.map(choice => choice.key)).size).toBe(choices.length);
  });

  it('are found by symbol and by network, in any case', () => {
    expect(filterChoices(choices, 'usdc', '').map(choice => choice.network)).toEqual(['base', 'arbitrum', 'arbitrum']);
    expect(filterChoices(choices, 'near', '').map(choice => choice.symbol)).toEqual(['wNEAR']);
    expect(filterChoices(choices, 'usdc base', '')).toHaveLength(1);
    expect(filterChoices(choices, '', 'bitcoin').map(choice => choice.symbol)).toEqual(['BTC']);
    expect(filterChoices(choices, 'eth', 'arbitrum')).toEqual([]);
  });

  it('are missing when the options came without them', () => {
    expect(tokensMissing(options)).toBe(false);
    expect(tokensMissing({ asset: 'x', networks: [{ name: 'base', minimum: '1' }] })).toBe(true);
    expect(tokenChoices({ asset: 'x', networks: [{ name: 'base', minimum: '1' }] })).toEqual([]);
  });
});

describe('the view of a top-up', () => {
  it('has a view for every status, and shows the address only while waiting or incomplete', () => {
    const views = Object.fromEntries(topupStatuses.map(status => [status, viewOf(topupOfTest({ status }), now)]));

    expect(views).toEqual({
      quoting: 'quoting', quote_failed: 'noAddress', quote_unknown: 'noAddress', waiting: 'waiting', incomplete: 'incomplete', processing: 'processing',
      credited: 'credited', refunded: 'refunded', failed: 'failed', expired: 'expired',
    });
    expect(topupStatuses.filter(status => showsAddress(topupOfTest({ status }), now))).toEqual(['waiting', 'incomplete']);
    expect(topupStatuses.filter(isOpenStatus)).toEqual(['quoting', 'waiting', 'incomplete', 'processing']);
    expect(viewOf(topupOfTest({ status: 'something_new' }), now)).toBe('unknown');
    expect(showsAddress(topupOfTest({ status: 'something_new' }), now)).toBe(false);
    expect(showsAddress(topupOfTest({ depositAddress: null }), now)).toBe(false);
  });

  it('hides the address when the countdown reaches zero, before the API says expired', () => {
    const topup = topupOfTest();
    const payBy = Date.parse(topup.payBy);

    expect(countdownText(timeLeft(topup.payBy, now))).toBe('01:00:00');
    expect(countdownText(timeLeft(topup.payBy, payBy - 1_500))).toBe('00:00:01');
    expect(showsAddress(topup, payBy - 1)).toBe(true);
    expect(viewOf(topup, payBy)).toBe('timeUp');
    expect(showsAddress(topup, payBy)).toBe(false);
    expect(showsAddress(topupOfTest({ status: 'incomplete' }), payBy + 60_000)).toBe(false);
    expect(timeLeft('not a time', now)).toBe(0);
  });

  it('marks the four steps by status', () => {
    expect(stepMarks('quoting', null)).toEqual(['now', 'next', 'next', 'next']);
    expect(stepMarks('waiting', null)).toEqual(['done', 'now', 'next', 'next']);
    expect(stepMarks('processing', '20')).toEqual(['done', 'done', 'now', 'next']);
    expect(stepMarks('credited', '20')).toEqual(['done', 'done', 'done', 'done']);
    expect(stepMarks('refunded', '20')).toEqual(['done', 'done', 'stopped', 'next']);
    expect(stepMarks('timeUp', null)).toEqual(['done', 'stopped', 'next', 'next']);
    expect(stepMarks('noAddress', null)).toEqual(['stopped', 'next', 'next', 'next']);
    expect(stepMarks('failed', null)).toEqual(['done', 'stopped', 'next', 'next']);
  });

  it('says the API\'s message once, beside the page\'s own line', () => {
    expect(saysTheSame('Received. Converting', 'Received. Converting.')).toBe(true);
    expect(saysTheSame('Not added. We hold the amount for you and will return it. Contact us', 'Not added.')).toBe(true);
    expect(saysTheSame('Waiting for your transfer', 'Send at least')).toBe(false);
    expect(utcClock(Date.parse('2026-11-12T10:42:05.000Z'))).toBe('10:42:05 UTC');
  });

  const view = (topup: Topup, failedAt?: number): string => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);

    return render(createElement(TopupView, { shown: { topup, readAt: now - 7_000, confirmed, ...failedAt === undefined ? {} : { failedAt } }, onNew: () => undefined }));
  };
  let confirmed = true;
  afterEach(() => {
    confirmed = true;
  });

  it('holds the address of a snapshot until the top-up\'s own read answers, and shows none when that read failed', () => {
    confirmed = false;
    const held = view(topupOfTest());
    expect(held).not.toContain(address);
    expect(held).not.toContain('QR code');
    expect(held).toContain('Reading the top-up…');
    expect(held).toContain('Send only USDC on Base');

    const failed = view(topupOfTest(), now);
    expect(failed).not.toContain(address);
    expect(failed).not.toContain('Reading the top-up');
    expect(failed).toContain('Can&#x27;t refresh right now.');
    expect(failed).toContain('The address shows once this top-up can be read again.');

    confirmed = true;
    expect(view(topupOfTest())).toContain(address);
  });

  it('never puts another top-up\'s answer in the place of the one on screen', () => {
    const shownB = { kind: 'topup' as const, topup: topupOfTest({ id: 'top_b', depositAddress: `0x${'b'.repeat(40)}` }), readAt: now, confirmed: false };
    const lateA = topupOfTest({ id: 'top_a', depositAddress: `0x${'a'.repeat(40)}` });

    // A slow answer for A, after B was opened
    expect(afterRead(shownB, lateA, now + 1)).toBe(shownB);
    expect(afterRead({ kind: 'form' }, lateA, now + 1)).toEqual({ kind: 'form' });
    expect(afterFailedRead(shownB, 'top_a', now + 1)).toBe(shownB);
    // B's own answer confirms it, and a failure marks it
    expect(afterRead(shownB, { ...shownB.topup, status: 'incomplete' }, now + 2)).toEqual({ kind: 'topup', topup: { ...shownB.topup, status: 'incomplete' }, readAt: now + 2, confirmed: true });
    expect(afterFailedRead(shownB, 'top_b', now + 3)).toEqual({ ...shownB, failedAt: now + 3 });
  });

  it('prints each status from the API\'s answer, and the address only while it can take a transfer', () => {
    const waiting = view(topupOfTest({ depositMemo: '424242' }));
    expect(waiting).toContain(`>${address}</code>`);
    expect(waiting).toContain('QR code of the deposit address');
    expect(waiting).toContain('Deposit address, USDC on Base');
    expect(waiting).toContain('Send with this memo. A transfer without it can&#x27;t be matched.');
    expect(waiting).toContain('Send only USDC on Base. Money sent after the time runs out may be lost.');
    expect(waiting).toContain('Send at least 19.9 USDC');
    expect(waiting).toContain('01:00:00');
    expect(waiting).toContain('Pay by 12 Nov 2026, 11:00 UTC');
    expect(waiting).toContain('Waiting for your transfer');

    const incomplete = view(topupOfTest({ status: 'incomplete', deposited: '12' }));
    expect(incomplete).toContain(address);
    expect(incomplete).toContain('We got 12 USDC. We need at least 19.9 USDC. Send the rest before the time runs out.');

    const credited = view(topupOfTest({ status: 'credited', message: 'Added to your balance', credited: '19.97', transaction: `SampTx2${'1'.repeat(37)}` }));
    expect(credited).toContain('Added 19.97 Credits');
    expect(credited).toContain(`href="https://nearblocks.io/txns/SampTx2${'1'.repeat(37)}"`);
    expect(credited).toContain('The transaction on NearBlocks');
    expect(view(topupOfTest({ status: 'credited', credited: '19.97', transaction: null }))).not.toContain('nearblocks');

    const refunded = view(topupOfTest({ status: 'refunded', message: 'Not added. We hold the amount for you and will return it. Contact us', refunded: '20', refundReason: '<b>slipped</b>' }));
    expect(refunded).toContain('We hold 20 USDC for you and will return it.');
    expect(refunded).toContain('href="mailto:hello@bakingbad.dev"');
    expect(refunded).toContain('&lt;b&gt;slipped&lt;/b&gt;');
    expect(refunded.match(/Not added\./g)).toHaveLength(1);

    for (const [status, line] of [['quoting', 'Getting a deposit address'], ['processing', 'Received. Converting.'], ['expired', 'The time to pay ran out. Don&#x27;t send to this address.'],
      ['failed', 'Stopped. We are looking into it.'], ['quote_failed', 'No deposit address was made. Nothing to send.'], ['quote_unknown', 'No deposit address was made. Nothing to send.']] as const) {
      const html = view(topupOfTest({ status, message: null }));
      expect(html, status).toContain(line);
      expect(html, status).not.toContain(address);
      expect(html, status).not.toContain('QR code');
      expect(html, status).toContain('New top-up');
    }
    expect(view(topupOfTest({ status: 'failed' }))).toContain('The top-up id is <code class="topup-code">top_sample1</code>');
  });

  it('replaces the address at zero, and never shows a stale waiting message for it', () => {
    const html = view(topupOfTest({ payBy: '2026-11-12T09:59:59.000Z' }));

    expect(html).not.toContain(address);
    expect(html).not.toContain('QR code');
    expect(html).toContain('The time to pay ran out. Don&#x27;t send to this address.');
    expect(html).not.toContain('Waiting for your transfer');
  });

  it('says when it can\'t refresh, with the time of the last good read', () => {
    expect(view(topupOfTest(), now)).toContain('Can&#x27;t refresh right now. Last read at 09:59:53 UTC.');
    expect(view(topupOfTest())).not.toContain('refresh');
  });

  it('prints the facts of this top-up as the API gave them', () => {
    const html = view(topupOfTest({ amount: '0.000000000000000000000001', token: 'wNEAR', network: 'near', sendAtLeast: null, estimatedCredits: null }));

    expect(html).toContain('0.000000000000000000000001 wNEAR on NEAR');
    expect(html).toContain('12 Nov 2026, 09:59 UTC');
    expect(html).toContain('top_sample1');
    expect(html).toContain('Leave this page if you like. It comes back here when you return.');
  });
});

describe('the deposit address', () => {
  // Every element of a tree, with function components left as elements: what the component hands its parts
  const elementsOf = (node: ReactNode): ReactElement[] => {
    if (Array.isArray(node))
      return (node as readonly ReactNode[]).flatMap(item => elementsOf(item));
    if (!isValidElement(node))
      return [];
    const { children } = node.props as { readonly children?: ReactNode };

    return [node, ...elementsOf(children)];
  };

  it('is the API\'s string, and only that, in the QR code, the box and the copy button', () => {
    const odd = `0x${'5'.repeat(20)}AbC${'9'.repeat(17)}`;
    const tree = elementsOf(DepositAddress({ address: odd, memo: null, token: 'USDC', network: 'base' }));
    const qr = tree.filter(element => element.type === QrCode);
    const copies = tree.filter(element => element.type === CopyButton);
    const boxes = tree.filter(element => (element.props as { readonly className?: string }).className === 'addr-box');

    expect(qr.map(element => (element.props as { readonly value: string }).value)).toEqual([odd]);
    expect(copies.map(element => (element.props as { readonly text: string }).text)).toEqual([odd]);
    expect(boxes.map(element => (element.props as { readonly children: string }).children)).toEqual([odd]);
    expect(renderToStaticMarkup(DepositAddress({ address: odd, memo: null, token: 'USDC', network: 'base' }))).toContain(`<code class="addr-box">${odd}</code>`);
  });

  it('copies the memo from its own box, and never puts it in the QR code', () => {
    const tree = elementsOf(DepositAddress({ address, memo: '424242', token: 'USDC', network: 'base' }));

    expect(tree.filter(element => element.type === CopyButton).map(element => (element.props as { readonly text: string }).text)).toEqual([address, '424242']);
    expect(tree.filter(element => element.type === QrCode).map(element => (element.props as { readonly value: string }).value)).toEqual([address]);
  });

  it('draws the QR code as one path on a white square, with no style, and none for a string it can\'t encode exactly', () => {
    const html = renderToStaticMarkup(createElement(QrCode, { value: address }));
    const modules = qrModules(address)!;

    expect(html).toMatch(/^<span class="qr"><svg role="img" aria-label="QR code of the deposit address" viewBox="0 0 (\d+) \1"/);
    expect(html.match(/<path /g)).toHaveLength(1);
    expect(html).toContain('<rect width=');
    expect(html).not.toMatch(/style=/);
    expect(modules.length).toBeGreaterThanOrEqual(21);
    expect(qrPath(modules).match(/M/g)).toHaveLength(modules.flat().filter(Boolean).length);
    // A character outside printable ASCII would not read back as itself
    for (const bad of ['', 'bc1q​xyz', 'адрес', 'a'.repeat(3000)])
      expect(renderToStaticMarkup(createElement(QrCode, { value: bad })), bad.slice(0, 10)).toBe('');
  });
});

describe('the requests of a top-up', () => {
  it('read the options with no key, and check their shape', async () => {
    answers.push(() => json(200, { asset: 'USDC on NEAR', networks: [{ name: 'base', minimum: '1', tokens: [{ symbol: 'USDC', address: '0x1', decimals: 6 }, { symbol: 'ETH', decimals: 18 }] }, { name: 'near', minimum: '1' }] }));

    expect(await readTopupOptions(apiUrl)).toEqual({ asset: 'USDC on NEAR', networks: [{ name: 'base', minimum: '1', tokens: [{ symbol: 'USDC', address: '0x1', decimals: 6 }, { symbol: 'ETH', decimals: 18 }] }, { name: 'near', minimum: '1' }] });
    expect(sent[0]!.url).toBe(`${apiUrl}/v1/topups/options`);
    expect(JSON.stringify(sent[0]!.init.headers).toLowerCase()).not.toContain('authorization');
    for (const bad of [{ networks: [] }, { asset: 'x', networks: [{ name: 'base', minimum: 'one' }] }, { asset: 'x', networks: [{ name: 'base', minimum: '1', tokens: [{ symbol: 'USDC', decimals: 6.5 }] }] }]) {
      answers.push(() => json(200, bad));
      await expect(readTopupOptions(apiUrl)).rejects.toMatchObject({ code: 'unexpected_answer' });
    }
  });

  it('send the POST with only network, token and amount, and wait a minute for it', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    answers.push(() => json(201, topupOfTest()));

    expect(await createTopup(apiUrl, { network: 'base', token: 'USDC', amount: '20' })).toMatchObject({ id: 'top_sample1', depositAddress: address });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ network: 'base', token: 'USDC', amount: '20' });
    expect(createTopupTimeoutMs).toBe(60_000);
    expect(timeout).toHaveBeenCalledWith(60_000);
  });

  it('read a top-up by its id, and refuse an answer for another one', async () => {
    answers.push(() => json(200, topupOfTest()));
    expect((await readTopup(apiUrl, 'top_sample1')).depositAddress).toBe(address);
    expect(sent[0]!.url).toBe(`${apiUrl}/v1/topups/top_sample1`);
    answers.push(() => json(200, topupOfTest({ id: 'top_other' })));
    await expect(readTopup(apiUrl, 'top_sample1')).rejects.toMatchObject({ code: 'unexpected_answer' });
    answers.push(() => json(200, topupOfTest({ id: 'a/../b' })));
    await readTopup(apiUrl, 'a/../b');
    expect(sent[2]!.url).toBe(`${apiUrl}/v1/topups/a%2F..%2Fb`);
  });

  it('refuse an address or a memo that can\'t be shown, copied and encoded as it is', () => {
    expect(topupOf(topupOfTest({ depositMemo: 'memo 42' })).depositMemo).toBe('memo 42');
    for (const bad of [{ depositAddress: '0xabc def' }, { depositAddress: '0x​abc' }, { depositAddress: '' }, { depositMemo: ' 42' }, { amount: '1e3' }, { payBy: 'soon' }, { transaction: 5 }])
      expect(() => topupOf({ ...topupOfTest(), ...bad }), JSON.stringify(bad)).toThrow(ConsoleApiError);
    expect(() => topupOf({ ...topupOfTest(), updatedAt: undefined })).toThrow(ConsoleApiError);
  });

  it('list with only limit and after', async () => {
    answers.push(() => json(200, { topups: [topupOfTest()], next: 'cur_1' }));
    answers.push(() => json(200, { topups: [], next: null }));
    await listTopups(apiUrl, 10);
    await listTopups(apiUrl, 10, 'cur_1');

    expect(sent.map(request => new URL(request.url).search)).toEqual(['?limit=10', '?limit=10&after=cur_1']);
  });
});

describe('the one POST of a top-up', () => {
  const body = { network: 'base', token: 'USDC', amount: '20.00' };
  const clickedAt = Date.parse('2026-11-12T10:00:00.000Z');
  const posts = (): number => sent.filter(request => request.init.method === 'POST').length;

  it('opens the answer of a POST that was answered', async () => {
    answers.push(() => json(201, topupOfTest()));

    expect(await requestAddress(apiRequests(apiUrl), body, 'USDC', clickedAt)).toMatchObject({ kind: 'made', topup: { id: 'top_sample1' } });
    expect(sent).toHaveLength(1);
  });

  it('never sends it again: on no answer it reads the newest top-ups and opens the one that matches', async () => {
    answers.push(() => Promise.reject(new TypeError('connection reset')));
    answers.push(() => json(200, { topups: [topupOfTest({ id: 'top_other', amount: '5' }), topupOfTest({ id: 'top_match', createdAt: '2026-11-12T10:00:02.000Z' })], next: null }));

    expect(await requestAddress(apiRequests(apiUrl), body, 'USDC', clickedAt)).toMatchObject({ kind: 'found', topup: { id: 'top_match' } });
    expect(posts()).toBe(1);
    expect(sent.map(request => `${request.init.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual(['POST /v1/topups', `GET /v1/topups?limit=${recoveryListSize}`]);
  });

  it('says the address was not made when no top-up matches, and that it can\'t tell when the list fails too', async () => {
    answers.push(() => Promise.reject(new TypeError('timeout')));
    answers.push(() => json(200, { topups: [topupOfTest({ createdAt: '2026-11-12T09:58:00.000Z' }), topupOfTest({ id: 'top_eth', token: 'ETH' }), topupOfTest({ id: 'top_arb', network: 'arbitrum' })], next: null }));
    expect(await requestAddress(apiRequests(apiUrl), body, 'USDC', clickedAt)).toEqual({ kind: 'notMade' });

    answers.push(() => Promise.reject(new TypeError('timeout')));
    answers.push(() => Promise.reject(new TypeError('still down')));
    expect(await requestAddress(apiRequests(apiUrl), body, 'USDC', clickedAt)).toMatchObject({ kind: 'unknown' });
    expect(posts()).toBe(2);
  });

  it('reads the list too after an answer no one can read or a server error the API doesn\'t name, and never after a refusal', async () => {
    answers.push(() => json(201, { id: 'top_x' }));
    answers.push(() => json(200, { topups: [topupOfTest({ createdAt: '2026-11-12T10:00:01.000Z' })], next: null }));
    expect(await requestAddress(apiRequests(apiUrl), body, 'USDC', clickedAt)).toMatchObject({ kind: 'found' });
    answers.push(() => new Response('<html>Gateway timeout</html>', { status: 504 }));
    answers.push(() => json(200, { topups: [], next: null }));
    expect(await requestAddress(apiRequests(apiUrl), body, 'USDC', clickedAt)).toEqual({ kind: 'notMade' });
    expect(posts()).toBe(2);
    expect(sent).toHaveLength(4);

    for (const [status, code] of [[400, 'amount_too_small'], [400, 'ambiguous_token'], [429, 'rate_limited'], [502, 'topup_mismatch'], [503, 'topups_unavailable']] as const) {
      sent = [];
      answers.push(() => json(status, { error: { code, message: `The API says ${code}` } }));
      expect(await requestAddress(apiRequests(apiUrl), body, 'USDC', clickedAt), code).toMatchObject({ kind: 'refused' });
      expect(sent, code).toHaveLength(1);
    }
  });

  it('sends one POST for a double click, and for Enter and a click, while the first runs', async () => {
    const sender = createSender();
    let answer: (response: Response) => void = () => undefined;
    answers.push(() => new Promise<Response>(resolve => {
      answer = resolve;
    }));
    const press = () => sender.send(() => requestAddress(apiRequests(apiUrl), body, 'USDC', clickedAt));

    const first = press();
    // The second click of a double click, then Enter in the field, then a click: all before any answer
    expect([press(), press(), press()]).toEqual([undefined, undefined, undefined]);
    expect(sender.running()).toBe(true);
    await Promise.resolve();
    expect(posts()).toBe(1);
    answer(json(201, topupOfTest()));
    expect(await first).toMatchObject({ kind: 'made' });
    expect(sender.running()).toBe(false);
    // Once it ended, the person may ask again
    answers.push(() => json(201, topupOfTest({ id: 'top_next' })));
    expect(await press()).toMatchObject({ kind: 'made', topup: { id: 'top_next' } });
    expect(posts()).toBe(2);
  });

  it('matches only the same network, token and amount, made since a minute before the click', () => {
    const asked = { network: 'base', symbol: 'usdc', amount: '20.0' };
    expect(matchOf([topupOfTest({ createdAt: '2026-11-12T09:59:01.000Z' })], asked, clickedAt)?.id).toBe('top_sample1');
    expect(matchOf([topupOfTest({ createdAt: '2026-11-12T09:58:59.000Z' })], asked, clickedAt)).toBeUndefined();
    expect(matchOf([topupOfTest({ amount: '20.000001' })], asked, clickedAt)).toBeUndefined();
    expect(isUnanswered(new ConsoleApiError(0, 'api_unavailable', 'x'))).toBe(true);
    expect(isUnanswered(new ConsoleApiError(400, 'invalid_amount', 'x'))).toBe(false);
  });

  it('heads each refusal with the page\'s own words and the API\'s message as text', () => {
    const refused = (status: number, code: string) => refusalOf({ kind: 'refused', error: new ConsoleApiError(status, code, '<i>said</i>') }, 'Base');

    expect(refused(400, 'amount_too_small')).toEqual({ code: 'amount_too_small', title: 'Under the least for Base', text: '<i>said</i>' });
    expect(refused(503, 'topups_unavailable')).toEqual({ code: 'topups_unavailable', title: 'Top-ups from Base are paused', text: '<i>said</i> Calls keep working. Try another token, or come back later.' });
    expect(refusalOf({ kind: 'notMade' }, 'Base').title).toBe('The address was not made');
    expect(refusalOf({ kind: 'unknown', error: new Error('x') }, 'Base').title).toBe('We can\'t tell whether the address was made');
  });
});

describe('the reads of an open top-up', () => {
  // A clock and a tab a test moves by hand
  const harness = () => {
    let visible = true;
    let listener: (() => void) | undefined;
    const timers: { run: () => void; ms: number }[] = [];
    const clock: PollClock = { schedule: (run, ms) => timers.push({ run, ms }) && timers.at(-1), cancel: handle => void timers.splice(timers.indexOf(handle as never), 1) };
    const page: PollPage = { visible: () => visible, onVisibilityChange: next => (listener = next, () => (listener = undefined)) };

    return {
      clock, page, timers,
      fire: () => timers.shift()?.run(),
      hide: () => {
        visible = false;
        listener?.();
      },
      show: () => {
        visible = true;
        listener?.();
      },
      listening: () => listener !== undefined,
    };
  };
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 5; round += 1)
      await Promise.resolve();
  };

  it('read every 5 seconds until the status is final, then stop', async () => {
    const tab = harness();
    const statuses = ['waiting', 'processing', 'credited'];
    const read = vi.fn(async () => topupOfTest({ status: statuses.shift() ?? 'credited' }));
    const seen: string[] = [];
    const stop = startPolling({ read, onRead: topup => seen.push(topup.status), onFail: () => undefined, done: topup => !isOpenStatus(topup.status) }, tab.page, tab.clock);

    expect(tab.timers.map(timer => timer.ms)).toEqual([pollMs]);
    expect(pollMs).toBe(5_000);
    for (let round = 0; round < 3; round += 1) {
      tab.fire();
      await settle();
    }
    expect(seen).toEqual(['waiting', 'processing', 'credited']);
    expect(tab.timers).toEqual([]);
    tab.show();
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    stop();
    expect(tab.listening()).toBe(false);
  });

  it('read nothing while the tab is hidden, and at once when it shows again', async () => {
    const tab = harness();
    const read = vi.fn(async () => topupOfTest());
    startPolling({ read, onRead: () => undefined, onFail: () => undefined, done: () => false }, tab.page, tab.clock);

    tab.hide();
    expect(tab.timers).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    tab.show();
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(tab.timers.map(timer => timer.ms)).toEqual([pollMs]);
  });

  it('keep going after a failed read, and drop an answer that comes after the stop', async () => {
    const tab = harness();
    let fail = true;
    const read = vi.fn(async () => {
      if (fail)
        throw new ConsoleApiError(0, 'api_unavailable', 'x');

      return topupOfTest();
    });
    const failed: unknown[] = [];
    const seen: Topup[] = [];
    const stop = startPolling({ read, onRead: topup => seen.push(topup), onFail: error => failed.push(error), done: () => false }, tab.page, tab.clock, pollMs, true);

    await settle();
    expect(failed).toHaveLength(1);
    expect(tab.timers).toHaveLength(1);
    fail = false;
    tab.fire();
    stop();
    await settle();
    expect(seen).toEqual([]);
    expect(tab.timers).toEqual([]);
  });
});

describe('the list of top-ups', () => {
  const row = (topup: Topup): string => renderToStaticMarkup(createElement('table', null, createElement('tbody', null, createElement(TopupRow, { topup, onOpen: () => undefined }))));

  it('opens a top-up from its row, and links a credited one\'s transaction on NearBlocks', () => {
    const hash = `SampTx3${'1'.repeat(37)}`;
    const credited = row(topupOfTest({ status: 'credited', credited: '19.97', transaction: hash }));

    expect(credited).toContain('<button type="button" class="row-link topup-open">');
    expect(credited).toContain(`href="https://nearblocks.io/txns/${hash}"`);
    expect(credited).toContain('>NearBlocks<');
    expect(row(topupOfTest())).not.toContain('nearblocks');
    // Credits added are cut, never rounded up past what was credited
    expect(row(topupOfTest({ status: 'credited', credited: '2.99814' }))).toContain('+$2.99');
    expect(row(topupOfTest({ status: 'credited', credited: '2.99814' }))).not.toContain('$3.00');
    expect(topupTransactionLink({ status: 'credited', transaction: 'not a hash!' })).toBeUndefined();
    expect(topupTransactionLink({ status: 'waiting', transaction: hash })).toBeUndefined();
  });
});

describe('a top-up on its way, in the frame', () => {
  it('is the newest of the frame\'s top-ups that is still open, and none when the read failed or holds none', () => {
    const list = (topups: Topup[]) => ({ state: 'ok' as const, value: { topups, next: null } });

    expect(topupOnItsWay(list([topupOfTest({ id: 'top_done', status: 'credited' }), topupOfTest({ id: 'top_open', status: 'processing' }), topupOfTest({ id: 'top_older' })]))?.id).toBe('top_open');
    expect(topupOnItsWay(list([topupOfTest({ status: 'expired' }), topupOfTest({ status: 'quote_failed' })]))).toBeUndefined();
    expect(topupOnItsWay({ state: 'failed', error: new ConsoleApiError(503, 'topups_unavailable', 'off') })).toBeUndefined();
    expect(topupOnItsWay({ state: 'loading' })).toBeUndefined();
    expect([latestTopupsSize, onItsWayRefreshMs]).toEqual([5, 15_000]);
  });

  it('scrolls to the card only when it is out of view', () => {
    expect(cardInView(120, 88, 900)).toBe(true);
    expect(cardInView(40, 88, 900)).toBe(false);
    expect(cardInView(-300, 88, 900)).toBe(false);
    expect(cardInView(700, 88, 900)).toBe(false);
  });
});

describe('the Agent view of Top up', () => {
  it('lists the options with no key, the POST, the read by id and the list, with the link\'s amount in the body', () => {
    expect(agentPageOf('topup').requests.map(request => `${request.method} ${request.path} ${request.keyed ? 'keyed' : 'no key'}`)).toEqual([
      'GET /v1/topups/options no key', 'POST /v1/topups keyed', 'GET /v1/topups/<top-up id> keyed', 'GET /v1/topups?limit=10 keyed',
    ]);
    expect(agentPageOf('topup').requests[1]!.body).toBe('{"network":"base","token":"USDC","amount":"20"}');
    expect(agentPageOf('topup', 7.25).requests[1]!.body).toBe('{"network":"base","token":"USDC","amount":"7.25"}');
    const curl = curlOfPage(apiUrl, 'topup', 5);
    expect(curl).toContain(`curl ${apiUrl}/v1/topups/options\n\n`);
    expect(curl).toContain('-d \'{"network":"base","token":"USDC","amount":"5"}\'');
    expect(curl).not.toMatch(/afm_(live|test)_[A-Za-z0-9]/);
  });
});
