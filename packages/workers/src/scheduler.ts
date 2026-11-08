import { Counter, Gauge, type Registry } from '@prometheus-io/client';

import { isRecord, type Clock, type Logger, type Timers } from '@anyfare/common';
import type { Postgres } from '@anyfare/db';

/** What a run did, for its log line. */
export interface JobOutcome {
  // Counts by outcome, such as `{ captured: 2, released: 1 }`
  readonly counts: Readonly<Record<string, number | string | boolean | null>>;
  // Whether the run did something: its line is info. A run that found nothing to do is debug.
  readonly acted: boolean;
}

/** A background job. */
export interface Job {
  // A label for logs and metrics, such as `hold_expiry`
  readonly name: string;
  // The Postgres advisory lock that keeps one runner across replicas
  readonly lockId: number;
  // The pause between the end of one run and the start of the next
  readonly intervalMs: number;
  /** One run. It must be idempotent and safe to rerun after a crash. Throwing marks it failed. */
  run(): Promise<JobOutcome | void>;
  /**
   * How long after start its first run comes, such as from when it last ran, so a job with a long
   * interval still runs across frequent restarts. Default: one interval. Zero or less: now.
   */
  firstRunDelayMs?(): Promise<number>;
}

export type JobRunResult = 'success' | 'failure' | 'skipped';

export interface Scheduler {
  /** Schedules every job's first run: one interval from now, or when its `firstRunDelayMs` says. */
  start(): Promise<void>;
  /** Stops scheduling, and waits for the runs in progress. */
  stop(): Promise<void>;
  /** Runs one job now, under its lock: `skipped` when another runner holds it. */
  runNow(name: string): Promise<JobRunResult>;
}

export interface SchedulerOptions {
  readonly jobs: readonly Job[];
  readonly locks: Pick<Postgres, 'tryAdvisoryLock'>;
  // The last success times
  readonly clock: Clock;
  readonly timers: Timers;
  readonly logger: Logger;
  readonly registry: Registry;
}

// A run that failed and was logged already
class JobFailedError extends Error {}

/**
 * Runs each job every interval, under its advisory lock, so one replica runs it at a time. A run that
 * finds the lock taken skips. Each job exports its last success time, 0 until its first, and the
 * duration of its last run, so an alert can fire when a job goes stale or never ran.
 */
export const createScheduler = ({ jobs, locks, clock, timers, logger, registry }: SchedulerOptions): Scheduler => {
  const lastSuccess = new Gauge({
    name: 'workers_job_last_success_timestamp_seconds',
    help: 'When each job last finished without an error, in seconds since the epoch',
    labelNames: ['job'] as const,
    registers: [registry],
  });
  const duration = new Gauge({
    name: 'workers_job_duration_seconds',
    help: 'How long each job\'s last run took',
    labelNames: ['job'] as const,
    registers: [registry],
  });
  const runs = new Counter({
    name: 'workers_job_runs_total',
    help: 'Job runs by result: success, failure, or skipped (another replica holds the lock)',
    labelNames: ['job', 'result'] as const,
    registers: [registry],
  });

  // Every job's series from the start: a job that never succeeds is as stale as one that stopped
  for (const job of jobs)
    lastSuccess.set({ job: job.name }, 0);

  const byName = new Map(jobs.map(job => [job.name, job]));
  const handles = new Map<string, unknown>();
  const running = new Set<Promise<JobRunResult>>();
  let stopped = true;

  const runLocked = async (job: Job): Promise<JobRunResult> => {
    const unlock = await locks.tryAdvisoryLock(job.lockId);
    if (!unlock) {
      // Another replica runs it now: an ordinary outcome
      logger.debug({ job: job.name }, 'A job run was skipped: another replica holds its lock');
      return 'skipped';
    }

    const started = performance.now();
    const durationMs = (): number => Math.round(performance.now() - started);
    try {
      let outcome: JobOutcome | void;
      try {
        outcome = await job.run();
      }
      catch (error) {
        // The cause chain, and the counts the run reached, when its error carries them
        const counts = isRecord(error) && isRecord(error['result']) ? { counts: error['result'] } : {};
        logger.error({ error, job: job.name, ...counts, durationMs: durationMs() }, 'A job failed');
        throw new JobFailedError();
      }
      lastSuccess.set({ job: job.name }, clock.now().getTime() / 1_000);
      // One line per run, info when it did something
      logger[outcome?.acted ? 'info' : 'debug']({ job: job.name, counts: outcome?.counts ?? {}, durationMs: durationMs() }, 'A job ran');

      return 'success';
    }
    finally {
      duration.set({ job: job.name }, (performance.now() - started) / 1_000);
      await unlock();
    }
  };

  const run = async (job: Job): Promise<JobRunResult> => {
    let result: JobRunResult;
    try {
      result = await runLocked(job);
    }
    catch (error) {
      // The job's own failure is logged where it happened; this is the lock or its connection
      if (!(error instanceof JobFailedError))
        logger.error({ error, job: job.name }, 'A job failed');
      result = 'failure';
    }
    runs.inc({ job: job.name, result });

    return result;
  };

  const track = async (job: Job): Promise<JobRunResult> => {
    const promise = run(job);
    running.add(promise);
    try {
      return await promise;
    }
    finally {
      running.delete(promise);
    }
  };

  const schedule = (job: Job, delayMs = job.intervalMs): void => {
    if (stopped)
      return;

    handles.set(job.name, timers.setTimeout(() => {
      handles.delete(job.name);
      void (async () => {
        await track(job);
        schedule(job);
      })();
    }, Math.max(0, delayMs)));
  };

  const firstDelayOf = async (job: Job): Promise<number> => {
    if (!job.firstRunDelayMs)
      return job.intervalMs;
    try {
      return await job.firstRunDelayMs();
    }
    catch (error) {
      // Better a run too many than none across restarts
      logger.warn({ error, job: job.name }, 'Couldn\'t tell when a job should first run: it runs now');
      return 0;
    }
  };

  return {
    start: async () => {
      if (!stopped)
        return;

      stopped = false;
      await Promise.all(jobs.map(async job => schedule(job, await firstDelayOf(job))));
    },
    stop: async () => {
      stopped = true;
      for (const handle of handles.values())
        timers.clearTimeout(handle);
      handles.clear();
      await Promise.allSettled([...running]);
    },
    runNow: name => {
      const job = byName.get(name);
      if (!job)
        throw new Error(`No job named ${name}`);

      return track(job);
    },
  };
};
