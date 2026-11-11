// The local tools write to a database and start apps with fakes. They are development tools: they
// refuse to run against anything that isn't this machine's, or a platform config that is production.

export class LocalOnlyError extends Error {
  constructor(message: string) {
    super(`Refusing to run: ${message}`);
    this.name = 'LocalOnlyError';
  }
}

const localHosts: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/** Throws unless the database URL names `localhost` or `127.0.0.1`. The URL itself is never echoed: it carries a password. */
export const assertLocalDatabase = (databaseUrl: string | undefined): void => {
  if (databaseUrl === undefined || databaseUrl.trim() === '')
    throw new LocalOnlyError('DATABASE_URL is not set. Copy .env.example to .env and run docker compose up -d');
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  }
  catch {
    throw new LocalOnlyError('DATABASE_URL is not a URL');
  }
  if (!localHosts.has(host))
    throw new LocalOnlyError(`DATABASE_URL names the host ${host}, and this tool writes only to localhost or 127.0.0.1`);
};

/** Throws when the platform config's environment, or NODE_ENV, is production. */
export const assertNotProduction = (config: { readonly environment: string }, env: Readonly<Record<string, string | undefined>> = process.env): void => {
  if (config.environment === 'production')
    throw new LocalOnlyError('the platform config\'s environment is production');
  if (env['NODE_ENV'] === 'production')
    throw new LocalOnlyError('NODE_ENV is production');
};

/** Both checks, for a tool that has the database URL and the platform config. */
export const assertLocalOnly = (input: {
  readonly databaseUrl: string | undefined;
  readonly config: { readonly environment: string };
  readonly env?: Readonly<Record<string, string | undefined>>;
}): void => {
  assertLocalDatabase(input.databaseUrl);
  assertNotProduction(input.config, input.env);
};
