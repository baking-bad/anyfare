import { createLogger, type IdGenerator, type Logger } from '../../src/index.js';

export interface CapturedLogs {
  readonly logger: Logger;
  readonly lines: Record<string, unknown>[];
}

/** A logger that keeps every JSON line it writes, for assertions on log content. */
export const captureLogs = (): CapturedLogs => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

  return { logger, lines };
};

/** An ID generator that counts: `req-1`, `req-2`, and so on. */
export const createFakeIdGenerator = (prefix: string): IdGenerator => {
  let count = 0;

  return { next: () => `${prefix}${++count}` };
};
