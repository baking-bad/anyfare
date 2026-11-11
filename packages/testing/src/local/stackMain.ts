// `npm run stack:local`: a development tool. No app starts it.
import { createLogger, type Logger } from '@anyfare/common';

import { LocalOnlyError } from './guard.js';
import { startLocalStack, StackPrerequisiteError, type LocalStack } from './stack.js';

const stackUsage = 'Usage: npm run stack:local [-- --scratch] [--topup-deadline-minutes <10 to 10080>]\n'
  + '  --scratch  runs on a new empty database next to the local one, so every page starts at zero, and drops it when the stack stops\n'
  + '  --topup-deadline-minutes  how long a top-up\'s address takes transfers, for every token, so a top-up with no deposit expires soon (default: 1440 for a stablecoin, 120 for another token)\n'
  + 'Needs Postgres and Redis from docker-compose.yml, and DATABASE_URL and REDIS_URL in .env. LOG_LEVEL sets the apps\' log level (default: warn).\n'
  + 'CONSOLE_URL sets the console\'s origin, the only one the Platform API answers CORS for (default: http://127.0.0.1:3000, the website\'s server).';

const json = (field: string): string => `node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).${field}'`;

const topupStatuses: readonly (readonly [string, string])[] = [
  ['INCOMPLETE_DEPOSIT', 'less than the least arrived: incomplete'],
  ['PROCESSING', 'the deposit arrived: processing'],
  ['SUCCESS', 'swapped: the Credits are added: credited'],
  ['REFUNDED', 'sent back: refunded, nothing credited'],
  ['FAILED', 'failed at 1Click: failed'],
];

/** The text printed once the stack is up: its ports, and the commands that try it by hand. */
export const describeStack = (stack: LocalStack): string => {
  const { api, pay, website, console: consoleOrigin, paidApi, oneClick } = stack.urls;
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
    `  Console        ${consoleOrigin}   (the website's server under this name; the only origin the Platform API answers CORS for)`,
    '',
    'Fakes',
    `  Paid API       ${paidApi}   (self-signed certificate; the proxy trusts it)`,
    ...stack.paidApiEndpoints.map(endpoint => `    ${endpoint.path.padEnd(11)}${endpoint.what}`),
    `  Facilitator    ${stack.urls.facilitator}   (x402 on Base, Solana and NEAR)`,
    `  1Click         ${stack.urls.oneClick}   (moves a top-up through its states: see below)`,
    `  NEAR node      ${stack.urls.nearRpc}`,
    `  Tempo node     ${stack.urls.tempoRpc}`,
    ...stack.scratchDatabase === undefined ? [] : [
      '',
      `Database       ${stack.scratchDatabase}   (a new empty one: the local database is not used, and this one is dropped when the stack stops)`,
    ],
    '',
    'Top-ups: sign up and ask for an address, then move the swap by hand. The fake 1Click is the control; the workers read its answer',
    '',
    `  MASTER=$(curl -s -X POST ${api}/v1/accounts | ${json('masterKey')})`,
    `  curl -s -X POST ${api}/v1/topups -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' -d '{"network":"base","token":"USDC","amount":"1"}'`,
    '  # The quotes the fake made, newest last, with the address to move',
    `  curl -s ${oneClick}/_test/quotes`,
    '  # Move one (put its address in ADDRESS) to a status. The fills come from its quote; "swapDetails" in the body overrides any of them',
    ...topupStatuses.map(([status, what]) => `  curl -s -X POST ${oneClick}/_test/status -H 'content-type: application/json' -d "{\\"depositAddress\\":\\"$ADDRESS\\",\\"status\\":\\"${status}\\"}"   # ${what}`),
    `  curl -s ${api}/v1/topups/<id> -H "Authorization: Bearer $MASTER"   # and ${api}/v1/balance`,
    '  The workers ask the fake about every open top-up every 10 seconds, so a move shows in 10 to 20 seconds (a top-up older than an hour is asked',
    '  about once a minute until its pay-by time, then every 5 minutes). That pace is fixed in the workers; nothing here changes it.',
    ...stack.config.topups.deadlineMinutes.stablecoin === 1_440 && stack.config.topups.deadlineMinutes.other === 120
      ? [
        '  An expired top-up: a top-up with no deposit shows expired once its pay-by time passes, and that is 24 hours after it is made for a stablecoin',
        '  (2 hours for another token). Nothing moves it sooner for one top-up. Stop and start the stack with --topup-deadline-minutes 10, and a new',
        '  top-up expires 10 minutes after it is made, at the next poll.',
      ]
      : [
        `  An expired top-up: this stack's addresses take transfers for ${stack.config.topups.deadlineMinutes.stablecoin} minutes. Leave a new top-up with no deposit`,
        '  until then, and it shows expired at the next poll.',
      ],
    '',
    'Start the website against this stack, from the repository root, in another shell:',
    '',
    `  export SITE_URL=${website} CONSOLE_URL=${consoleOrigin} API_URL=${api} PAY_URL=${pay}`,
    '  npm run build -w @anyfare/web',
    '  cp -R packages/web/.next/static packages/web/.next/standalone/packages/web/.next/',
    // On 127.0.0.1, where both names reach it: Node would listen on ::1 alone for localhost, and the console's name is 127.0.0.1
    `  PORT=${stack.ports.website} HOSTNAME=127.0.0.1 node packages/web/.next/standalone/packages/web/server.js`,
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
  const argumentsGiven = process.argv.slice(2);
  const deadlineAt = argumentsGiven.indexOf('--topup-deadline-minutes');
  const minutes = deadlineAt < 0 ? undefined : Number(argumentsGiven[deadlineAt + 1]);
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 10 || minutes > 10_080))
    throw new StackPrerequisiteError('--topup-deadline-minutes takes a whole number from 10 to 10080');
  const unknown = argumentsGiven.filter((argument, index) => argument !== '--scratch' && argument !== '--topup-deadline-minutes' && (deadlineAt < 0 || index !== deadlineAt + 1));
  if (unknown.length > 0)
    throw new StackPrerequisiteError(`Unknown option ${unknown[0]}`);
  const stack = await startLocalStack({
    databaseUrl, redisUrl, logger, scratch: argumentsGiven.includes('--scratch'), ...minutes === undefined ? {} : { topupDeadlineMinutes: minutes },
  });
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
