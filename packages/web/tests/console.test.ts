import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider } from '../src/components/Settings';
import { consoleAgentPages, curlOfPage } from '../src/console/agentRequests';
import { apiPath, apiTarget, checkMasterKey, checkStoredKey, ConsoleApiError, createAccount, readAccount, readBalance, RefusedTargetError, rotateMasterKey, rotateTimeoutMs } from '../src/console/api';
import { notRotatedText, oneAtATime, rotateAndCheck, unknownText } from '../src/console/rotate';
import { ConsolePlacesProvider, problemText, waitText } from '../src/console/context';
import { moneyParts, utcDateTime } from '../src/console/format';
import { consoleMetadata, pageAtPath, pathOf } from '../src/console/pages';
import { expiredNotice, longMasked, lostNotice, maskKey, readMasterKey, refusedKey, replaceMasterKey, resetSessionForTests, sessionNow, sessionStorageName, shortMasked, signIn, signOut } from '../src/console/session';
import { SignIn, signInProblem, signUpProblem } from '../src/console/SignIn';

// The master key in the browser: where it is kept, where it is sent, and what the console's code may touch. The keys
// below are made up for these tests.

const key = 'afm_test_0123456789abcdef0123456789ab3f9a';
const otherKey = 'afm_test_fedcba9876543210fedcba987654c0de';
const apiUrl = 'https://api.example.test';
const consoleOrigin = 'https://console.example.test';

