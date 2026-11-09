// Run in a child process by x402.test.ts: a NEAR call whose signer the app gives up on after 400 ms,
// ended as main.ts ends a run. It reaches no host but 127.0.0.1: the fake Anyfare and the made-up NEAR
// RPC are the parent's, and the APIs' own answers are the recorded ones.

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../../src/context.ts';
import { exitWhenWritten } from '../../src/exit.ts';
import { DEFAULT_ARGS } from '../../src/tools/index.ts';
import { Stop } from '../../src/util.ts';
import { callWithX402 } from '../../src/x402.ts';
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
  code = await callWithX402(ctx, { args: DEFAULT_ARGS.evidence, explain: false, yes: true }, 'near', { signingMs: 400 });
} catch (error) {
  process.stderr.write(`${error instanceof Stop ? error.line() : String(error)}\n`);
  code = 1;
} finally {
  ctx.close();
}
await exitWhenWritten(code);
