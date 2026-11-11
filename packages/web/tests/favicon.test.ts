import { describe, expect, it } from 'vitest';

import config from '../next.config';
import { verdictFor } from '../src/hosts';

describe('/favicon.ico', () => {
  it('redirects to the site\'s icon', async () => {
    expect(await config.redirects?.()).toContainEqual({ source: '/favicon.ico', destination: '/icon', permanent: false });
  });

  it.each(['site', 'console', 'shared'] as const)('is let through on the %s host', surface => {
    expect(verdictFor(surface, '/favicon.ico')).toBe('public');
    expect(verdictFor(surface, '/icon')).toBe('public');
  });
});
