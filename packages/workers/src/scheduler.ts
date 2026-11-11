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
  /**
   * One run. It must be idempotent and safe to rerun after a crash. Throwing marks it failed. `stopping`
   * aborts when the scheduler stops: a long run may end early, between two of its steps.
   */
  run(stopping: AbortSignal): Promise<JobOutcome | void>;
  /**
   * How long after start its first run comes, such as from when it last ran, so a job with a long
   * interval still runs across frequent restarts. Default: one interval. Zero or less: now.
   */
  firstRunDelayMs?(): Promise<number>;
  /**
   * Jobs whose first runs in this process must have ended, whatever their result, before this job's
   * first run is scheduled: its delay counts from then. A name of no job here is ignored.
   */
  readonly after?: readonly string[];
  /**
   * Comes after every job that comes after none, too: those whose first run is due within this job's
   * interval of the start. One due later, such as a daily job, isn't waited for.
   */
  readonly afterOthers?: boolean;
  // Its advisory lock's sessions. Default: the scheduler's.
  readonly locks?: Pick<Postgres, 'tryAdvisoryLock'>;
}

// Stopped: the scheduler stopped while it ran, and it ended early
export type JobRunResult = 'success' | 'failure' | 'skipped' | 'stopped';

export interface Scheduler {
  /**
   * Schedules every job's first run: one interval from now, or when its `firstRunDelayMs` says, counted
   * from when the jobs it comes `after` first ran.
   */
  start(): Promise<void>;
  /** Stops scheduling, tells the runs in progress to stop, and waits for them. */
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
// A run that ended early as the scheduler stopped, and was logged already
class JobStoppedError extends Error {}

/** What a run throws when it ends early because `stopping` aborted, with the counts it reached. */
export class RunStoppedError extends Error {
  constructor(readonly result: Readonly<Record<string, number>> = {}) {
    super('The run ended early: the workers are stopping');
  }
}

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
    help: 'Job runs by result: success, failure, skipped (another replica holds the lock), or stopped (it ended early as the workers stopped)',
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
  let stopping = new AbortController();

  // Each job's first run in this process, ended
  const firstRuns = new Map(jobs.map(job => {
    let ended!: () => void;
    const promise = new Promise<void>(resolve => {
      ended = resolve;
    });

    return [job.name, { promise, ended }] as const;
  }));

  const runLocked = async (job: Job): Promise<JobRunResult> => {
    const unlock = await (job.locks ?? locks).tryAdvisoryLock(job.lockId);
    if (!unlock) {
      // Another replica runs it now: an ordinary outcome
      logger.debug({ job: job.name }, 'A job run was skipped: another replica holds its lock');
      return 'skipped';
    }

    const started = performance.now();
    const durationMs = (): number => Math.round(performance.now() - started);
    try {
      let outcome: JobOutcome | void;
      const { signal } = stopping;
      try {
        outcome = await job.run(signal);
      }
      catch (error) {
        // The cause chain, and the counts the run reached, when its error carries them
        const counts = isRecord(error) && isRecord(error['result']) ? { counts: error['result'] } : {};
        if (error instanceof RunStoppedError) {
          logger.info({ job: job.name, ...counts, durationMs: durationMs() }, 'A job stopped early: the workers are stopping');
          throw new JobStoppedError();
        }
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
      if (!(error instanceof JobFailedError) && !(error instanceof JobStoppedError))
        logger.error({ error, job: job.name }, 'A job failed');
      result = error instanceof JobStoppedError ? 'stopped' : 'failure';
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
      firstRuns.get(job.name)?.ended();
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
      if (stopping.signal.aborted)
        stopping = new AbortController();
      const comesAfter = (job: Job): boolean => job.afterOthers === true || job.after?.some(name => byName.has(name)) === true;
      const first = jobs.filter(job => !comesAfter(job));
      const delays = new Map(await Promise.all(first.map(async job => [job.name, await firstDelayOf(job)] as const)));
      for (const job of first)
        schedule(job, delays.get(job.name));
      // The others once the jobs they come after have run once
      for (const job of jobs.filter(comesAfter)) {
        const names = [
          ...(job.after ?? []).filter(name => byName.has(name)),
          ...job.afterOthers === true ? first.filter(other => (delays.get(other.name) ?? 0) <= job.intervalMs).map(other => other.name) : [],
        ];
        void (async () => {
          await Promise.all(names.map(name => firstRuns.get(name)!.promise));
          schedule(job, await firstDelayOf(job));
        })();
      }
    },
    stop: async () => {
      stopped = true;
      // A long run ends between two of its steps, so shutdown doesn't wait for it to finish
      stopping.abort();
      // Nothing waits for a first run that won't come
      for (const first of firstRuns.values())
        first.ended();
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
