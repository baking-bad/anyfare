// Run in a child process by tempo.test.ts: a 3Route call paid with USDC.e on Tempo whose RPC never
// answers, given up on after 400 ms, ended as main.ts ends a run. It reaches no host but 127.0.0.1: the
// fake Anyfare and the made-up Tempo RPC are the parent's, and the APIs' own answers are the recorded ones.

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../../src/context.ts';
import { exitWhenWritten } from '../../src/exit.ts';
import { callWithTempo } from '../../src/tempo.ts';
import { DEFAULT_ARGS } from '../../src/tools/index.ts';
import { Stop } from '../../src/util.ts';
import { forwardingFetch, toolRoutes } from '../fakeAnyfare.ts';

const { fetch } = forwardingFetch(toolRoutes());
const ctx = createContext({
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  isTerminal: false,
  env: process.env,
  fetch,
  // A directory that does not exist, so that nothing can be read or saved by mistake
  appDir: join(tmpdir(), `anyfare-cli-no-app-${randomUUID()}`),
});
let code = 0;
try {
  code = await callWithTempo(ctx, { args: DEFAULT_ARGS['3route'], explain: false, yes: true }, { signingMs: 400 });
} catch (error) {
  process.stderr.write(`${error instanceof Stop ? error.line() : String(error)}\n`);
  code = 1;
} finally {
  ctx.close();
}
await exitWhenWritten(code);