/** A Storage in memory, which can be told to refuse writes, as a browser that blocks storage does. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  refuse = false;
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(name: string): string | null {
    return this.items.get(name) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(name: string): void {
    this.items.delete(name);
  }
  setItem(name: string, value: string): void {
    if (this.refuse)
      throw new DOMException('Blocked', 'SecurityError');
    this.items.set(name, value);
  }
  entries(): [string, string][] {
    return [...this.items.entries()];
  }
}

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

let session: MemoryStorage;
let local: MemoryStorage;
let sent: Sent[];
let answer: () => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  session = new MemoryStorage();
  local = new MemoryStorage();
  sent = [];
  answer = () => json(200, {});
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('location', { origin: consoleOrigin });
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });

    return answer();
  }));
  resetSessionForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSessionForTests();
});

const headersOf = (request: Sent): Record<string, string> => Object.fromEntries(Object.entries(request.init.headers as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));

describe('the session', () => {
  it('keeps the key in sessionStorage under one name, and nowhere else', () => {
    expect(signIn(key)).toBe(true);

    expect(session.entries()).toEqual([[sessionStorageName, key]]);
    expect(local.length).toBe(0);
    expect(readMasterKey()).toBe(key);
  });

  it('holds the key\'s masked form only: its prefix and its last 4 characters', () => {
    signIn(key);
    const now = sessionNow();

    expect(now).toEqual({ status: 'signedIn', key: { prefix: 'afm_test_', end: '3f9a' } });
    expect(JSON.stringify(now)).not.toContain(key);
    expect(shortMasked(maskKey(key))).toBe('afm_test_…3f9a');
    expect(longMasked(maskKey(key))).toBe('afm_test_••••••••••••••••3f9a');
    expect(maskKey('afm_live_short')).toEqual({ prefix: 'afm_live_', end: '' });
    expect(maskKey('no-prefix-but-long-enough-1234')).toEqual({ prefix: '', end: '1234' });
  });

  it('keeps a sign-up\'s free Credits in memory for this visit only, never in storage', () => {
    signIn(key, { freeCredits: '0.1' });

    expect(sessionNow()).toMatchObject({ status: 'signedIn', freeCredits: '0.1' });
    expect(session.entries()).toEqual([[sessionStorageName, key]]);
    // A new page load reads the key back, and the banner's amount is gone
    resetSessionForTests();
    expect(sessionNow()).toEqual({ status: 'signedIn', key: { prefix: 'afm_test_', end: '3f9a' } });
  });

  it('forgets the key and every part of the session on sign-out', () => {
    signIn(key, { freeCredits: '0.1' });
    signOut();

    expect(session.length).toBe(0);
    expect(sessionNow()).toEqual({ status: 'signedOut' });
    signIn(key);
    signOut('expired');
    expect(sessionNow()).toEqual({ status: 'signedOut', notice: 'expired' });
  });

  it('stays signed out when the browser refuses to keep the key', () => {
    session.refuse = true;

    expect(signIn(key)).toBe(false);
    expect(sessionNow()).toEqual({ status: 'signedOut' });
    expect(readMasterKey()).toBeUndefined();
  });

  it('puts a rotated key in place of the old one at once', () => {
    signIn(key);

    expect(replaceMasterKey(otherKey, key)).toBe('kept');
    expect(session.entries()).toEqual([[sessionStorageName, otherKey]]);
    expect(sessionNow()).toEqual({ status: 'signedIn', key: { prefix: 'afm_test_', end: 'c0de' } });
  });

  it('ends only when the refused key is still the stored one', () => {
    signIn(otherKey);
    refusedKey(key);
    expect(sessionNow().status).toBe('signedIn');

    refusedKey(otherKey);
    expect(sessionNow()).toEqual({ status: 'signedOut', notice: 'expired' });
    expect(session.length).toBe(0);
  });

  it('reads as signed out when storage can\'t be read at all', () => {
    vi.stubGlobal('sessionStorage', undefined);

    expect(sessionNow()).toEqual({ status: 'signedOut' });
    expect(signIn(key)).toBe(false);
  });
});

describe('the requests to the API', () => {
  it('send the key only as Authorization: Bearer, to the API\'s origin, with no cookie, cache, referrer or redirect', async () => {
    signIn(key);
    answer = () => json(200, { available: '0.1', held: '0' });

    expect(await readBalance(apiUrl)).toEqual({ available: '0.1', held: '0' });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request!.url).toBe('https://api.example.test/v1/balance');
    expect(request!.url).not.toContain(key);
    expect(headersOf(request!)).toEqual({ accept: 'application/json', authorization: `Bearer ${key}` });
    expect(request!.init).toMatchObject({ method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' });
    expect(request!.init.body).toBeUndefined();
  });

  it('read the account and rotate the key on their own paths', async () => {
    signIn(key);
    answer = () => json(200, { id: 'acc_1', createdAt: '2026-11-11T09:12:00.000Z' });
    expect(await readAccount(apiUrl)).toEqual({ id: 'acc_1', createdAt: '2026-11-11T09:12:00.000Z' });
    answer = () => json(200, { masterKey: otherKey });
    expect(await rotateMasterKey(apiUrl, key)).toBe(otherKey);

    expect(sent.map(request => `${request.init.method} ${request.url}`)).toEqual([
      'GET https://api.example.test/v1/account',
      'POST https://api.example.test/v1/account/master-key/rotate',
    ]);
    expect(sent[1]!.init.body).toBeUndefined();
    expect(headersOf(sent[1]!)['content-type']).toBeUndefined();
  });

  it('make an account with no key, no body and no Content-Type', async () => {
    answer = () => json(201, { id: 'acc_1', createdAt: '2026-11-11T09:12:00.000Z', masterKey: key, freeCredits: '0.1', notice: 'Keep it' });

    expect(await createAccount(apiUrl)).toEqual({ id: 'acc_1', createdAt: '2026-11-11T09:12:00.000Z', masterKey: key, freeCredits: '0.1' });
    expect(sent[0]!.url).toBe('https://api.example.test/v1/accounts');
    expect(sent[0]!.init.method).toBe('POST');
    expect(sent[0]!.init.body).toBeUndefined();
    expect(headersOf(sent[0]!)).toEqual({ accept: 'application/json' });
    // Making the account doesn't sign in: Continue does, after the person saved the key
    expect(session.length).toBe(0);
  });

  it('check a pasted key with GET /v1/account and leave the session alone, whatever the answer', async () => {
    answer = () => json(200, { id: 'acc_1', createdAt: '2026-11-11T09:12:00.000Z' });
    await checkMasterKey(apiUrl, key);
    expect(headersOf(sent[0]!).authorization).toBe(`Bearer ${key}`);
    expect(session.length).toBe(0);

    signIn(otherKey);
    answer = () => json(401, { error: { code: 'invalid_key', message: 'This key is not valid' } });
    await expect(checkMasterKey(apiUrl, key)).rejects.toMatchObject({ status: 401, code: 'invalid_key' });
    expect(sessionNow().status).toBe('signedIn');
  });

  it.each(['invalid_key', 'unauthorized'])('end the session on 401 %s, and the sign-in view says why', async code => {
    signIn(key);
    answer = () => json(401, { error: { code, message: 'No' } });

    await expect(readBalance(apiUrl)).rejects.toBeInstanceOf(ConsoleApiError);
    expect(session.length).toBe(0);
    expect(sessionNow()).toEqual({ status: 'signedOut', notice: 'expired' });
    expect(expiredNotice).toBe('This master key no longer works. Paste the current one.');
  });

  it('keep the session for a 401 that names a key replaced since the request left', async () => {
    signIn(key);
    answer = () => {
      // The key was rotated while this request was on its way
      replaceMasterKey(otherKey, key);

      return json(401, { error: { code: 'invalid_key', message: 'No' } });
    };

    await expect(readBalance(apiUrl)).rejects.toBeInstanceOf(ConsoleApiError);
    expect(readMasterKey()).toBe(otherKey);
    expect(sessionNow().status).toBe('signedIn');
  });

  it('keep the session for any other error, and say what went wrong', async () => {
    signIn(key);
    answer = () => json(500, { error: { code: 'internal_error', message: 'Internal' } });
    const down = await readBalance(apiUrl).catch((error: unknown) => error);
    answer = () => json(429, { error: { code: 'rate_limited', message: 'Slow down' } }, { 'retry-after': '30' });
    const limited = await readBalance(apiUrl).catch((error: unknown) => error);
    answer = () => {
      throw new TypeError('Failed to fetch');
    };
    const unreachable = await readBalance(apiUrl).catch((error: unknown) => error);
    answer = () => new Response('<html>', { status: 502 });
    const odd = await readBalance(apiUrl).catch((error: unknown) => error);

    expect(down).toMatchObject({ status: 500, code: 'internal_error' });
    expect(limited).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 30 });
    expect(unreachable).toMatchObject({ status: 0, code: 'api_unavailable' });
    expect(odd).toMatchObject({ status: 502, code: 'unexpected_answer' });
    expect(sessionNow().status).toBe('signedIn');
    expect(problemText(down)).toBe('The Anyfare API didn\'t answer. Try again in a moment.');
    expect(problemText(limited)).toBe('Too many requests. Wait 30 seconds and try again.');
    expect(problemText(unreachable)).toBe('The Anyfare API didn\'t answer. Try again in a moment.');
  });

  it('send nothing when the tab has no key, and sign out', async () => {
    await expect(readBalance(apiUrl)).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(sent).toHaveLength(0);
    expect(sessionNow()).toEqual({ status: 'signedOut', notice: 'expired' });
  });

  it('refuse an answer of the wrong shape', async () => {
    signIn(key);
    answer = () => json(200, { masterKey: 'has a space' });
    await expect(rotateMasterKey(apiUrl, key)).rejects.toMatchObject({ code: 'unexpected_answer' });
    answer = () => json(200, { available: 1 });
    await expect(readBalance(apiUrl)).rejects.toMatchObject({ code: 'unexpected_answer' });
    answer = () => json(201, { id: 'acc_1', createdAt: 'x' });
    await expect(createAccount(apiUrl)).rejects.toMatchObject({ code: 'unexpected_answer' });
  });
});

describe('the rotation of the master key', () => {
  const rotatePath = 'https://api.example.test/v1/account/master-key/rotate';
  const checkPath = 'https://api.example.test/v1/account';
  // The rotation's answer first, then the check's
  const answers = (rotation: () => Response, check?: () => Response) => () => {
    const last = sent.at(-1)!;

    return last.url === rotatePath ? rotation() : check!();
  };
  const timedOut = (): Response => {
    throw new DOMException('The operation timed out', 'TimeoutError');
  };
  const account = (): Response => json(200, { id: 'acc_1', createdAt: '2026-11-11T09:12:00.000Z' });
  const refused = (): Response => json(401, { error: { code: 'invalid_key', message: 'This key is not valid' } });

  beforeEach(() => {
    signIn(key);
  });

  it('waits 60 seconds for the rotation, and 10 for every other request', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    answer = () => json(200, { masterKey: otherKey });
    await rotateAndCheck(apiUrl);
    answer = () => json(200, { available: '0', held: '0' });
    await readBalance(apiUrl);

    expect(timeout.mock.calls.map(call => call[0])).toEqual([60_000, 10_000]);
    expect(rotateTimeoutMs).toBe(60_000);
    timeout.mockRestore();
  });

  it('stores the new key before anything shows it', async () => {
    answer = () => json(200, { masterKey: otherKey });

    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'rotated', masterKey: otherKey, kept: true });
    expect(session.entries()).toEqual([[sessionStorageName, otherKey]]);
  });

  it('says the key was not rotated when the answer came late and the old key still works', async () => {
    answer = answers(timedOut, account);
    const outcome = await rotateAndCheck(apiUrl);

    expect(outcome).toEqual({ kind: 'notRotated', problem: `The Anyfare API didn't rotate it. ${notRotatedText}` });
    expect(sent.map(request => `${request.init.method} ${request.url}`)).toEqual([`POST ${rotatePath}`, `GET ${checkPath}`]);
    expect(headersOf(sent[1]!).authorization).toBe(`Bearer ${key}`);
    expect(readMasterKey()).toBe(key);
  });

  it('ends the session, and says why, when the answer came late and the old key is refused', async () => {
    answer = answers(timedOut, refused);

    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'lost' });
    expect(session.length).toBe(0);
    expect(sessionNow()).toEqual({ status: 'signedOut', notice: 'lost' });
    expect(lostNotice.text).toContain('the Credits stay on the account');
  });

  it('checks the same way after a 200 no one can read, and after a 5xx', async () => {
    answer = answers(() => new Response('<html>Bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }), refused);
    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'lost' });

    signIn(key);
    sent = [];
    answer = answers(() => json(503, { error: { code: 'unavailable', message: 'Down' } }), account);
    expect(await rotateAndCheck(apiUrl)).toMatchObject({ kind: 'notRotated' });
    expect(sent).toHaveLength(2);
    expect(sessionNow().status).toBe('signedIn');
  });

  it('says it can\'t tell, and keeps the session, when the check fails too', async () => {
    answer = answers(timedOut, timedOut);

    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'unknown' });
    expect(readMasterKey()).toBe(key);
    expect(sessionNow().status).toBe('signedIn');
    expect(unknownText).toContain('can\'t tell whether the master key was rotated');
  });

  it('checks the key first for a readable 4xx too, then keeps it with the API\'s reason', async () => {
    const limited = (): Response => json(429, { error: { code: 'rate_limited', message: 'Slow down' } }, { 'retry-after': '30' });
    answer = answers(limited, account);

    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'notRotated', problem: `Too many requests. Wait 30 seconds and try again. ${notRotatedText}` });
    expect(sent.map(request => `${request.init.method} ${request.url}`)).toEqual([`POST ${rotatePath}`, `GET ${checkPath}`]);
    expect(readMasterKey()).toBe(key);
    // And can't tell when the check is limited too
    sent = [];
    answer = answers(limited, limited);
    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'unknown' });
  });

  it('counts a refused rotation as lost once the check refuses the key too: the browser may have sent it again after its first answer dropped', async () => {
    answer = answers(refused, refused);

    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'lost' });
    expect(sessionNow()).toEqual({ status: 'signedOut', notice: 'lost' });
    expect(session.length).toBe(0);
    expect(sent).toHaveLength(2);
    expect(lostNotice.text).toMatch(/If another tab of this browser rotated it, the new key is there\.$/);
  });

  it('sends nothing to a target that is not the API, and checks nothing', async () => {
    const outcome = await rotateAndCheck(consoleOrigin);

    expect(outcome).toMatchObject({ kind: 'notRotated' });
    expect(sent).toHaveLength(0);
    expect(readMasterKey()).toBe(key);
  });

  it('shows the new key but stores nothing when the person signed out while the request ran', async () => {
    answer = () => {
      signOut();

      return json(200, { masterKey: otherKey });
    };

    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'rotatedElsewhere', masterKey: otherKey });
    expect(session.length).toBe(0);
    expect(sessionNow()).toEqual({ status: 'signedOut' });
  });

  it('leaves another account\'s session alone when the answer comes after it signed in', async () => {
    const third = 'afm_test_99999999999999999999999999999999';
    answer = () => {
      signOut();
      signIn(third);

      return json(200, { masterKey: otherKey });
    };

    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'rotatedElsewhere', masterKey: otherKey });
    expect(session.entries()).toEqual([[sessionStorageName, third]]);
    expect(sessionNow()).toMatchObject({ status: 'signedIn', key: { end: '9999' } });
  });

  it('checks the key that sent the rotation, and ends no other session, when the answer was lost after a sign-in as another account', async () => {
    const third = 'afm_test_99999999999999999999999999999999';
    answer = answers(() => {
      signOut();
      signIn(third);

      return timedOut();
    }, refused);

    expect(await rotateAndCheck(apiUrl)).toEqual({ kind: 'changed' });
    expect(headersOf(sent[1]!).authorization).toBe(`Bearer ${key}`);
    expect(session.entries()).toEqual([[sessionStorageName, third]]);
    expect(sessionNow().status).toBe('signedIn');
  });

  it('runs one rotation at a time: a second call gets the first one\'s answer, and sends no second request', async () => {
    let release: () => void = () => undefined;
    answer = () => new Promise<Response>(resolve => {
      release = () => resolve(json(200, { masterKey: otherKey }));
    });
    const rotate = oneAtATime(() => rotateAndCheck(apiUrl));
    const first = rotate();
    const second = rotate();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    release();

    expect(second).toBe(first);
    expect(await second).toEqual({ kind: 'rotated', masterKey: otherKey, kept: true });
    expect(sent).toHaveLength(1);
    // Once it is done, a new call starts a new one
    answer = () => json(200, { masterKey: key });
    await rotate();
    expect(sent).toHaveLength(2);
  });

  it('checks a key without ending the session, and counts only a readable refusal as refused', async () => {
    answer = refused;
    expect(await checkStoredKey(apiUrl, key)).toBe('refused');
    expect(readMasterKey()).toBe(key);
    answer = account;
    expect(await checkStoredKey(apiUrl, key)).toBe('works');
    answer = timedOut;
    await expect(checkStoredKey(apiUrl, key)).rejects.toMatchObject({ code: 'api_unavailable' });
    answer = () => new Response('<html>Unauthorized</html>', { status: 401, headers: { 'content-type': 'text/html' } });
    await expect(checkStoredKey(apiUrl, key)).rejects.toMatchObject({ status: 401, code: 'unexpected_answer' });
    expect(sessionNow().status).toBe('signedIn');
    // The key it is given, not the stored one
    answer = account;
    await checkStoredKey(apiUrl, otherKey);
    expect(headersOf(sent.at(-1)!).authorization).toBe(`Bearer ${otherKey}`);
  });
});

describe('the address of a request', () => {
  it('is the API\'s origin and path, then a path of fixed text and encoded ids', () => {
    expect(apiTarget(apiUrl, '/v1/balance')?.href).toBe('https://api.example.test/v1/balance');
    expect(apiTarget('https://example.test/api/', '/v1/balance')?.href).toBe('https://example.test/api/v1/balance');
    expect(apiTarget(apiUrl, apiPath`/v1/keys/${'key_1'}`)?.href).toBe('https://api.example.test/v1/keys/key_1');
    expect(apiPath`/v1/keys/${'a/../b'}`).toBe('/v1/keys/a%2F..%2Fb');
    expect(apiTarget(apiUrl, apiPath`/v1/keys/${'a/../b'}`)?.href).toBe('https://api.example.test/v1/keys/a%2F..%2Fb');
    expect(apiTarget(apiUrl, '/v1/payments', { limit: '5', cursor: 'a&b=c' })?.href).toBe('https://api.example.test/v1/payments?limit=5&cursor=a%26b%3Dc');
  });

  it.each([
    '//evil.test/v1/balance', 'https://evil.test/v1/balance', '/v1/../x', '/v1/./x', '/v1/%2e%2e/x', '/v1/%2E./x', '/v1//x', '/v1/x?key=1', '/v1/x#y',
    '/v1/@evil.test', '/v1/x y', 'v1/balance', '', '/', '/v1/\\evil.test', `/v1/${apiPath`${'..'}`}`,
  ])('refuses the path %j', path => {
    expect(apiTarget(apiUrl, path)).toBeUndefined();
  });

  it.each(['ftp://api.example.test', 'https://user:pass@api.example.test', 'https://api.example.test?x=1', 'not a url', 'javascript:alert(1)', consoleOrigin])('refuses the API setting %j', setting => {
    expect(apiTarget(setting, '/v1/balance')).toBeUndefined();
  });

  it('sends nothing to a target that is not the API, and says so', async () => {
    signIn(key);

    await expect(readBalance(consoleOrigin)).rejects.toBeInstanceOf(RefusedTargetError);
    await expect(readBalance('https://user:pass@api.example.test')).rejects.toBeInstanceOf(RefusedTargetError);
    expect(sent).toHaveLength(0);
    expect(problemText(new RefusedTargetError())).toContain('no valid address');
  });
});

describe('what the sign-in view says', () => {
  const error = (status: number, code: string, retryAfter?: number): ConsoleApiError => new ConsoleApiError(status, code, 'from the API', retryAfter);

  it('names a payment key, a key that doesn\'t work, too many tries, and the API being down', () => {
    expect(signInProblem(error(401, 'wrong_key_type'))).toBe('This is a payment key. Paste the master key: it starts with afm_live_.');
    expect(signInProblem(error(401, 'invalid_key'))).toBe('This master key doesn\'t work. Check that you pasted all of it.');
    expect(signInProblem(error(401, 'unauthorized'))).toBe('This master key doesn\'t work. Check that you pasted all of it.');
    expect(signInProblem(error(429, 'rate_limited', 30))).toBe('Too many tries. Wait 30 seconds and try again.');
    expect(signInProblem(error(429, 'rate_limited'))).toBe('Too many tries. Wait a minute and try again.');
    expect(signInProblem(error(0, 'api_unavailable'))).toBe('The Anyfare API didn\'t answer. Try again in a moment.');
    expect(signUpProblem(error(429, 'rate_limited', 600))).toBe('Too many accounts were made just now. Try again in 10 minutes.');
    expect(signUpProblem(error(503, 'internal_error'))).toBe('The Anyfare API didn\'t answer. Try again in a moment.');
    expect(waitText(1)).toBe('1 second');
    expect(waitText(61)).toBe('2 minutes');
  });

  const render = (props: Parameters<typeof SignIn>[0]): string => renderToStaticMarkup(createElement(SettingsProvider, {
    value: { apiUrl, payUrl: 'https://pay.example.test', consoleUrl: consoleOrigin },
    children: createElement(ConsolePlacesProvider, { value: { siteUrl: 'https://anyfare.example.test', overviewPath: '/' }, children: createElement(SignIn, props) }),
  }));

  it('has a password field that no browser fills, checks or keeps, and no form that could post the key to the site', () => {
    const html = render({});
    // HTML attribute names are read in any case
    const field = (/<input[^>]*aria-label="Master key"[^>]*>/.exec(html)?.[0] ?? '').toLowerCase();

    expect(field).toContain('type="password"');
    expect(field).toContain('autocomplete="off"');
    expect(field).toContain('spellcheck="false"');
    expect(field).toContain('autocapitalize="off"');
    expect(field).not.toContain('value=');
    expect(field).not.toContain('name=');
    expect(html).not.toContain('<form');
    expect(html).toContain('Sign in or create an account');
    expect(html).toContain('No email. No password. One master key.');
    expect(html).toContain('One click. You get a master key and $0.10 of free Credits to try.');
    expect(html).not.toContain('After you sign in');
  });

  it('says a top-up link\'s amount from the number, and why the stored key was dropped', () => {
    expect(render({ amount: 5 })).toContain('After you sign in, Top up opens with <b>$5.00</b> from the link.');
    expect(render({ amount: 1000 })).toContain('<b>$1,000.00</b>');
    // A link whose amount was not used says so before sign-in too; no amount says nothing
    expect(render({ amountUnused: true })).toContain('The amount in the link was not used');
    expect(render({})).not.toMatch(/was not used|from the link/);
    expect(render({ notice: 'expired' })).toContain(expiredNotice);
    const lost = render({ notice: 'lost' });
    expect(lost).toContain('The master key was changed, but the new one didn&#x27;t reach this browser');
    expect(lost).toContain('the Credits stay on the account and its payment keys keep working, but without the master key no one can manage it.');
  });

  it('leads its logo to the public site with a plain link', () => {
    expect(render({})).toMatch(/<a class="logo" href="https:\/\/anyfare\.example\.test\/">/);
  });
});

describe('the Agent view of the console', () => {
  it('lists the requests behind sign-in, the Overview and Settings, with the key named, never held', () => {
    expect(consoleAgentPages.signin.requests.map(request => `${request.method} ${request.path}`)).toEqual(['POST /v1/accounts', 'GET /v1/account']);
    expect(consoleAgentPages.overview.requests.map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/balance', 'GET /v1/keys', 'GET /v1/payments?limit=5', 'GET /v1/topups?limit=5']);
    expect(consoleAgentPages.keys.requests.map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/keys', 'POST /v1/keys', 'PATCH /v1/keys/<key id>', 'DELETE /v1/keys/<key id>']);
    expect(consoleAgentPages.payments.requests.map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/payments?limit=20', 'GET /v1/keys']);
    expect(consoleAgentPages.settings.requests.map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account', 'POST /v1/account/master-key/rotate']);
    for (const page of ['signin', 'overview', 'keys', 'payments', 'settings'] as const) {
      const curl = curlOfPage(apiUrl, page);
      expect(curl, page).not.toMatch(/afm_(live|test)_[A-Za-z0-9]/);
      expect(curl, page).toContain(`${apiUrl}/v1/`);
    }
    expect(curlOfPage(apiUrl, 'signin')).toBe(`curl -X POST ${apiUrl}/v1/accounts\n\ncurl ${apiUrl}/v1/account \\\n  -H "Authorization: Bearer $ANYFARE_MASTER_KEY"`);
    // A path with a placeholder or a query is quoted, and a body goes with its Content-Type
    expect(curlOfPage(apiUrl, 'keys')).toContain(`curl -X PATCH "${apiUrl}/v1/keys/<key id>" \\\n  -H "Authorization: Bearer $ANYFARE_MASTER_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"dailyBudget":"10.00","maxPrice":null}'`);
    expect(curlOfPage(apiUrl, 'payments')).toContain(`curl "${apiUrl}/v1/payments?limit=20" \\\n`);
    expect(curlOfPage(apiUrl, 'settings')).toContain(`curl -X POST ${apiUrl}/v1/account/master-key/rotate \\\n  -H "Authorization: Bearer $ANYFARE_MASTER_KEY"`);
  });
});

describe('the console\'s pages', () => {
  it('have their own titles, and no search engine keeps them', () => {
    expect(consoleMetadata('keys')).toMatchObject({ title: { absolute: 'Keys | Anyfare console' }, robots: { index: false, follow: false } });
    expect(consoleMetadata('overview').title).toEqual({ absolute: 'Overview | Anyfare console' });
    expect(consoleMetadata('signin').title).toEqual({ absolute: 'Sign in | Anyfare console' });
  });

  it('know each path, and the Overview\'s on one host', () => {
    expect(pageAtPath('/settings').name).toBe('settings');
    expect(pageAtPath('/').name).toBe('overview');
    expect(pathOf('overview', '/console')).toBe('/console');
    expect(pathOf('keys', '/console')).toBe('/keys');
  });

  it('print money and times as the site does, in UTC', () => {
    expect(moneyParts('19.43')).toEqual({ whole: '$19', cents: '.43' });
    expect(moneyParts('0')).toEqual({ whole: '$0', cents: '' });
    expect(moneyParts('0.1')).toEqual({ whole: '$0', cents: '.10' });
    expect(utcDateTime('2026-11-11T09:12:45.000Z')).toBe('11 Nov 2026, 09:12 UTC');
    expect(utcDateTime('not a time')).toBe('-');
  });
});

// The console's code, read as text: what it may touch, and where
const consoleRoot = fileURLToPath(new URL('../src/console', import.meta.url));
// The folder's name is `%5F` itself, which a file URL would read as `_`
const appConsoleRoot = join(fileURLToPath(new URL('../app', import.meta.url)), '%5F', 'console');
const sources = (directory: string, root = directory): { readonly file: string; readonly text: string }[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);

  return statSync(path).isDirectory() ? sources(path, root) : /\.tsx?$/.test(name) ? [{ file: relative(root, path), text: readFileSync(path, 'utf8') }] : [];
});

describe('the console\'s code', () => {
  const all = [...sources(consoleRoot), ...sources(appConsoleRoot).map(source => ({ ...source, file: `app/${source.file}` }))];

  it('touches storage in one module, under one name, and never localStorage, a cookie, IndexedDB or the history', () => {
    expect(all.length).toBeGreaterThan(10);
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(/localStorage|document\.cookie|indexedDB|history\.pushState|history\.state/);
      // The Payments page puts its checked filters in the address, and no other page touches the history
      if (file !== 'PaymentsPage.tsx')
        expect(text, file).not.toMatch(/history\.replaceState/);
      if (file !== 'session.ts')
        expect(text, file).not.toMatch(/sessionStorage/);
    }
    expect(readFileSync(join(consoleRoot, 'session.ts'), 'utf8').match(/sessionStorageName\b/g)!.length).toBeGreaterThan(2);
  });

  it('sends requests and the Authorization header from one module, and never logs', () => {
    for (const { file, text } of all) {
      if (file !== 'api.ts') {
        expect(text, file).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|EventSource|WebSocket/);
        // A header built from a value: the Agent view's commands name `$ANYFARE_MASTER_KEY` as text, which is no value
        expect(text, file).not.toMatch(/\['authorization'\]|Bearer \$\{/i);
      }
      expect(text, file).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });

  it('renders no markup from a string, no inline style, no form and no server action', () => {
    for (const { file, text } of all) {
      expect(text, file).not.toContain('dangerouslySetInnerHTML');
      expect(text, file).not.toMatch(/\bstyle=\{|\.style\.|setAttribute\('style'/);
      expect(text, file).not.toMatch(/<form\b/);
      expect(text, file).not.toMatch(/['"]use server['"]/);
    }
  });

  it('leaves the console for the public site with plain links only, never the router\'s', () => {
    for (const { file, text } of all) {
      // The router's Link and the shared Logo (a router Link) never lead to the site
      expect(text, file).not.toMatch(/<(Link|Button)\b[^>]*siteUrl/);
      expect(text, file).not.toMatch(/<Logo\b/);
      // Every element whose address is built from the site's origin is an <a>
      for (const element of text.matchAll(/<(\w+)\b[^>]*href=\{`\$\{siteUrl\}/g))
        expect(element[1], file).toBe('a');
    }
    const siteLinks = all.flatMap(({ text }) => [...text.matchAll(/<a\b[^>]*href=\{`\$\{siteUrl\}/g)]);
    expect(siteLinks.length).toBeGreaterThanOrEqual(2);
  });

  it('reads the query only for the top-up link\'s amount (through amount.ts) and for the Payments filters (through payments.ts)', () => {
    const readers = all.filter(({ text }) => /searchParams|useSearchParams|location\.search|URLSearchParams/.test(text)).map(({ file }) => file).sort();

    // The API client builds a query for the requests; the Top up route reads the proxy's number and flag; Payments reads its own three filters
    expect(readers).toEqual(['PaymentsPage.tsx', 'api.ts', 'app/topup/page.tsx', 'payments.ts']);
    expect(readFileSync(join(consoleRoot, 'PaymentsPage.tsx'), 'utf8')).toMatch(/filtersOfQuery\(initialSearch/);
    expect(readFileSync(join(appConsoleRoot, 'topup/page.tsx'), 'utf8')).toMatch(/topupAmount\(params\[amountParam\]\)/);
  });
});
