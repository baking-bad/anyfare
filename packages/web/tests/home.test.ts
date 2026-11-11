import { describe, expect, it } from 'vitest';

import { readSettings } from '../src/config';
import { homeJson, homeRequests, type HomeData } from '../src/home/data';
import { homeMarkdown } from '../src/markdown/home';
import { answer } from './support/fakeApi';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const settings = readSettings({ SITE_URL: 'https://site.example.com', API_URL: 'https://api.example.com', PAY_URL: 'https://pay.example.com', CONSOLE_URL: 'https://console.example.com' });

const dataFrom = (mode: 'full' | 'empty'): HomeData => {
  const read = (path: string) => ({ ok: true as const, value: answer(new URL(path, 'http://fake.example.com'), mode, now)!.body });

  return {
    stats: read('/v1/stats') as HomeData['stats'],
    live: read('/v1/stats/live') as HomeData['live'],
    calls: read('/v1/calls?size=6') as HomeData['calls'],
    services: read('/v1/services?sort=calls&size=5') as HomeData['services'],
  };
};

const failed = { ok: false as const, error: { status: 503, code: 'api_unavailable', message: 'The Platform API didn\'t answer.' } };

describe('the home page as Markdown', () => {
  const markdown = homeMarkdown(settings, dataFrom('full'));

  it('says what the page says: the line, the live numbers, the last calls, the stats and the top services', () => {
    expect(markdown).toMatch(/^# Anyfare: pay any paid API from the chain you are on\n/);
    expect(markdown).toContain('- Paid through Anyfare in the last 24 hours: $18.42 (+12.4% against the 24 hours before)');
    expect(markdown).toContain('- Paid calls today: 213');
    expect(markdown).toContain('| 2026-11-11T11:59:57.000Z | api.example.com | /v1/sample/quotes/latest | USDC on NEAR | USDC on Base | $0.001 | 120 ms |');
    expect(markdown).toContain('| 30 days | 1,530 | $16.37 | 126 | 5 |');
    expect(markdown).toContain('- USDC on NEAR: 300 calls');
    expect(markdown).toContain('| [api.example.com](https://site.example.com/services/api.example.com) | 4 | $0.001 | 612 | 41 | $6.06 |');
    expect(markdown).toContain('`GET https://pay.example.com/_/check?url=<link>`');
    expect(markdown).toContain('Read https://site.example.com/llms.txt and follow it.');
    expect(markdown).toContain('**Do I need a subscription?**\nNo.');
  });

  it('holds no undefined, NaN or null', () => {
    expect(markdown).not.toMatch(/undefined|NaN|null/);
  });

  it('shows zeros and empty lists for an empty database', () => {
    const empty = homeMarkdown(settings, dataFrom('empty'));

    expect(empty).toContain('- Paid through Anyfare in the last 24 hours: $0\n');
    expect(empty).toContain('- Paid calls today: 0');
    expect(empty).toContain('No calls yet.');
    expect(empty).toContain('No paid services yet.');
    expect(empty).toContain('| 30 days | 0 | $0 | 0 | 0 |');
    expect(empty).not.toMatch(/undefined|NaN|null/);
  });

  it('says a section is not available when its read failed, and keeps the others', () => {
    const partial = homeMarkdown(settings, { ...dataFrom('full'), stats: failed, calls: failed });

    expect(partial).toContain('Not available right now.');
    expect(partial).toContain('| [api.example.com]');
    expect(partial).toContain('- Paid calls today: 213');
  });
});

describe('the home page\'s Agent view data', () => {
  it('lists the requests behind the page with their full addresses', () => {
    const requests = homeRequests(settings);

    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      'GET https://api.example.com/v1/stats',
      'GET https://api.example.com/v1/stats/live',
      'GET https://api.example.com/v1/calls?size=6',
      'SSE https://api.example.com/v1/calls/stream',
      'GET https://api.example.com/v1/services?sort=calls&size=5',
      'GET https://pay.example.com/_/check?url=<link>',
    ]);
  });

  it('holds the API\'s answers, and the error of a read that failed', () => {
    const json = homeJson({ ...dataFrom('full'), live: failed });

    expect(json['stats']).toMatchObject({ calls: { today: 212 } });
    expect(json['statsLive']).toEqual({ error: { code: 'api_unavailable', message: 'The Platform API didn\'t answer.' } });
  });
});
