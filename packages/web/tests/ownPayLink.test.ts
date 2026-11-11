import { describe, expect, it } from 'vitest';

import type { ApiResult, Reader } from '../src/api/reader';
import { checkAddress, ownPayInner, parseCheckParams } from '../src/check/content';
import { loadCheck, loadCheckData } from '../src/check/data';
import { readSettings } from '../src/config';
import { checkMarkdown } from '../src/markdown/check';
import { isMissing, maxRechecks, recheckDelayMs, type MissingPage } from '../src/missing/pages';

const payHost = 'pay.example.com';

const counting = (): { readonly read: Reader; readonly asked: string[] } => {
  const asked: string[] = [];
  const read = (async (path: string): Promise<ApiResult<unknown>> => {
    asked.push(path);

    return { ok: false, error: { status: 500, code: 'x', message: 'x' } };
  }) as Reader;

  return { read, asked };
};

describe('a link to the pay host itself', () => {
  it('finds the link inside it, with or without the scheme, in any case, query kept', () => {
    expect(ownPayInner('https://pay.example.com/api.example.com/v1/x', payHost)).toBe('api.example.com/v1/x');
    expect(ownPayInner('PAY.example.com./api.example.com/v1/x?a=1', payHost)).toBe('api.example.com/v1/x?a=1');
    expect(ownPayInner('pay.example.com', payHost)).toBe('');
    expect(ownPayInner('pay.example.com/', payHost)).toBe('');
    expect(ownPayInner('api.example.com/pay.example.com/x', payHost)).toBeUndefined();
    expect(ownPayInner('pay.example.com.evil.test/x', payHost)).toBeUndefined();
    expect(ownPayInner('localhost:8402/api.example.com/x', 'localhost:8402')).toBe('api.example.com/x');
  });

  it('is its own state, and sends no request', async () => {
    const { read, asked } = counting();
    const state = await loadCheck(read, 'https://pay.example.com/api.example.com/v1/x', 'POST', payHost);
    expect(state).toMatchObject({ kind: 'own', inner: 'api.example.com/v1/x' });
    expect(asked).toEqual([]);
    const data = await loadCheckData(read, read, parseCheckParams({ url: 'pay.example.com/api.example.com/v1/x' }), payHost);
    expect(data.state.kind).toBe('own');
    expect(asked).toEqual([]);
  });

  it('keeps asking for any other link', async () => {
    const { read, asked } = counting();
    await loadCheck(read, 'api.example.com/v1/x', 'GET', payHost);
    expect(asked).toHaveLength(1);
  });

  it('is told by the twin, with the address that checks the inner link and keeps the method', async () => {
    const { read } = counting();
    const settings = readSettings({ SITE_URL: 'https://site.example.com', PAY_URL: `https://${payHost}` });
    const data = await loadCheckData(read, read, parseCheckParams({ url: 'pay.example.com/api.example.com/v1/x', method: 'POST' }), payHost);
    const twin = checkMarkdown(settings, data);
    expect(twin.status).toBe(200);
    expect(twin.body).toContain('This is already an Anyfare pay link');
    expect(twin.body).toContain('Paste the API\'s own link: the part after pay.example.com/.');
    expect(twin.body).toContain(checkAddress({ url: 'api.example.com/v1/x', method: 'POST', tab: 'overview', period: '30d', page: 1 }, '/check.md'));
  });
});

describe('a service a check has just listed', () => {
  const missing = { status: 404, code: 'not_found', message: 'No' };
  const page = (answers: readonly boolean[]): { readonly page: MissingPage; readonly reads: () => number } => {
    let reads = 0;
    const exists = async (): Promise<ApiResult<unknown>> => {
      const listed = answers[Math.min(reads, answers.length - 1)]!;
      reads += 1;

      return listed ? { ok: true, value: {} } : { ok: false, error: missing };
    };

    return { page: { kind: 'service', pattern: /^$/, valid: () => true, exists, afterCheck: true, title: '', line: '', actions: () => [] }, reads: () => reads };
  };
  const read = {} as Reader;

  it('waits 1.5 seconds and reads once more, when the first read says not listed and the marker is there', async () => {
    const { page: service, reads } = page([false, true]);
    const pauses: number[] = [];
    expect(await isMissing(service, read, 'a.example.com', { afterCheck: true, pause: async ms => { pauses.push(ms); } })).toBe(false);
    expect(pauses).toEqual([recheckDelayMs]);
    expect(recheckDelayMs).toBe(1_500);
    expect(reads()).toBe(2);
  });

  it('reads at most once more: a host still not listed is missing', async () => {
    const { page: service, reads } = page([false, false, true]);
    expect(await isMissing(service, read, 'a.example.com', { afterCheck: true, pause: async () => {} })).toBe(true);
    expect(reads()).toBe(2);
  });

  it('never waits without the marker, nor for a listed host, nor for a failure that is not a 404', async () => {
    const without = page([false, true]);
    expect(await isMissing(without.page, read, 'a.example.com', { pause: async () => { throw new Error('waited'); } })).toBe(true);
    expect(without.reads()).toBe(1);
    const listed = page([true]);
    expect(await isMissing(listed.page, read, 'a.example.com', { afterCheck: true, pause: async () => { throw new Error('waited'); } })).toBe(false);
    const down = { ...page([false]).page, exists: async (): Promise<ApiResult<unknown>> => ({ ok: false, error: { status: 503, code: 'x', message: 'x' } }) };
    expect(await isMissing(down, read, 'a.example.com', { afterCheck: true, pause: async () => { throw new Error('waited'); } })).toBe(false);
  });

  it('lets only a bounded number of requests wait at once: the rest are decided at once', async () => {
    const release: (() => void)[] = [];
    const hold = (): Promise<void> => new Promise(resolve => { release.push(resolve); });
    const waiting = Array.from({ length: maxRechecks }, () => isMissing(page([false, true]).page, read, 'a.example.com', { afterCheck: true, pause: hold }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(release).toHaveLength(maxRechecks);
    const extra = page([false, true]);
    expect(await isMissing(extra.page, read, 'a.example.com', { afterCheck: true, pause: hold })).toBe(true);
    expect(extra.reads()).toBe(1);
    for (const done of release)
      done();
    expect(await Promise.all(waiting)).toEqual(Array(maxRechecks).fill(false));
  });
});
