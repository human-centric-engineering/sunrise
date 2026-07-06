/**
 * Next.js instrumentation hook.
 *
 * Runs once per server process on startup. We use it to drive an
 * in-process maintenance ticker in **development only**.
 *
 * Why dev-only:
 *   - Production deployments run the maintenance tick via an external
 *     cron (see `.context/orchestration/scheduling.md`). The cron is
 *     authoritative and survives serverless cold starts.
 *   - Without this hook, dev developers have to remember to POST the
 *     maintenance tick endpoint manually — queued evaluation runs,
 *     scheduled workflows, retry queues etc. otherwise sit idle and
 *     "didn't progress" looks like a bug.
 *
 * The interval mirrors a typical production cron cadence (60s). The
 * shared `runMaintenanceTick()` body holds its own overlap guard, so
 * a slow tick can't pile up — the next interval call skips with a
 * "previous tick still running" log line.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // App boot seam — runs in ALL environments (prod included), so it sits above
  // the dev-only ticker guards below. Core carries zero reference to any fork:
  // the reserved `lib/app/bootstrap.ts` ships an empty `initApp()` and a fork
  // fills it (dynamically importing its own framework tier). Isolated in
  // try/catch so a fork's boot failure can't crash instrumentation or prevent
  // the dev maintenance ticker from arming. See lib/app/bootstrap.ts.
  try {
    const { initApp } = await import('@/lib/app/bootstrap');
    await initApp();
  } catch (err) {
    const { logger } = await import('@/lib/logging');
    logger.error('instrumentation: app boot seam (initApp) failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (process.env.NODE_ENV !== 'development') return;
  if (process.env.SUNRISE_DISABLE_DEV_TICK === '1') return;

  const { runMaintenanceTick } = await import('@/lib/orchestration/maintenance/run-tick');
  const { logger } = await import('@/lib/logging');

  const INTERVAL_MS = 60_000;

  logger.info('Dev maintenance ticker armed', {
    intervalMs: INTERVAL_MS,
    disableEnv: 'SUNRISE_DISABLE_DEV_TICK=1',
  });

  // First tick fires ~3s after startup so the initial dev compile +
  // route warm-up doesn't have to compete with the tick chain for
  // CPU. Subsequent ticks are at INTERVAL_MS cadence.
  const initialDelay = setTimeout(() => {
    void runMaintenanceTick().catch((err: unknown) => {
      logger.error('Dev maintenance tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    setInterval(() => {
      void runMaintenanceTick().catch((err: unknown) => {
        logger.error('Dev maintenance tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, INTERVAL_MS);
  }, 3_000);

  // Some dev runtimes have a `unref` to keep the timer from holding
  // the event loop open at shutdown — guarded for type-safety.
  if (typeof initialDelay.unref === 'function') initialDelay.unref();
}
