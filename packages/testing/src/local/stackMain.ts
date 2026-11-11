// `npm run stack:local`: a development tool. No app starts it.
import { createLogger, type Logger } from '@anyfare/common';

import { LocalOnlyError } from './guard.js';
import { startLocalStack, StackPrerequisiteError, type LocalStack } from './stack.js';

const stackUsage = 'Usage: npm run stack:local [-- --scratch]\n'
  + '  --scratch  runs on a new empty database next to the local one, so every page starts at zero, and drops it when the stack stops\n'
  + 'Needs Postgres and Redis from docker-compose.yml, and DATABASE_URL and REDIS_URL in .env. LOG_LEVEL sets the apps\' log level (default: warn).';

const json = (field: string): string => `node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).${field}'`;

/** The text printed once the stack is up: its ports, and the commands that try it by hand. */
export const describeStack = (stack: LocalStack): string => {
  const { api, pay, website, paidApi } = stack.urls;
  const check = (path: string): string => `curl -s '${pay}/_/check?url=${paidApi}${path}'`;

  return [
    '',
    'The local stack is running. Press Ctrl-C to stop it.',
    '',
    'Apps',
    `  Platform API   ${api}   (internal listener on port ${stack.ports.internalApi}, metrics on ${stack.ports.apiMetrics})`,
    `  Proxy          ${pay}   (the pay host, metrics on ${stack.ports.proxyMetrics})`,
    `  Signer         http://127.0.0.1:${stack.ports.signer}   (metrics on ${stack.ports.signerMetrics})`,
    `  Workers        http://127.0.0.1:${stack.ports.workers}   (health and metrics)`,
    `  Website        ${website}   (not started here: the commands to start it are below)`,
    '',
    'Fakes',
    `  Paid API       ${paidApi}   (self-signed certificate; the proxy trusts it)`,
    ...stack.paidApiEndpoints.map(endpoint => `    ${endpoint.path.padEnd(11)}${endpoint.what}`),
    `  Facilitator    ${stack.urls.facilitator}   (x402 on Base, Solana and NEAR)`,
    `  1Click         ${stack.urls.oneClick}`,
    `  NEAR node      ${stack.urls.nearRpc}`,
    `  Tempo node     ${stack.urls.tempoRpc}`,
    ...stack.scratchDatabase === undefined ? [] : [
      '',
      `Database       ${stack.scratchDatabase}   (a new empty one: the local database is not used, and this one is dropped when the stack stops)`,
    ],
    '',
    'Start the website against this stack, from the repository root, in another shell:',
    '',
    `  export SITE_URL=${website} CONSOLE_URL=http://localhost:${stack.ports.website + 1} API_URL=${api} PAY_URL=${pay}`,
    '  npm run build -w @anyfare/web',
    '  npm run start -w @anyfare/web',
    '',
    'Try it, in one shell:',
    '',
    '  # 1. An account, with free Credits: its master key',
    `  MASTER=$(curl -s -X POST ${api}/v1/accounts | ${json('masterKey')})`,
    '  # 2. A payment key',
    `  KEY=$(curl -s -X POST ${api}/v1/keys -H "Authorization: Bearer $MASTER" | ${json('key')})`,
    '  # 3. Is the fake paid API payable, and at what price',
    `  ${check('/base')}`,
    '  # 4. A paid call, then the call in the public list',
    `  curl -i ${pay}/${stack.paidApiHost}/base -H "Authorization: Bearer $KEY"`,
    `  curl -s '${api}/v1/calls?size=1'`,
    '  # 5. Refusals, each with its reason: no payment asked, a payment we do not make, a dead port, a private address',
    `  ${check('/free')}`,
    `  ${check('/unpayable')}`,
    `  curl -s '${pay}/_/check?url=https://${stack.paidApiHost.split(':')[0]}:1/base'`,
    `  curl -s '${pay}/_/check?url=https://10.0.0.5/prices'`,
    '  # A POST-only endpoint: a GET check finds no price, a POST check needs its header and finds one',
    `  ${check('/post-only')}`,
    `  curl -s '${pay}/_/check?url=${paidApi}/post-only&method=POST' -H "X-Anyfare-Check: 1"`,
    '  # A link nobody paid: a payable check lists it as checked. Open its service page after it.',
    `  curl -s '${pay}/_/check?url=${paidApi}/near&method=GET'`,
    `  ${website}/services/${stack.paidApiHost}`,
    '  # The same call on NEAR and on Tempo',
    `  curl -s ${pay}/${stack.paidApiHost}/near -H "Authorization: Bearer $KEY"`,
    `  curl -s ${pay}/${stack.paidApiHost}/tempo -H "Authorization: Bearer $KEY"`,
    '',
    ...stack.scratchDatabase === undefined
      ? ['Fill the database with a month of calls: npm run seed:local (and npm run seed:local -- --empty to take it away)']
      : [
        `Seed this database: npm run seed:local -- --scratch-name ${stack.scratchDatabase}   (add --checked-only for only the services a check listed)`,
      ],
    '',
  ].join('\n');
};

const logger: Logger = createLogger({ name: 'stack', level: (process.env['LOG_LEVEL']?.trim() || 'warn') as 'warn' });

try {
  const databaseUrl = process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'];
  if (!databaseUrl || !redisUrl)
    throw new StackPrerequisiteError('DATABASE_URL and REDIS_URL are not set. Copy .env.example to .env, and run: docker compose up -d');
  console.log('Starting the local stack…');
  const unknown = process.argv.slice(2).filter(argument => argument !== '--scratch');
  if (unknown.length > 0)
    throw new StackPrerequisiteError(`Unknown option ${unknown[0]}`);
  const stack = await startLocalStack({ databaseUrl, redisUrl, logger, scratch: process.argv.includes('--scratch') });
  console.log(describeStack(stack));

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping)
      return;
    stopping = true;
    console.log(`\n${signal}: stopping…`);
    void stack.close().then(() => {
      console.log('Stopped.');
      process.exit(0);
    }, (error: unknown) => {
      console.error('The stack did not stop cleanly:', error);
      process.exit(1);
    });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
catch (error) {
  if (error instanceof LocalOnlyError || error instanceof StackPrerequisiteError)
    console.error(error.message);
  else
    console.error(error);
  console.error(stackUsage);
  process.exit(1);
}
