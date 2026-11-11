import { describe, expect, it } from 'vitest';

import type { ApiResult, ReadOptions, Reader } from '../src/api/reader';
import { maxLinkLength, readCheckAnswer, type PayableCheck } from '../src/check/answer';
import {
  agentPrompt, askRows, asksSentence, checkAddress, checkQuery, codeSamples, cut, describedAs, knownMethod, linkParts, maxDescriptionLength, offersPost, parseCheckParams, parseMethod, refusalWords, shellWord, titleFor, wayWords,
} from '../src/check/content';
import { checkRequests, loadCheck, loadCheckData } from '../src/check/data';
import { readSettings } from '../src/config';
import { checkMarkdown } from '../src/markdown/check';
import { pageForMarkdownUrl } from '../src/markdown/negotiate';
import { markdownPageFor } from '../src/markdown/pages';
import { answer, sampleCheck, sampleCheckHosts } from './support/fakeApi';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const settings = readSettings({ SITE_URL: 'https://site.example.com', API_URL: 'https://api.example.com', PAY_URL: 'https://pay.example.com', CONSOLE_URL: 'https://console.example.com' });

const check = (link: string): PayableCheck => {
  const read = readCheckAnswer(sampleCheck(link, now).body);
  if (read === undefined || !read.payable)
    throw new Error(`not payable: ${link}`);

  return read.check;
};

// A reader that answers from the fake, and counts its requests
const fakeReader = (): { readonly read: Reader; readonly asked: string[]; readonly sentHeaders: (Readonly<Record<string, string>> | undefined)[] } => {
  const asked: string[] = [];
  const sentHeaders: (Readonly<Record<string, string>> | undefined)[] = [];
  const read = (async (path: string, guard?: (value: unknown) => boolean, options?: ReadOptions): Promise<ApiResult<unknown>> => {
    asked.push(path);
    sentHeaders.push(options?.headers);
    const found = answer(new URL(`https://fake.example.com${path}`), 'full', now, options?.headers ?? {});
    if (found === undefined || found.status === 404)
      return { ok: false, error: { status: 404, code: 'not_found', message: 'Not found' } };
    if (found.status >= 400) {
      const error = (found.body as { error: { code: string; message: string } }).error;

      return { ok: false, error: { status: found.status, ...error } };
    }

    return guard !== undefined && !guard(found.body) ? { ok: false, error: { status: 502, code: 'unexpected_answer', message: 'x' } } : { ok: true, value: found.body };
  }) as Reader;

  return { read, asked, sentHeaders };
};

