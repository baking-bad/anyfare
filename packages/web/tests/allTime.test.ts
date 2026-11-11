import { describe, expect, it } from 'vitest';

import type { Stats } from '../src/api/types';
import { withAllTimeAtLeast30Days } from '../src/home/allTime';
import { homeMarkdown } from '../src/markdown/home';
import { readSettings } from '../src/config';
import { answer } from './support/fakeApi';

const stats = (all: { calls: number; buyers: number; services: number; volume: string }): Stats => ({
  updatedAt: '2026-11-11T12:00:00.000Z',
  allUpdatedAt: '2026-11-11T11:55:00.000Z',
  calls: { today: 1, '7d': 5, '30d': 40, all: all.calls },
  volume: { today: '0.1', '7d': '1.5', '30d': '10.25', all: all.volume, currency: 'USD' },
  buyers: { today: 1, '7d': 2, '30d': 9, all: all.buyers },
  services: { today: 1, '7d': 2, '30d': 4, all: all.services },
  byPaidWith: { today: [], '7d': [], '30d': [], all: [] },
  topups: { '30d': { count: 0, usd: '0' }, all: { count: 0, usd: '0' } },
  daily: [],
});

describe('all time is never less than 30 days', () => {
  it('shows the 30 days\' number for "all" where all is lower, for every stat', () => {
    const shown = withAllTimeAtLeast30Days(stats({ calls: 38, buyers: 8, services: 3, volume: '9.99' }));
    expect(shown.calls.all).toBe(40);
    expect(shown.buyers.all).toBe(9);
    expect(shown.services.all).toBe(4);
    expect(shown.volume.all).toBe('10.25');
  });

  it('leaves an all-time number that is not lower as it is', () => {
    const same = stats({ calls: 40, buyers: 12, services: 4, volume: '10.25' });
    expect(withAllTimeAtLeast30Days(same)).toEqual(same);
    expect(withAllTimeAtLeast30Days(stats({ calls: 90, buyers: 20, services: 6, volume: '80' })).calls.all).toBe(90);
  });

  it('applies to the Markdown twin too', () => {
    const settings = readSettings({});
    const read = (path: string) => ({ ok: true as const, value: answer(new URL(path, 'http://fake.example.com'), 'full', Date.parse('2026-11-11T12:00:00.000Z'))!.body });
    const full = read('/v1/stats').value as Stats;
    const low = { ...full, calls: { ...full.calls, all: 1, '30d': 77 } };
    const markdown = homeMarkdown(settings, {
      stats: { ok: true, value: low },
      live: read('/v1/stats/live') as never,
      calls: read('/v1/calls?size=6') as never,
      services: read('/v1/services?sort=calls&size=5') as never,
    });
    expect(markdown).toMatch(/\| All \| 77 \|/);
  });
});
