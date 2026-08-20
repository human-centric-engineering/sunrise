/**
 * Tests for `lib/orchestration/maintenance/app-jobs.ts` (#469).
 *
 * Two things carry real risk here: the cadence gate (a job that ignores its
 * interval hammers the DB every 60s, which is what #442 is about) and
 * containment (a fork's job must not break the maintenance tick).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const initAppJobs = vi.hoisted(() => vi.fn());
vi.mock('@/lib/app/jobs', () => ({ initAppJobs }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '@/lib/logging';

import {
  registerAppJob,
  runDueAppJobs,
  getAppJobs,
  getAppJobsMinIntervalMs,
  __resetAppJobsForTests,
} from '@/lib/orchestration/maintenance/app-jobs';

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  __resetAppJobsForTests();
  initAppJobs.mockReset().mockImplementation(() => {});
});

afterEach(() => {
  __resetAppJobsForTests();
});

describe('runDueAppJobs', () => {
  it('returns undefined when no job is registered', async () => {
    // Vanilla Sunrise: the seam must not add a key to the tick's log line.
    await expect(runDueAppJobs()).resolves.toBeUndefined();
  });

  it('runs a job on first tick and folds its return value into the summary', async () => {
    initAppJobs.mockImplementation(() =>
      registerAppJob({ name: 'app:sweep', intervalMs: HOUR, run: () => Promise.resolve({ n: 3 }) })
    );

    const summary = await runDueAppJobs(1_000_000);

    expect(summary).toEqual({ 'app:sweep': { n: 3 } });
  });

  it('skips a job whose interval has not elapsed', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    initAppJobs.mockImplementation(() =>
      registerAppJob({ name: 'app:sweep', intervalMs: HOUR, run })
    );

    const t0 = 1_000_000;
    await runDueAppJobs(t0);
    // Only a minute later — nowhere near the hour.
    const second = await runDueAppJobs(t0 + 60_000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ skipped: 1 });
  });

  it('runs again once the interval has elapsed', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    initAppJobs.mockImplementation(() =>
      registerAppJob({ name: 'app:sweep', intervalMs: HOUR, run })
    );

    const t0 = 1_000_000;
    await runDueAppJobs(t0);
    await runDueAppJobs(t0 + HOUR);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never starts a second copy of a job that is still running', async () => {
    // A job slower than its own interval would otherwise be restarted every
    // tick and stack up concurrent runs. Note the interval here has genuinely
    // elapsed — the in-flight guard, not the clock, is what holds it back.
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    initAppJobs.mockImplementation(() => registerAppJob({ name: 'app:slow', intervalMs: 1, run }));

    const t0 = 1_000_000;
    const first = runDueAppJobs(t0);
    // Next tick arrives while the job is still pending, and IS past the interval.
    const second = await runDueAppJobs(t0 + 10);

    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ skipped: 1 });

    release();
    await first;
  });

  it('contains a rejecting job and reports it in the summary', async () => {
    initAppJobs.mockImplementation(() =>
      registerAppJob({
        name: 'app:broken',
        intervalMs: HOUR,
        run: () => Promise.reject(new Error('boom')),
      })
    );

    const summary = await runDueAppJobs(1_000_000);

    expect(summary).toEqual({ 'app:broken': { error: 'boom' } });
  });

  it('runs the remaining jobs when one rejects', async () => {
    const healthy = vi.fn().mockResolvedValue('fine');
    initAppJobs.mockImplementation(() => {
      registerAppJob({
        name: 'app:broken',
        intervalMs: HOUR,
        run: () => Promise.reject(new Error('boom')),
      });
      registerAppJob({ name: 'app:healthy', intervalMs: HOUR, run: healthy });
    });

    const summary = await runDueAppJobs(1_000_000);

    expect(healthy).toHaveBeenCalled();
    expect(summary).toMatchObject({ 'app:healthy': 'fine' });
  });

  it('survives a throwing init and degrades to no jobs', async () => {
    initAppJobs.mockImplementation(() => {
      throw new Error('bad init');
    });

    await expect(runDueAppJobs()).resolves.toBeUndefined();
  });

  it('rolls back a PARTIAL init rather than running a job from a config that failed to load', async () => {
    // The shape that makes this worse than it looks: an `initAppJobs` that
    // registers two jobs and throws on the third leaves the first two running on
    // EVERY tick, forever, while the log says app jobs are disabled. A fork
    // author reading that message has no reason to guard their init.
    const orphan = vi.fn().mockResolvedValue('ran');
    initAppJobs.mockImplementation(() => {
      registerAppJob({ name: 'app:registered-first', intervalMs: HOUR, run: orphan });
      throw new Error('bad init on the second');
    });

    await expect(runDueAppJobs(1_000_000)).resolves.toBeUndefined();
    expect(orphan).not.toHaveBeenCalled();
    expect(getAppJobs()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'app-jobs: initAppJobs threw — app jobs rolled back and disabled',
      { error: 'bad init on the second' }
    );
  });

  it('leaves the idle gate free when a partial init is rolled back', async () => {
    // `getAppJobsMinIntervalMs()` is what stops the tick's idle gate skipping
    // ahead (#442). A rolled-back job must not keep this deployment awake — that
    // is a permanent cost paid for a config that never loaded.
    initAppJobs.mockImplementation(() => {
      registerAppJob({ name: 'app:registered-first', intervalMs: 5000, run: vi.fn() });
      throw new Error('bad init on the second');
    });

    expect(getAppJobsMinIntervalMs()).toBeNull();
  });

  it('runs the app init exactly once across many ticks', async () => {
    initAppJobs.mockImplementation(() =>
      registerAppJob({ name: 'app:x', intervalMs: HOUR, run: () => Promise.resolve(1) })
    );

    await runDueAppJobs(1);
    await runDueAppJobs(2);
    await runDueAppJobs(3);

    expect(initAppJobs).toHaveBeenCalledTimes(1);
  });
});

describe('getAppJobsMinIntervalMs', () => {
  // The tick's idle gate (#442) will not skip further ahead than this, so a
  // fork's 5-minute job cannot quietly become a 30-minute one.
  it('returns null when a fork registered nothing', () => {
    expect(getAppJobsMinIntervalMs()).toBeNull();
  });

  it('returns the shortest registered interval', () => {
    initAppJobs.mockImplementation(() => {
      registerAppJob({ name: 'app:nightly', intervalMs: 24 * HOUR, run: vi.fn() });
      registerAppJob({ name: 'app:sweep', intervalMs: 5 * 60 * 1000, run: vi.fn() });
      registerAppJob({ name: 'app:hourly', intervalMs: HOUR, run: vi.fn() });
    });

    expect(getAppJobsMinIntervalMs()).toBe(5 * 60 * 1000);
  });

  it('ignores a job that was refused at registration', () => {
    initAppJobs.mockImplementation(() => {
      registerAppJob({ name: 'app:bad', intervalMs: 0, run: vi.fn() });
      registerAppJob({ name: 'app:good', intervalMs: HOUR, run: vi.fn() });
    });

    // A refused zero-interval job must not bound the gate at zero, which would
    // disable it entirely.
    expect(getAppJobsMinIntervalMs()).toBe(HOUR);
  });
});

describe('registerAppJob', () => {
  it('refuses a non-positive interval rather than defaulting it', async () => {
    // A NaN/zero interval silently meaning "every tick" is the failure mode
    // this guard exists to prevent — it would hammer the DB every 60s.
    const run = vi.fn();
    initAppJobs.mockImplementation(() => {
      registerAppJob({ name: 'app:zero', intervalMs: 0, run });
      registerAppJob({ name: 'app:nan', intervalMs: Number.NaN, run });
      registerAppJob({ name: 'app:neg', intervalMs: -1, run });
    });

    expect(getAppJobs()).toEqual([]);
    await expect(runDueAppJobs()).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('replaces a job registered under the same name', async () => {
    const first = vi.fn().mockResolvedValue('first');
    const second = vi.fn().mockResolvedValue('second');
    initAppJobs.mockImplementation(() => {
      registerAppJob({ name: 'app:dup', intervalMs: HOUR, run: first });
      registerAppJob({ name: 'app:dup', intervalMs: HOUR, run: second });
    });

    await runDueAppJobs(1_000_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(getAppJobs()).toHaveLength(1);
  });
});
