import { fixtureTime } from '@anyfare/testing';

import { Registry } from '@prometheus-io/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@anyfare/common';
import { createPostgres, type Postgres } from '@anyfare/db';
import { createFakeClock, createManualTimers, createTestDatabase, type TestDatabase } from '@anyfare/testing';

import { createScheduler, RunStoppedError, type Job } from '../../src/scheduler.js';

const logger = createLogger({ level: 'silent' });
const start = fixtureTime(0, 9, 12, 0, 0, 0);

let database: TestDatabase;
// A second replica: its own pool, so its own sessions
let replica: Postgres;
let lockId = 9_100;

beforeAll(async () => {
  database = await createTestDatabase();
  replica = createPostgres({ url: database.url, logger });
});

afterAll(async () => {
  await replica?.close();
  await database?.drop();
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(onResolve => {
    resolve = onResolve;
  });

  return { promise, resolve };
};

const setup = (run: (stopping: AbortSignal) => Promise<void>, locks: Pick<Postgres, 'tryAdvisoryLock'> = database.postgres) => {
  lockId += 1;
  const registry = new Registry();
  const clock = createFakeClock(start);
  const timers = createManualTimers();
  const job: Job = { name: 'test_job', lockId, intervalMs: 60_000, run };
  const scheduler = createScheduler({ jobs: [job], locks, clock, timers, logger, registry });

  return { scheduler, registry, clock, timers, job };
};

const metric = async (registry: Registry, series: string): Promise<number | undefined> => {
  const line = (await registry.metrics()).split('\n').find(text => text.startsWith(`${series} `));

  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

describe('the job scheduler', () => {
  it('runs a job on one replica at a time: the other finds the lock taken and skips', async () => {
    const gate = deferred();
    let runs = 0;
    const run = async () => {
      runs += 1;
      await gate.promise;
    };
    const first = setup(run);
    const second = createScheduler({ jobs: [first.job], locks: replica, clock: first.clock, timers: first.timers, logger, registry: new Registry() });

    const running = first.scheduler.runNow('test_job');
    await vi.waitFor(() => expect(runs).toBe(1));
    const skipped = await second.runNow('test_job');
    gate.resolve();

    expect(skipped).toBe('skipped');
    expect(await running).toBe('success');
    expect(runs).toBe(1);
    // Free again once the first run ended
    expect(await second.runNow('test_job')).toBe('success');
  });

  it('exports the last success time from the Clock, the last run\'s duration, and runs by result', async () => {
    let fail = false;
    const { scheduler, registry, clock } = setup(async () => {
      if (fail)
        throw new Error('boom');
    });

    await scheduler.runNow('test_job');
    clock.advance(60_000);
    fail = true;
    expect(await scheduler.runNow('test_job')).toBe('failure');

    // A failed run leaves the last success where it was, so the job goes stale
    expect(await metric(registry, 'workers_job_last_success_timestamp_seconds{job="test_job"}')).toBe(Date.parse(start) / 1_000);
    expect(await metric(registry, 'workers_job_duration_seconds{job="test_job"}')).toBeGreaterThanOrEqual(0);
    expect(await metric(registry, 'workers_job_runs_total{job="test_job",result="success"}')).toBe(1);
    expect(await metric(registry, 'workers_job_runs_total{job="test_job",result="failure"}')).toBe(1);
  });

  it('counts a skipped run, and leaves the last success time alone', async () => {
    const gate = deferred();
    const started = deferred();
    const first = setup(async () => {
      started.resolve();
      await gate.promise;
    });
    const registry = new Registry();
    const second = createScheduler({ jobs: [first.job], locks: replica, clock: first.clock, timers: createManualTimers(), logger, registry });

    const running = first.scheduler.runNow('test_job');
    await started.promise;
    const skipped = await second.runNow('test_job');
    gate.resolve();
    await running;

    expect(skipped).toBe('skipped');
    expect(await metric(registry, 'workers_job_runs_total{job="test_job",result="skipped"}')).toBe(1);
    expect(await metric(registry, 'workers_job_last_success_timestamp_seconds{job="test_job"}')).toBe(0);
  });

  it('runs every interval once started, never two runs of a job at once, and stops waiting for the run in progress', async () => {
    let runs = 0;
    let gate = deferred();
    const { scheduler, timers } = setup(async () => {
      runs += 1;
      await gate.promise;
    });

    await scheduler.start();
    timers.advance(59_999);
    expect(runs).toBe(0);
    timers.advance(1);
    await vi.waitFor(() => expect(runs).toBe(1));
    // The next run is scheduled only after this one ends
    timers.advance(120_000);
    expect(runs).toBe(1);
    gate.resolve();
    await vi.waitFor(() => expect(timers.pending).toBe(1));
    gate = deferred();
    timers.advance(60_000);
    await vi.waitFor(() => expect(runs).toBe(2));

    let stopped = false;
    const stopping = (async () => {
      await scheduler.stop();
      stopped = true;
    })();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    timers.advance(600_000);

    expect(timers.pending).toBe(0);
    expect(runs).toBe(2);
  });

  it('exports every job\'s last success time as 0 until its first success, so a job that never ran shows stale', async () => {
    const { registry } = setup(async () => undefined);

    expect(await metric(registry, 'workers_job_last_success_timestamp_seconds{job="test_job"}')).toBe(0);
  });

  it.each([
    ['an hour', 3_600_000, 3_600_000],
    ['now, for none', 0, 0],
    ['now, for a time already past', -5_000, 0],
  ])('runs a job first when its firstRunDelayMs says: %s', async (_case, delayMs, dueMs) => {
    lockId += 1;
    let runs = 0;
    const timers = createManualTimers();
    const job: Job = {
      name: 'delayed_job', lockId, intervalMs: 24 * 60 * 60_000, firstRunDelayMs: async () => delayMs,
      run: async () => {
        runs += 1;
      },
    };
    const scheduler = createScheduler({ jobs: [job], locks: database.postgres, clock: createFakeClock(start), timers, logger, registry: new Registry() });

    await scheduler.start();
    if (dueMs > 0) {
      timers.advance(dueMs - 1);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(runs).toBe(0);
    }
    timers.advance(dueMs > 0 ? 1 : 0);
    await vi.waitFor(() => expect(runs).toBe(1));
    // Then once an interval
    await vi.waitFor(() => expect(timers.pending).toBe(1));
    timers.advance(24 * 60 * 60_000);
    await vi.waitFor(() => expect(runs).toBe(2));
    await scheduler.stop();
  });

  it('runs a job now when its firstRunDelayMs fails, with a warning', async () => {
    lockId += 1;
    const lines: Record<string, unknown>[] = [];
    let runs = 0;
    const timers = createManualTimers();
    const job: Job = {
      name: 'delayed_job', lockId, intervalMs: 60_000,
      firstRunDelayMs: async () => {
        throw new Error('Connection terminated');
      },
      run: async () => {
        runs += 1;
      },
    };
    const capturing = createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const scheduler = createScheduler({ jobs: [job], locks: database.postgres, clock: createFakeClock(start), timers, logger: capturing, registry: new Registry() });

    await scheduler.start();
    timers.advance(0);
    await vi.waitFor(() => expect(runs).toBe(1));
    await scheduler.stop();

    expect(lines.find(line => line['msg'] === 'Couldn\'t tell when a job should first run: it runs now')).toMatchObject({ level: 40, job: 'delayed_job' });
  });

  it('schedules nothing when stopped while its start waits for a first-run delay', async () => {
    lockId += 1;
    let release!: (value: number) => void;
    const timers = createManualTimers();
    const job: Job = {
      name: 'delayed_job', lockId, intervalMs: 60_000, firstRunDelayMs: () => new Promise<number>(resolve => {
        release = resolve;
      }),
      run: async () => undefined,
    };
    const scheduler = createScheduler({ jobs: [job], locks: database.postgres, clock: createFakeClock(start), timers, logger, registry: new Registry() });

    const starting = scheduler.start();
    await scheduler.stop();
    release(0);
    await starting;

    expect(timers.pending).toBe(0);
  });

  it('schedules a job that comes after others once their first runs ended, failed ones too, its delay counted from then', async () => {
    const order: string[] = [];
    const timers = createManualTimers();
    const gate = deferred();
    const job = (name: string, changes: Partial<Job>, run: () => Promise<void> = async () => undefined): Job => {
      lockId += 1;

      return { name, lockId, intervalMs: 60_000, run: async () => {
        order.push(name);
        await run();
      }, ...changes };
    };
    const jobs = [
      job('first', { intervalMs: 30_000 }, async () => {
        throw new Error('boom');
      }),
      job('second', {}, () => gate.promise),
      job('later', { after: ['first', 'second', 'missing'], firstRunDelayMs: async () => 0 }),
    ];
    const scheduler = createScheduler({ jobs, locks: database.postgres, clock: createFakeClock(start), timers, logger, registry: new Registry() });

    try {
      await scheduler.start();
      timers.advance(0);
      timers.advance(30_000);
      await vi.waitFor(() => expect(order).toEqual(['first']));
      timers.advance(30_000);
      await vi.waitFor(() => expect(order).toContain('second'));
      timers.advance(0);
      await new Promise(resolve => setTimeout(resolve, 20));
      // Still waiting for the second's first run to end
      expect(order).not.toContain('later');
      gate.resolve();
      await vi.waitFor(() => {
        timers.advance(0);
        expect(order).toContain('later');
      });
    }
    finally {
      gate.resolve();
      await scheduler.stop();
    }
  });

  it('tells a running job to stop when it stops, and counts the run stopped when it ends early', async () => {
    let steps = 0;
    const { scheduler, registry } = setup(async stopping => {
      for (;;) {
        if (stopping.aborted)
          throw new RunStoppedError({ steps });
        steps += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });

    const running = scheduler.runNow('test_job');
    await vi.waitFor(() => expect(steps).toBeGreaterThan(0));
    const started = performance.now();
    await scheduler.stop();

    expect(await running).toBe('stopped');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await metric(registry, 'workers_job_runs_total{job="test_job",result="stopped"}')).toBe(1);
  });

  it('comes after every job that comes after none and is due within its interval, and not one due later', async () => {
    const order: string[] = [];
    const timers = createManualTimers();
    const job = (name: string, changes: Partial<Job>): Job => {
      lockId += 1;

      return { name, lockId, intervalMs: 60_000, run: async () => {
        order.push(name);
      }, ...changes };
    };
    const jobs = [
      job('soon', { intervalMs: 30_000 }),
      job('within', { intervalMs: 300_000 }),
      job('daily', { intervalMs: 86_400_000, firstRunDelayMs: async () => 86_400_000 }),
      job('later', { intervalMs: 300_000, afterOthers: true, firstRunDelayMs: async () => 0 }),
    ];
    const scheduler = createScheduler({ jobs, locks: database.postgres, clock: createFakeClock(start), timers, logger, registry: new Registry() });
    try {
      await scheduler.start();
      timers.advance(30_000);
      await vi.waitFor(() => expect(order).toContain('soon'));
      timers.advance(0);
      await new Promise(resolve => setTimeout(resolve, 20));
      // The one due within its interval hasn't run yet
      expect(order).not.toContain('later');
      timers.advance(270_000);
      await vi.waitFor(() => {
        timers.advance(0);
        expect(order).toContain('later');
      });
      // The daily one is a day away, and not waited for
      expect(order).not.toContain('daily');
    }
    finally {
      await scheduler.stop();
    }
  });

  it('takes a job\'s lock on its own sessions when it names them', async () => {
    lockId += 1;
    let runs = 0;
    const job: Job = { name: 'own_locks', lockId, intervalMs: 60_000, locks: replica, run: async () => {
      runs += 1;
    } };
    const scheduler = createScheduler({ jobs: [job], locks: database.postgres, clock: createFakeClock(start), timers: createManualTimers(), logger, registry: new Registry() });
    // Held on the scheduler's own sessions: the job's are another pool, so it skips
    const unlock = (await database.postgres.tryAdvisoryLock(lockId))!;
    try {
      expect(await scheduler.runNow('own_locks')).toBe('skipped');
    }
    finally {
      await unlock();
    }
    expect(await scheduler.runNow('own_locks')).toBe('success');
    expect(runs).toBe(1);
  });

  it('refuses to run a job it doesn\'t have', () => {
    const { scheduler } = setup(async () => undefined);

    expect(() => scheduler.runNow('no_such_job')).toThrow('No job named no_such_job');
  });
});

describe('the scheduler\'s lines', () => {
  const captured = () => {
    const lines: Record<string, unknown>[] = [];
    const capturing = createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

    return { lines, capturing };
  };
  const schedulerWith = (run: Job['run'], capturing: ReturnType<typeof createLogger>, locks: Pick<Postgres, 'tryAdvisoryLock'> = database.postgres) => {
    lockId += 1;
    const job: Job = { name: 'logged_job', lockId, intervalMs: 60_000, run };

    return { job, scheduler: createScheduler({ jobs: [job], locks, clock: createFakeClock(start), timers: createManualTimers(), logger: capturing, registry: new Registry() }) };
  };

  it('logs a run that did something at info, with the job, its counts, and the duration; a run that did nothing at debug', async () => {
    const { lines, capturing } = captured();
    let acted = true;
    const { scheduler } = schedulerWith(async () => ({ counts: { captured: acted ? 2 : 0, released: 0 }, acted }), capturing);

    await scheduler.runNow('logged_job');
    acted = false;
    await scheduler.runNow('logged_job');

    expect(lines.filter(line => line['msg'] === 'A job ran')).toEqual([
      expect.objectContaining({ level: 30, job: 'logged_job', counts: { captured: 2, released: 0 }, durationMs: expect.any(Number) }),
      expect.objectContaining({ level: 20, job: 'logged_job', counts: { captured: 0, released: 0 } }),
    ]);
  });

  it('logs a failed run at error, with the cause chain and the counts it reached', async () => {
    const { lines, capturing } = captured();
    const { scheduler } = schedulerWith(async () => {
      throw Object.assign(new Error('2 expired holds couldn\'t be finished', { cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }) }), {
        result: { captured: 1, released: 0, failed: 2 },
      });
    }, capturing);

    expect(await scheduler.runNow('logged_job')).toBe('failure');

    expect(lines.filter(line => line['msg'] === 'A job failed')).toEqual([expect.objectContaining({
      level: 50, job: 'logged_job', counts: { captured: 1, released: 0, failed: 2 }, durationMs: expect.any(Number),
      error: expect.objectContaining({ message: '2 expired holds couldn\'t be finished: deadlock detected', cause: expect.objectContaining({ code: '40P01' }), stack: expect.any(String) }),
    })]);
  });

  it('logs a run whose lock can\'t be taken at error, as a failure', async () => {
    const { lines, capturing } = captured();
    const { scheduler } = schedulerWith(async () => undefined, capturing, {
      tryAdvisoryLock: async () => {
        throw new Error('Connection terminated');
      },
    });

    expect(await scheduler.runNow('logged_job')).toBe('failure');

    expect(lines.filter(line => line['msg'] === 'A job failed')).toEqual([
      expect.objectContaining({ level: 50, job: 'logged_job', error: expect.objectContaining({ message: 'Connection terminated' }) }),
    ]);
  });

  it('logs a run skipped for another replica\'s lock at debug', async () => {
    const { lines, capturing } = captured();
    const gate = deferred();
    const started = deferred();
    const first = schedulerWith(async () => {
      started.resolve();
      await gate.promise;
    }, capturing);
    const second = createScheduler({
      jobs: [first.job], locks: replica, clock: createFakeClock(start), timers: createManualTimers(), logger: capturing, registry: new Registry(),
    });

    const running = first.scheduler.runNow('logged_job');
    await started.promise;
    const skipped = await second.runNow('logged_job');
    gate.resolve();
    await running;

    expect(skipped).toBe('skipped');

    expect(lines.find(line => line['msg'] === 'A job run was skipped: another replica holds its lock')).toMatchObject({ level: 20, job: 'logged_job' });
  });
});
