import type { Clock, Logger } from '@anyfare/common';
import type { CallRecord, CallRepository } from '@anyfare/db';

export const defaultPollMs = 1_000;
// How far back each read looks again, for a payment written late: a transaction that committed after
// a later one, or a writer whose clock is behind ours
export const overlapMs = 5_000;
// The most calls one read takes. More waiting, and the next read follows on at once from the last.
export const pollBatch = 200;
// How far ahead of our clock a last update may count: a writer whose clock runs fast never moves the
// reads past other writers' calls
export const clockMarginMs = 1_000;

export interface CallFeedOptions {
  readonly calls: Pick<CallRepository, 'finalizedAfter'>;
  readonly clock: Clock;
  readonly logger: Logger;
  // Default: a second
  readonly pollMs?: number;
}

/** The calls that become final, each once, from the moment the first listener came. */
export interface CallFeed {
  /** Hears each call that becomes final from now on. Returns the unsubscribe. */
  subscribe(listener: (call: CallRecord) => void): () => void;
  /** Stops reading and waits for a read in flight. */
  close(): Promise<void>;
}

/**
 * One reader per API process: while anyone listens, it reads the calls whose payments became final
 * since its last read, by the index of final payments, and hands each to every listener. Each replica
 * reads for itself, so it needs nothing from the others, and the proxy writes nothing for it.
 */
export const createCallFeed = ({ calls, clock, logger, pollMs = defaultPollMs }: CallFeedOptions): CallFeed => {
  const listeners = new Set<(call: CallRecord) => void>();
  // Each start of reading: a read from an earlier one is dropped
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;
  const reading = new Set<Promise<void>>();
  let closed = false;
  let failing = false;
  // Nothing that became final before reading started
  let floor = 0;
  // The latest last update seen, never past our clock and the margin
  let newest = 0;
  let after = { updatedAt: new Date(0), id: '' };
  // The calls handed out that a read may see again, with their last update
  const handed = new Map<string, number>();

  // Whether a full read left more waiting
  const read = async (own: number): Promise<boolean> => {
    const rows = await calls.finalizedAfter({ after, limit: pollBatch });
    if (own !== generation)
      return false;
    const latest = clock.now().getTime() + clockMarginMs;
    for (const row of rows) {
      const updated = row.updatedAt.getTime();
      newest = Math.max(newest, Math.min(updated, latest));
      if (updated < floor || handed.has(row.id))
        continue;
      handed.set(row.id, updated);
      for (const listener of listeners) {
        try {
          listener(row);
        }
        catch (error) {
          logger.warn({ error, paymentId: row.id }, 'A listener of finished calls failed');
        }
      }
    }
    const last = rows.at(-1);
    if (last && rows.length === pollBatch) {
      // More waiting: on from the last one
      after = { updatedAt: last.updatedAt, id: last.id };
      return true;
    }
    // Then a little back again, for the calls written late
    const from = Math.max(floor, newest - overlapMs);
    after = { updatedAt: new Date(from), id: '' };
    for (const [id, updated] of handed) {
      if (updated < from)
        handed.delete(id);
    }

    return false;
  };

  // The next read: at once after a full one, else in a poll
  const schedule = (own: number, delayMs = pollMs): void => {
    timer = setTimeout(() => {
      timer = undefined;
      let more = false;
      const done: Promise<void> = read(own)
        .then(full => {
          more = full;
          if (failing)
            logger.info('Finished calls are read again');
          failing = false;
        }, (error: unknown) => {
          // Once per outage
          if (!failing)
            logger.warn({ error }, 'Finished calls couldn\'t be read. The stream retries every poll.');
          failing = true;
        })
        .finally(() => {
          reading.delete(done);
          if (!closed && listeners.size > 0 && own === generation)
            schedule(own, more ? 0 : pollMs);
        });
      reading.add(done);
    }, delayMs);
    timer.unref();
  };

  const start = (): void => {
    generation += 1;
    floor = clock.now().getTime();
    newest = floor;
    after = { updatedAt: new Date(floor), id: '' };
    handed.clear();
    schedule(generation);
  };

  const stop = (): void => {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
    handed.clear();
  };

  return {
    subscribe: listener => {
      listeners.add(listener);
      if (listeners.size === 1 && !closed)
        start();

      return () => {
        if (listeners.delete(listener) && listeners.size === 0)
          stop();
      };
    },
    close: async () => {
      closed = true;
      stop();
      listeners.clear();
      await Promise.allSettled([...reading]);
    },
  };
};
