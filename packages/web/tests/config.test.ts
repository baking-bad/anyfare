import { describe, expect, it } from 'vitest';

import { InvalidSettingError, readSettings } from '../src/config';

describe('runtime settings', () => {
  it('defaults to the production hosts, and the internal URLs follow the public ones', () => {
    expect(readSettings({})).toEqual({
      siteUrl: 'https://anyfare.agents.bakingbad.dev',
      consoleUrl: 'https://console.anyfare.agents.bakingbad.dev',
      apiUrl: 'https://api.anyfare.agents.bakingbad.dev',
      payUrl: 'https://pay.anyfare.agents.bakingbad.dev',
      apiInternalUrl: 'https://api.anyfare.agents.bakingbad.dev',
      payInternalUrl: 'https://pay.anyfare.agents.bakingbad.dev',
    });
  });

  it('reads every variable, without trailing slashes', () => {
    const settings = readSettings({
      SITE_URL: 'http://localhost:3000/', CONSOLE_URL: 'http://localhost:3100', API_URL: 'http://localhost:8081', PAY_URL: 'https://pay.example.com/',
      API_INTERNAL_URL: 'http://api:8081', PAY_INTERNAL_URL: 'http://proxy:8080/',
    });

    expect(settings).toEqual({
      siteUrl: 'http://localhost:3000', consoleUrl: 'http://localhost:3100', apiUrl: 'http://localhost:8081', payUrl: 'https://pay.example.com',
      apiInternalUrl: 'http://api:8081', payInternalUrl: 'http://proxy:8080',
    });
  });

  it('makes an internal URL default to its public one, as set', () => {
    const settings = readSettings({ API_URL: 'http://localhost:8081/', PAY_URL: 'https://pay.example.com', PAY_INTERNAL_URL: 'http://proxy:8080' });

    expect(settings.apiInternalUrl).toBe('http://localhost:8081');
    expect(settings.payInternalUrl).toBe('http://proxy:8080');
  });

  it('treats an empty variable as unset', () => {
    expect(readSettings({ SITE_URL: '  ', API_URL: '' }).siteUrl).toBe('https://anyfare.agents.bakingbad.dev');
  });

  it.each([
    ['a URL that isn\'t one', { API_URL: 'not a url' }, 'API_URL must be a URL'],
    ['credentials in a URL', { API_URL: 'https://user:secret@api.example.com' }, 'API_URL must be an http(s) URL without credentials'],
    ['another scheme', { SITE_URL: 'ftp://anyfare.example.com' }, 'SITE_URL must be an http(s) URL'],
    ['a query', { CONSOLE_URL: 'https://console.example.com/?a=1' }, 'CONSOLE_URL must be an http(s) URL'],
    ['a bad internal URL', { API_INTERNAL_URL: 'nope' }, 'API_INTERNAL_URL must be a URL'],
  ])('refuses %s', (_case, env, message) => {
    expect(() => readSettings(env)).toThrow(InvalidSettingError);
    expect(() => readSettings(env)).toThrow(message);
  });
});
