import { runCli } from './cli.ts';
import { exitWhenWritten } from './exit.ts';

const code = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  env: process.env,
  fetch: globalThis.fetch,
  onInterrupt: (listener) => {
    process.on('SIGINT', listener);
    return () => {
      process.off('SIGINT', listener);
    };
  },
});
await exitWhenWritten(code);
