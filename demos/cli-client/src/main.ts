import { runCli } from './cli.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  env: process.env,
  fetch: globalThis.fetch,
});
