// The end of a run: the exit code, once everything written to stdout and stderr is out.

import type { Writable } from 'node:stream';

/** Resolves once everything written to the stream before it is handed on. */
function written(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) {
      resolve();
      return;
    }
    stream.write('', () => resolve());
  });
}

/**
 * Exits with `code` once stdout and stderr hold all of the run's lines. The run does not wait for work
 * it gave up on: the NEAR SDK takes no abort signal, and retries an RPC that answers 503 twelve times
 * over about 86 seconds, and a fetch to an RPC that never answers waits up to 5 minutes. Its timers
 * would keep the process alive that long after the app said why it stopped.
 */
export async function exitWhenWritten(code: number, streams: readonly Writable[] = [process.stdout, process.stderr]): Promise<never> {
  await Promise.all(streams.map(written));
  process.exit(code);
}