describe('the Check URL and its state', () => {
  it('reads url, tab, period and page, and drops what it does not know', () => {
    expect(parseCheckParams(new URLSearchParams('url=%20api.example.com%2Fv1%20&tab=headers&period=7d&page=3'))).toEqual({ url: 'api.example.com/v1', method: 'GET', tab: 'headers', period: '7d', page: 3 });
    expect(parseCheckParams({ tab: 'nope', period: 'nope', page: '0' })).toEqual({ url: '', method: 'GET', tab: 'overview', period: '30d', page: 1 });
    expect(parseCheckParams({ url: ['a.example.com', 'b.example.com'], page: ['2', '5'] })).toEqual({ url: 'a.example.com', method: 'GET', tab: 'overview', period: '30d', page: 2 });
    expect(parseCheckParams(new URLSearchParams('page=1.5&page=2')).page).toBe(1);
    expect(parseCheckParams(new URLSearchParams('page=99999')).page).toBe(1_000);
  });

  it('writes the URL in a fixed order without defaults, and the same state gives the same URL', () => {
    expect(checkAddress({ url: '', method: 'GET', tab: 'overview', period: '30d', page: 1 })).toBe('/check');
    expect(checkAddress({ url: 'api.example.com/v1', method: 'GET', tab: 'json', period: '7d', page: 2 })).toBe('/check?url=api.example.com%2Fv1&tab=json&period=7d&page=2');
    expect(checkAddress({ url: 'a.example.com', method: 'GET', tab: 'overview', period: 'all', page: 1 }, '/check.md')).toBe('/check.md?url=a.example.com&period=all');
    expect(checkAddress({ url: 'a.example.com', method: 'POST', tab: 'json', period: '30d', page: 1 })).toBe('/check?url=a.example.com&method=POST&tab=json');
    const state = parseCheckParams(new URLSearchParams('page=2&tab=code&url=a.example.com&period=today'));
    expect(parseCheckParams(new URLSearchParams(checkQuery(state).slice(1)))).toEqual(state);
  });

  it('reads the method, GET or POST in upper case, and takes GET for anything else', () => {
    for (const method of ['GET', 'POST'])
      expect(parseCheckParams({ method }).method).toBe(method);
    for (const method of ['post', 'Post', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', '', 'POST ', 'GET,POST'])
      expect(parseCheckParams({ method }).method).toBe('GET');
    expect(parseCheckParams({}).method).toBe('GET');
    expect(parseCheckParams({ method: ['POST', 'GET'] }).method).toBe('POST');
    expect(parseMethod(undefined)).toBe('GET');
    expect(knownMethod('POST')).toBe('POST');
    expect(knownMethod('post')).toBeUndefined();
    expect(knownMethod('DELETE')).toBeUndefined();
  });

  it('keeps the method in the URL only when it is not GET, and reads it back', () => {
    const state = parseCheckParams(new URLSearchParams('url=a.example.com&method=POST&tab=code'));

    expect(checkQuery(state)).toBe('?url=a.example.com&method=POST&tab=code');
    expect(parseCheckParams(new URLSearchParams(checkQuery(state).slice(1)))).toEqual(state);
    expect(checkQuery({ ...state, method: 'GET' })).toBe('?url=a.example.com&tab=code');
  });

  it('puts the method in the title, the prompt and the curl lines only when it is not GET', () => {
    expect(titleFor('api.example.com/v1')).toBe('Check: api.example.com/v1');
    expect(titleFor('api.example.com/v1', 'POST')).toBe('Check: POST api.example.com/v1');
    expect(agentPrompt('pay.example.com/a.example.com/v1', 'POST')).toMatch(/^Call pay\.example\.com\/a\.example\.com\/v1 with POST through Anyfare\./);
    expect(agentPrompt('pay.example.com/a.example.com/v1')).toMatch(/^Call pay\.example\.com\/a\.example\.com\/v1 through Anyfare\./);
    const post = codeSamples('pay.example.com/a.example.com/v1', 'POST');
    expect(post.key).toMatch(/^curl -X POST pay\.example\.com\/a\.example\.com\/v1 /);
    expect(post.byHand).toContain('curl -i -X POST pay.example.com/a.example.com/v1\n');
    expect(post.byHand).toContain('\ncurl -X POST pay.example.com/a.example.com/v1 \\\n');
    expect(post.prompt).toContain('with POST');
    const get = codeSamples('pay.example.com/a.example.com/v1');
    expect(get.key).not.toContain('-X');
    expect(get.byHand).not.toContain('-X');
  });

  it('says which method was tried when a link that is not GET is not paid, and offers POST only after a GET', () => {
    const refusal = { reason: 'not_payable', message: '' };

    expect(refusalWords(refusal).text).toContain('answered without asking');
    expect(refusalWords({ ...refusal, status: 200 }).text).toContain('This link answered 200 without asking');
    expect(refusalWords(refusal, 'POST').text).toContain('We sent POST to this link and it answered without asking');
    expect(offersPost(refusal, 'GET')).toBe(true);
    expect(offersPost(refusal, 'POST')).toBe(false);
    expect(offersPost({ reason: 'invalid_target', message: '' }, 'GET')).toBe(false);
  });

  it('keeps the link as the visitor typed it, query string and all', () => {
    const typed = 'api.example.com/v1/q?symbol=A B&x=1+2&y=%2F#frag';
    const state = parseCheckParams(new URLSearchParams(checkQuery({ url: typed, method: 'GET', tab: 'overview', period: '30d', page: 1 }).slice(1)));

    expect(state.url).toBe(typed);
  });

  it('is limited to 2,048 characters, and a longer link makes no request', async () => {
    const { read, asked } = fakeReader();
    const exact = `api.example.com/${'a'.repeat(maxLinkLength - 'api.example.com/'.length)}`;
    const tooLong = `${exact}a`;

    expect((await loadCheck(read, tooLong)).kind).toBe('refused');
    expect(asked).toEqual([]);
    expect((await loadCheck(read, exact)).kind).not.toBe('unavailable');
    expect(asked).toHaveLength(1);
    const state = await loadCheck(read, tooLong);
    expect(state.kind === 'refused' && state.refusal.reason).toBe('invalid_target');
    expect(await loadCheck(read, '')).toEqual({ kind: 'empty' });
    expect(asked).toHaveLength(1);
  });

  it('names the page after the link, cut at 80 characters', () => {
    expect(titleFor('')).toBe('Check a link');
    expect(titleFor('https://api.example.com/v1/quote?key=secret#x')).toBe('Check: api.example.com/v1/quote');
    expect(titleFor(`api.example.com/${'a'.repeat(200)}`)).toHaveLength(80);
    expect(titleFor(`api.example.com/${'a'.repeat(200)}`).endsWith('…')).toBe(true);
    expect(linkParts('http://api.example.com')).toEqual({ host: 'api.example.com', path: '' });
    expect(linkParts('api.example.com/a/b?c=d')).toEqual({ host: 'api.example.com', path: '/a/b' });
  });
});

describe('what the API asks, in words', () => {
  it('says the price, the asset, the chain, the protocol, who is paid and for how long, for x402', () => {
    const base = check('api.example.com/v1/sample/quotes/latest');
    const near = check('data.example.com/v1/sample/lookup');

    expect(asksSentence(base).plain).toBe(`This API asks $0.01 in USDC on Base for each call, over x402. It pays to 0x${'9a1f'.repeat(10)}. A signed payment is good for 60 seconds.`);
    expect(asksSentence(near).plain).toContain('$0.01 in USDC on NEAR for each call, over x402. It pays to merchant.sample.near.');
    expect(asksSentence(base).parts.filter(part => part.strong).map(part => part.text)).toEqual(['$0.01 in USDC on Base', 'x402']);
    expect(asksSentence(base).parts.find(part => part.code)?.text).toBe(`0x${'9a1f'.repeat(10)}`);
  });

  it('says the amount, the asset, the chain, the method and when the charge ends, for MPP', () => {
    const mpp = check('search.example.com/v1/sample/lookup');
    const sentence = asksSentence({ ...mpp, checkedAt: new Date(now).toISOString(), asks: { ...mpp.asks, expires: new Date(now + 25_000).toISOString() } }).plain;

    expect(sentence).toBe('This API asks $0.005 in USDC.e on Tempo for each call, over MPP. It wants a signed charge by the tempo method. The charge expires in about 25 seconds.');
    expect(asksSentence({ ...mpp, asks: { ...mpp.asks, expires: '2000-01-01T00:00:00Z' } }).plain).not.toContain('expires');
  });

  it('lists the rows of each protocol, and leaves out a value the answer lacks', () => {
    const base = askRows(check('api.example.com/v1/sample/quotes/latest'));
    const mpp = askRows(check('search.example.com/v1/sample/lookup'));

    expect(base.map(row => row.label)).toEqual(['Protocol', 'Network', 'Asset', 'Amount', 'Pays to', 'Answer type']);
    expect(base[0]!.value).toBe('x402 version 2, scheme exact');
    expect(base[3]!.value).toBe('10000 base units = $0.01');
    expect(mpp.map(row => row.label)).toEqual(['Protocol', 'Amount', 'Recipient', 'Realm', 'Expires']);
    expect(mpp[0]!.value).toBe('MPP, method tempo, intent charge');
    // No row without a value, on any protocol
    const empty = { asks: { amount: '', network: ' ', recipient: '', realm: '', expires: '', method: '', intent: '' }, upstream: { headers: [] }, price: undefined, checkedAt: undefined } as const;

    expect(askRows({ ...empty, protocol: 'mpp' }).map(row => row.label)).toEqual(['Protocol', 'Amount']);
    expect(askRows({ ...empty, protocol: 'x402' }).every(row => row.value.trim() !== '')).toBe(true);
    expect(askRows({ asks: {}, protocol: 'x402', upstream: { headers: [] }, price: undefined, checkedAt: undefined }).map(row => row.label)).toEqual(['Protocol']);
  });

  it('cuts a description at 300 characters, and a missing one is nothing', () => {
    expect(describedAs({ description: 'x'.repeat(400) })).toHaveLength(maxDescriptionLength);
    expect(describedAs({ description: 'short' })).toBe('short');
    expect(describedAs({ description: '   ' })).toBeUndefined();
    expect(describedAs({})).toBeUndefined();
    expect(cut('abc', 3)).toBe('abc');
  });

  it('words each way to pay in two lines, and an unknown one by its protocol', () => {
    expect(wayWords({ paidWith: 'near', protocol: 'x402', asset: 'USDC', amount: '0.01', currency: 'USD' })).toEqual({ name: 'USDC on NEAR', note: 'x402 · settles in about 2 s' });
    expect(wayWords({ paidWith: 'tempo', protocol: 'mpp', asset: 'USDC.e', amount: '0.01', currency: 'USD' }).name).toBe('USDC.e on Tempo');
    expect(wayWords({ paidWith: 'credits', protocol: 'key', asset: 'Credits', amount: '0.01', currency: 'USD' })).toEqual({ name: 'Credits, with a payment key', note: 'No transaction per call' });
    expect(wayWords({ paidWith: 'zeta', protocol: 'x402', asset: 'USDC', amount: '1', currency: 'USD' })).toEqual({ name: 'USDC on zeta', note: 'X402' });
  });
});

describe('the wording of a refusal', () => {
  const words = (reason: string, detail?: string, message = 'm') => refusalWords({ reason, message, ...detail === undefined ? {} : { detail } });

  it('has its title and text for each reason', () => {
    expect(words('not_payable')).toEqual({ title: 'Not a paid link', text: 'This link answered without asking for a payment. Anyfare checks paid links only: paste the link of one paid endpoint, the one that answers 402.' });
    expect(words('unsupported_payment')).toEqual({ title: 'A paid link we can\'t pay yet', text: 'This link asks for a payment, but in a way Anyfare doesn\'t make yet.' });
    expect(words('upstream_unavailable')).toEqual({ title: 'The link didn\'t answer', text: 'We couldn\'t reach this host. Check the link and try again.' });
    expect(words('invalid_target')).toEqual({ title: 'This isn\'t a link', text: 'Paste a full link to one endpoint, such as api.example.com/v1/quote.' });
    expect(words('rate_limited')).toEqual({ title: 'Too many checks', text: 'Wait a minute and try again.' });
  });

  it('words every detail the pay host gives, in one sentence, under its reason', () => {
    const details: Record<string, readonly string[]> = {
      invalid_target: ['not_a_url', 'invalid_host', 'ip_address'],
      host_not_allowed: ['blocklisted', 'own_host', 'private_address', 'opted_out'],
      unsupported_payment: ['no_challenge', 'no_option'],
      upstream_unavailable: ['dns', 'refused', 'timeout', 'unreachable', 'headers_too_large'],
    };
    const seen = new Set<string>();
    for (const [reason, list] of Object.entries(details)) {
      for (const detail of list) {
        const { title, text } = words(reason, detail);

        expect(title, detail).toBe(detail === 'invalid_host' ? 'We can\'t route to this host' : words(reason).title);
        expect(text, detail).toMatch(/^[A-Z].*\.$/);
        expect(text, detail).not.toContain('. ');
        expect(seen.has(text), `${detail} has its own text`).toBe(false);
        seen.add(text);
      }
    }
    expect(words('host_not_allowed', 'opted_out').text).toBe('This API asked not to be routed through Anyfare.');
    expect(words('invalid_target', 'invalid_host').text).toBe('This isn\'t a host we can route to.');
    expect(words('invalid_target', 'ip_address').text).toBe('Paste a link with a host name, not an IP address.');
    expect(words('host_not_allowed', 'own_host').text).toBe('This is one of Anyfare\'s own hosts.');
    expect(words('host_not_allowed', 'private_address').text).toBe('This link points to a private address.');
    expect(words('upstream_unavailable', 'dns').text).toBe('This host name doesn\'t resolve.');
    expect(words('upstream_unavailable', 'headers_too_large').text).toBe('The API answered with headers too large to read.');
    // A detail of another reason, or one it doesn't know, leaves the reason's own text
    expect(words('host_not_allowed').title).toBe('We don\'t route to this host');
    expect(words('upstream_unavailable', 'opted_out')).toEqual(words('upstream_unavailable'));
    expect(words('invalid_target', 'new_detail')).toEqual(words('invalid_target'));
  });

  it('says "We couldn\'t check this link" with the API\'s message, cut, for any other reason', () => {
    expect(words('surprise', undefined, 'It broke')).toEqual({ title: 'We couldn\'t check this link', text: 'It broke' });
    expect(words('surprise', undefined, 'x'.repeat(500)).text).toHaveLength(300);
  });

  it('gets each sample refusal from the fake as the page words it', async () => {
    const { read } = fakeReader();
    const reasons: Record<string, string> = {};
    for (const [name, host] of Object.entries(sampleCheckHosts)) {
      const state = await loadCheck(read, `${host}/v1/x`);
      reasons[name] = state.kind === 'refused' ? state.refusal.reason : state.kind;
    }

    expect(reasons).toMatchObject({
      notPayable: 'not_payable', unsupported: 'unsupported_payment', noChallenge: 'unsupported_payment', blocked: 'host_not_allowed', private: 'upstream_unavailable', own: 'host_not_allowed',
      optedOut: 'host_not_allowed', dead: 'upstream_unavailable', refused: 'upstream_unavailable', timeout: 'upstream_unavailable', unreachable: 'upstream_unavailable',
      other: 'surprise', limited: 'rate_limited', base: 'payable', near: 'payable', mpp: 'payable',
    });
    expect((await loadCheck(read, 'not a link')).kind).toBe('refused');
    const detailOf = async (link: string): Promise<string | undefined> => {
      const state = await loadCheck(read, link);

      return state.kind === 'refused' ? state.refusal.detail : undefined;
    };
    expect(await detailOf('not a link')).toBe('not_a_url');
    expect(await detailOf('localhost/v1/x')).toBe('invalid_host');
    expect(await detailOf('203.0.113.7/v1/x')).toBe('ip_address');
    expect(await detailOf('optout.example.com/v1/x')).toBe('opted_out');
    expect(await detailOf('timeout.example.com/v1/x')).toBe('timeout');
    const free = await loadCheck(read, 'free.example.com/v1/x');
    expect(free.kind === 'refused' && free.refusal.status).toBe(200);
  });
});

describe('reading the answer of the check', () => {
  it('takes a payable answer and a refusal, and nothing else', () => {
    expect(readCheckAnswer(null)).toBeUndefined();
    expect(readCheckAnswer({ payable: 'yes' })).toBeUndefined();
    expect(readCheckAnswer({ payable: true, link: 'x' })).toBeUndefined();
    expect(readCheckAnswer({ payable: true, target: 'not a url', link: 'x' })).toBeUndefined();
    expect(readCheckAnswer({ payable: false })).toBeUndefined();
    expect(readCheckAnswer({ payable: false, reason: 'not_payable', message: 'm', detail: 'd' })).toEqual({ payable: false, refusal: { reason: 'not_payable', message: 'm', detail: 'd' } });
    expect(readCheckAnswer({ payable: false, method: 'GET', reason: 'not_payable', message: 'm', detail: 'no_payment_asked', upstream: { status: 200 } })).toEqual({ payable: false, refusal: { reason: 'not_payable', message: 'm', detail: 'no_payment_asked', status: 200 } });
  });

  it('reads a payable answer with no extra fields, as the pay host answers today', () => {
    const read = readCheckAnswer({ payable: true, target: 'https://api.example.com/v1/q?a=b', link: 'https://pay.example.com/api.example.com/v1/q?a=b', price: { amount: '0.01', currency: 'USD' }, quote: { amount: '0.01', fee: '0', currency: 'USD' } });

    expect(read?.payable && read.check).toMatchObject({ host: 'api.example.com', path: '/v1/q', protocol: 'x402', asks: {}, payWith: [], upstream: { headers: [] } });
  });

  it('keeps only text and numbers, cut, so nothing from an outside host can be markup', () => {
    const read = readCheckAnswer({
      payable: true,
      target: 'https://api.example.com/v1',
      link: 'https://pay.example.com/api.example.com/v1',
      asks: { description: { html: '<b>x</b>' }, payTo: ['a'], amount: 5, scheme: 'y'.repeat(2_000) },
      upstream: { headers: { a: 'v'.repeat(20_000), b: { x: 1 }, c: 3 }, x402: { accepts: [] } },
      payWith: [null, { paidWith: 'near' }, { paidWith: 'near', amount: '0.01' }],
    });
    const result = read?.payable ? read.check : undefined;

    expect(result?.asks).toEqual({ amount: '5', scheme: 'y'.repeat(600) });
    expect(result?.upstream.headers.map(([name, value]) => [name, value.length])).toEqual([['a', 8_000], ['c', 1]]);
    expect(result?.payWith).toEqual([{ paidWith: 'near', protocol: '', asset: '', amount: '0.01', currency: 'USD' }]);
  });
});

describe('quoting for a shell', () => {
  it('leaves a safe word alone and quotes the rest', () => {
    expect(shellWord('https://pay.example.com/api.example.com/v1')).toBe('https://pay.example.com/api.example.com/v1');
    expect(shellWord('https://pay.example.com/a?b=1&c=2')).toBe('\'https://pay.example.com/a?b=1&c=2\'');
    expect(shellWord('https://x.example.com/it\'s $HOME')).toBe('\'https://x.example.com/it\'\\\'\'s $HOME\'');
  });

  it('gives the three calls of the Code tab with the pay link', () => {
    const samples = codeSamples('https://pay.example.com/api.example.com/v1');

    expect(samples.key).toBe('curl https://pay.example.com/api.example.com/v1 \\\n  -H "Authorization: Bearer $ANYFARE_PAYMENT_KEY"');
    expect(samples.byHand).toContain('curl -i https://pay.example.com/api.example.com/v1');
    expect(samples.byHand).toContain('PAYMENT-SIGNATURE');
    expect(samples.prompt).toMatch(/^Call https:\/\/pay\.example\.com\/api\.example\.com\/v1 through Anyfare\./);
  });
});

describe('the Markdown twin of the Check page', () => {
  const twin = async (link: string, extra = '') => {
    const { read, asked } = fakeReader();
    const params = parseCheckParams(new URLSearchParams(`url=${encodeURIComponent(link)}${extra}`));

    return { ...checkMarkdown(settings, await loadCheckData(read, read, params)), asked };
  };

  it('is a page with a twin, at /check.md', () => {
    expect(markdownPageFor('/check')).toBeDefined();
    expect(pageForMarkdownUrl('/check.md')).toBe('/check');
  });

  it('gives the real values for a payable link, and reads the check, the stats and the calls', async () => {
    const { status, body, asked } = await twin('api.example.com/v1/sample/quotes/latest');

    expect(status).toBe(200);
    expect(body).toMatch(/^# api\.example\.com\/v1\/sample\/quotes\/latest\n\nPayable through Anyfare\./);
    expect(body).toContain('This API asks $0.01 in USDC on Base for each call, over x402.');
    expect(body).toContain('- Our quote: $0.01, fee $0');
    expect(body).toContain('- Link: https://pay.example.com/api.example.com/v1/sample/quotes/latest');
    expect(body).toContain('- USDC on NEAR: $0.01');
    expect(body).toContain('- Paid calls: 402');
    expect(body).toContain('https://site.example.com/calls/pay_sample0000');
    expect(asked).toEqual([
      '/_/check?url=api.example.com%2Fv1%2Fsample%2Fquotes%2Flatest',
      '/v1/endpoints/stats?host=api.example.com&path=%2Fv1%2Fsample%2Fquotes%2Flatest&period=30d',
      '/v1/calls?host=api.example.com&endpoint=%2Fv1%2Fsample%2Fquotes%2Flatest&page=1&size=10',
    ]);
  });

  it('asks the pay host with the method, and says it in the twin; a GET that is not payable offers POST', async () => {
    const post = await twin('post.example.com/v1/x', '&method=POST');
    const get = await twin('post.example.com/v1/x');
    const tried = await twin('free.example.com/v1/x', '&method=POST');

    expect(post.asked[0]).toBe('/_/check?url=post.example.com%2Fv1%2Fx&method=POST');
    expect(post.body).toMatch(/^# POST post\.example\.com\/v1\/x\n\nPayable through Anyfare\. Checked with POST\./);
    expect(get.asked).toEqual(['/_/check?url=post.example.com%2Fv1%2Fx']);
    expect(get.body).toContain('Some APIs ask for payment only on POST. Ask as https://site.example.com/check.md?url=post.example.com%2Fv1%2Fx&method=POST');
    expect(tried.body).toContain('We sent POST to this link and it answered 200 without asking');
    expect(tried.body).not.toContain('Some APIs ask for payment only on POST.');
  });

  it('reads the real shapes: the method, a list of MPP challenges, and stats that can be null', () => {
    const mpp = check('search.example.com/v1/x');
    const base = check('api.example.com/v1/sample/quotes/latest');
    const unread = check('rpc05.example.org/v1/sample/quotes/latest');

    expect(mpp.method).toBe('GET');
    expect(mpp.upstream.decodedAs).toBe('mpp');
    expect(Array.isArray(mpp.upstream.decoded)).toBe(true);
    expect(base.stats).toEqual({ calls: 402, buyers: 33, volume: '4.02', successRate: 0.99, p50Ms: 340 });
    expect(unread.stats).toBeNull();
  });

  it('sends the check header with a POST check and only then, and a 400 is the generic card, not a crash', async () => {
    const post = fakeReader();
    const get = fakeReader();
    await loadCheckData(post.read, post.read, parseCheckParams({ url: 'post.example.com/v1/x', method: 'POST' }));
    await loadCheckData(get.read, get.read, parseCheckParams({ url: 'post.example.com/v1/x' }));

    expect(post.sentHeaders[0]).toEqual({ 'X-Anyfare-Check': '1' });
    expect(get.sentHeaders[0]).toBeUndefined();
    // Without the header the fake answers 400, as the pay host does
    const inner = fakeReader().read;
    const bare = ((path: string, guard?: (value: unknown) => boolean) => inner(path, guard as never)) as Reader;
    const state = await loadCheck(bare, 'post.example.com/v1/x', 'POST');
    expect(state.kind).toBe('refused');
    expect(state.kind === 'refused' && refusalWords(state.refusal)).toEqual({ title: 'We couldn\'t check this link', text: 'A POST check needs the header X-Anyfare-Check: 1' });
    expect(answer(new URL('https://fake.example.com/_/check?url=post.example.com&method=POST'), 'full', now)!.status).toBe(400);
    expect(answer(new URL('https://fake.example.com/_/check?url=post.example.com&method=POST'), 'full', now, { 'x-anyfare-check': '1' })!.status).toBe(200);
  });

  it('lists the check header in the Agent view\'s request and in the examples, for a POST check only', async () => {
    const { read } = fakeReader();
    const post = await loadCheckData(read, read, parseCheckParams({ url: 'post.example.com/v1/x', method: 'POST' }));
    const get = await loadCheckData(read, read, parseCheckParams({ url: 'post.example.com/v1/x' }));

    expect(checkRequests(settings, post)[0]!.headers).toEqual({ 'X-Anyfare-Check': '1' });
    expect(checkRequests(settings, get)[0]!.headers).toBeUndefined();
  });

  it('shows the check\'s own 30-day numbers when the API\'s read of them failed', async () => {
    const { read } = fakeReader();
    const params = parseCheckParams({ url: 'api.example.com/v1/sample/quotes/latest' });
    const data = await loadCheckData(read, read, params);
    const failed = { ...data, stats: { ok: false as const, error: { status: 503, code: 'stats_unavailable', message: 'x' } } };
    const body = checkMarkdown(settings, failed).body;

    expect(body).toContain('## Through Anyfare, 30 days');
    expect(body).toContain('- Paid calls: 402');
    expect(body).toContain('These are the numbers from the check.');
    // Without the check's numbers, the section says they are not available
    const bare = { ...failed, state: { ...data.state, check: { ...(data.state as { check: object }).check, stats: null } } } as typeof data;
    expect(checkMarkdown(settings, bare).body).toContain('Not available right now.');
  });

  it('answers a method the pay host doesn\'t know with a 400, and every payable answer names its method', () => {
    expect(answer(new URL('https://fake.example.com/_/check?url=api.example.com&method=TRACE'), 'full', now)!.status).toBe(400);
    expect((sampleCheck('api.example.com/v1/x', now, undefined, 'POST').body as { method: string }).method).toBe('POST');
    expect((sampleCheck('post.example.com/v1/x', now).body as { payable: boolean }).payable).toBe(false);
    expect((sampleCheck('post.example.com/v1/x', now, undefined, 'POST').body as { payable: boolean }).payable).toBe(true);
  });

  it('lists the check request of the Agent view with the method when it is not GET', async () => {
    const { read } = fakeReader();
    const post = await loadCheckData(read, read, parseCheckParams({ url: 'post.example.com/v1/x', method: 'POST' }));
    const get = await loadCheckData(read, read, parseCheckParams({ url: 'post.example.com/v1/x' }));

    expect(checkRequests(settings, post)[0]!.url).toBe('https://pay.example.com/_/check?url=post.example.com%2Fv1%2Fx&method=POST');
    expect(checkRequests(settings, get)[0]!.url).toBe('https://pay.example.com/_/check?url=post.example.com%2Fv1%2Fx');
  });

  it('asks for the period and the page the URL names', async () => {
    const { asked } = await twin('api.example.com/v1/sample/quotes/latest', '&period=7d&page=2');

    expect(asked).toContain('/v1/endpoints/stats?host=api.example.com&path=%2Fv1%2Fsample%2Fquotes%2Flatest&period=7d');
    expect(asked).toContain('/v1/calls?host=api.example.com&endpoint=%2Fv1%2Fsample%2Fquotes%2Flatest&page=2&size=10');
  });

  it('gives the MPP link in its own words', async () => {
    const { body } = await twin('search.example.com/v1/sample/lookup');

    expect(body).toContain('over MPP.');
    expect(body).toContain('- Protocol: MPP, method tempo, intent charge');
  });

  it('says the reason of a refusal, and reads nothing but the check', async () => {
    const { status, body, asked } = await twin('free.example.com/v1/free');

    expect(status).toBe(200);
    expect(body).toContain('# free.example.com/v1/free');
    expect(body).toContain('Not payable: Not a paid link.');
    expect(body).toContain('Reason: `not_payable`');
    expect(asked).toHaveLength(1);
    expect((await twin('limited.example.com/v1/x')).status).toBe(429);
    // A name that resolves only to private addresses is a name that doesn't resolve; a literal private IP is a private address
    expect((await twin('private.example.com/v1/x')).body).toContain('This host name doesn\'t resolve.');
    expect((await twin('10.0.0.5/v1/x')).body).toContain('This link points to a private address.');
  });

  it('asks for a link when there is none, and makes no request', async () => {
    const { read, asked } = fakeReader();
    const result = checkMarkdown(settings, await loadCheckData(read, read, parseCheckParams(new URLSearchParams(''))));

    expect(result.status).toBe(200);
    expect(result.body).toContain('Paste the link of one paid endpoint, the one that answers 402.');
    expect(asked).toEqual([]);
  });

  it('puts what the API wrote on one line, so it can not add structure', async () => {
    const hostile = check('hostile.example.com/v1/x');
    const { body } = await twin('hostile.example.com/v1/x');

    expect(hostile.asks.description).toBe('<script>alert(1)</script>');
    expect(body).toContain('Its own description: "<script>alert(1)</script>"');
    expect(body.split('\n').filter(line => line.startsWith('#'))).toEqual(['# hostile.example.com/v1/x', '## What the API asks', '## Pay it through Anyfare', '## Through Anyfare, 30 days', '## Last calls']);
  });
});

describe('the fake pay host', () => {
  it('answers each sample link, and zeros for an endpoint with no call', () => {
    const stats = (host: string, path: string) => (answer(new URL(`https://x.example.com/v1/endpoints/stats?host=${host}&path=${path}&period=30d`), 'full', now)!.body as { stats: { calls: number }; daily: unknown[]; byPaidWith: unknown[] });

    expect(stats('api.example.com', '/v1/sample/lookup').stats.calls).toBeGreaterThan(0);
    expect(stats('api.example.com', '/nowhere')).toMatchObject({ stats: { calls: 0 }, byPaidWith: [] });
    expect(stats('api.example.com', '/nowhere').daily).toHaveLength(14);
    for (const period of ['today', '7d', '30d', 'all'])
      expect(answer(new URL(`https://x.example.com/v1/endpoints/stats?host=api.example.com&path=/v1/sample/lookup&period=${period}`), 'full', now)!.status).toBe(200);
    expect(answer(new URL('https://x.example.com/v1/endpoints/stats?period=nope'), 'full', now)!.status).toBe(400);
  });
});
