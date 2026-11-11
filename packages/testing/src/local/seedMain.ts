// `npm run seed:local`: a development tool. No app starts it.
import { describeSummary, runSeedCommand, seedUsage } from './seedCommand.js';
import { LocalOnlyError } from './guard.js';

const started = performance.now();
try {
  const result = await runSeedCommand({ args: process.argv.slice(2), env: process.env, log: line => console.log(line) });
  const seconds = ((performance.now() - started) / 1_000).toFixed(1);
  const scratch = result.scratchDatabase === undefined || result.mode === 'drop' ? '' : `\nThe scratch database: ${result.scratchDatabase}`;
  if (result.mode === 'drop')
    console.log('Done.');
  else
    console.log(result.summary ? `${describeSummary(result.summary)}${scratch}\nDone in ${seconds} s.` : `Done in ${seconds} s. The seeded rows are gone.${scratch}`);
}
catch (error) {
  if (error instanceof LocalOnlyError)
    console.error(error.message);
  else {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause)
      console.error(error.cause);
    console.error(seedUsage);
  }
  process.exitCode = 1;
}
