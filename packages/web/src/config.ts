// The website's settings, read from the environment at runtime, so one image serves every deployment.
// The website reads only the public Platform API: no database, no platform config, no secrets.

export interface SiteSettings {
  // The canonical website origin
  readonly siteUrl: string;
  // The console's origin: the header's Console button links here
  readonly consoleUrl: string;
  // The public Platform API, as the browser reaches it
  readonly apiUrl: string;
  // The pay host, as the browser reaches it
  readonly payUrl: string;
  // How the web server reaches the Platform API
  readonly apiInternalUrl: string;
  // How the web server reaches the pay host
  readonly payInternalUrl: string;
}

export const defaultSettings = {
  siteUrl: 'https://anyfare.agents.bakingbad.dev',
  consoleUrl: 'https://console.anyfare.agents.bakingbad.dev',
  apiUrl: 'https://api.anyfare.agents.bakingbad.dev',
  payUrl: 'https://pay.anyfare.agents.bakingbad.dev',
} as const;

export class InvalidSettingError extends Error {
  constructor(readonly variable: string, message: string) {
    super(`${variable} ${message}`);
  }
}

// An HTTP(S) URL without credentials, a query or a fragment, and never a trailing slash
const readUrl = (env: Readonly<Record<string, string | undefined>>, variable: string, fallback: string): string => {
  const value = env[variable]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(value);
  }
  catch {
    throw new InvalidSettingError(variable, `must be a URL, such as ${fallback}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash)
    throw new InvalidSettingError(variable, 'must be an http(s) URL without credentials, a query, or a fragment');

  return value.replace(/\/+$/, '');
};

/** The settings from `SITE_URL`, `CONSOLE_URL`, `API_URL`, `PAY_URL`, `API_INTERNAL_URL` and `PAY_INTERNAL_URL`, with the production defaults. */
export const readSettings = (env: Readonly<Record<string, string | undefined>> = process.env): SiteSettings => {
  const apiUrl = readUrl(env, 'API_URL', defaultSettings.apiUrl);
  const payUrl = readUrl(env, 'PAY_URL', defaultSettings.payUrl);

  return {
    siteUrl: readUrl(env, 'SITE_URL', defaultSettings.siteUrl),
    consoleUrl: readUrl(env, 'CONSOLE_URL', defaultSettings.consoleUrl),
    apiUrl,
    payUrl,
    apiInternalUrl: readUrl(env, 'API_INTERNAL_URL', apiUrl),
    payInternalUrl: readUrl(env, 'PAY_INTERNAL_URL', payUrl),
  };
};
