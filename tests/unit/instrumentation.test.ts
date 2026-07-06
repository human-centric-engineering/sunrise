/**
 * Tests: instrumentation.ts register() — the app boot seam + dev ticker.
 *
 * `register()` runs once per server process. Two responsibilities:
 *   1. Call the reserved app boot seam `initApp()` (lib/app/bootstrap.ts) in
 *      EVERY environment, above the dev-only guards, isolated in try/catch.
 *   2. In development only, arm the in-process maintenance ticker.
 *
 * These tests lock in the seam contract that #385 added: initApp runs in prod
 * too, runs before the dev-ticker guards, and a throwing initApp is logged but
 * never crashes register() or stops the dev ticker arming.
 *
 * @see instrumentation.ts · lib/app/bootstrap.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { initApp, loggerInfo, loggerError, runMaintenanceTick } = vi.hoisted(() => ({
  initApp: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  runMaintenanceTick: vi.fn(),
}));

vi.mock('@/lib/app/bootstrap', () => ({ initApp }));
vi.mock('@/lib/logging', () => ({
  logger: { info: loggerInfo, error: loggerError, warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/orchestration/maintenance/run-tick', () => ({ runMaintenanceTick }));

import { register } from '@/instrumentation';

const ARMED = 'Dev maintenance ticker armed';

// Snapshot the env keys register() reads so each test sets them in isolation.
const savedEnv = {
  NEXT_RUNTIME: process.env.NEXT_RUNTIME,
  NODE_ENV: process.env.NODE_ENV,
  SUNRISE_DISABLE_DEV_TICK: process.env.SUNRISE_DISABLE_DEV_TICK,
};

function setEnv(env: { runtime?: string; node?: string; disableTick?: string }): void {
  if (env.runtime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = env.runtime;
  // NODE_ENV is readonly in the Node types; assign through a cast.
  (process.env as Record<string, string | undefined>).NODE_ENV = env.node;
  if (env.disableTick === undefined) delete process.env.SUNRISE_DISABLE_DEV_TICK;
  else process.env.SUNRISE_DISABLE_DEV_TICK = env.disableTick;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  initApp.mockResolvedValue(undefined);
  runMaintenanceTick.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  (process.env as Record<string, string | undefined>).NEXT_RUNTIME = savedEnv.NEXT_RUNTIME;
  (process.env as Record<string, string | undefined>).NODE_ENV = savedEnv.NODE_ENV;
  (process.env as Record<string, string | undefined>).SUNRISE_DISABLE_DEV_TICK =
    savedEnv.SUNRISE_DISABLE_DEV_TICK;
});

describe('register() — app boot seam', () => {
  it('does nothing (no initApp) when NEXT_RUNTIME is not nodejs', async () => {
    setEnv({ runtime: 'edge', node: 'production' });

    await register();

    expect(initApp).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
    expect(loggerInfo).not.toHaveBeenCalledWith(ARMED, expect.anything());
  });

  it('calls initApp in production (above the dev-only guards, ticker not armed)', async () => {
    setEnv({ runtime: 'nodejs', node: 'production' });

    await register();

    expect(initApp).toHaveBeenCalledTimes(1);
    // Production returns before arming the dev ticker.
    expect(loggerInfo).not.toHaveBeenCalledWith(ARMED, expect.anything());
  });

  it('calls initApp even when the dev ticker is disabled (seam runs before that guard)', async () => {
    setEnv({ runtime: 'nodejs', node: 'development', disableTick: '1' });

    await register();

    expect(initApp).toHaveBeenCalledTimes(1);
    // Ticker guard still returns — seam ran first.
    expect(loggerInfo).not.toHaveBeenCalledWith(ARMED, expect.anything());
  });

  it('calls initApp and then arms the ticker in development', async () => {
    setEnv({ runtime: 'nodejs', node: 'development' });

    await register();

    expect(initApp).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(ARMED, expect.objectContaining({ intervalMs: 60_000 }));
  });

  it('fires the first maintenance tick ~3s after arming, then every 60s', async () => {
    setEnv({ runtime: 'nodejs', node: 'development' });

    await register();
    expect(runMaintenanceTick).not.toHaveBeenCalled(); // nothing fires synchronously

    await vi.advanceTimersByTimeAsync(3_000); // initial delay
    expect(runMaintenanceTick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000); // one interval
    expect(runMaintenanceTick).toHaveBeenCalledTimes(2);
  });

  it('logs but does not throw when a maintenance tick rejects (initial + interval paths)', async () => {
    setEnv({ runtime: 'nodejs', node: 'development' });
    runMaintenanceTick.mockRejectedValue(new Error('tick blew up'));

    await register();

    await vi.advanceTimersByTimeAsync(3_000); // initial tick rejects → caught
    await vi.advanceTimersByTimeAsync(60_000); // interval tick rejects → caught
    expect(runMaintenanceTick).toHaveBeenCalledTimes(2);
    expect(loggerError).toHaveBeenCalledWith(
      'Dev maintenance tick failed',
      expect.objectContaining({ error: expect.stringMatching(/tick blew up/) })
    );
  });

  it('logs and swallows a throwing initApp — register() resolves and the dev ticker still arms', async () => {
    setEnv({ runtime: 'nodejs', node: 'development' });
    initApp.mockRejectedValue(new Error('boom — simulated fork boot failure'));

    // Must not reject: a fork boot failure can't crash instrumentation.
    await expect(register()).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledTimes(1);
    const [message, context] = loggerError.mock.calls[0];
    expect(message).toMatch(/app boot seam \(initApp\) failed/);
    expect((context as { error: string }).error).toMatch(/simulated fork boot failure/);

    // Isolation: the ticker still arms despite the seam failure.
    expect(loggerInfo).toHaveBeenCalledWith(ARMED, expect.objectContaining({ intervalMs: 60_000 }));
  });

  it('stringifies a non-Error initApp rejection (rejects need not be Errors)', async () => {
    setEnv({ runtime: 'nodejs', node: 'production' });
    initApp.mockRejectedValue('plain string failure');

    await expect(register()).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/app boot seam/),
      expect.objectContaining({ error: 'plain string failure' })
    );
  });

  it('stringifies a non-Error maintenance-tick rejection', async () => {
    setEnv({ runtime: 'nodejs', node: 'development' });
    runMaintenanceTick.mockRejectedValue('tick string failure');

    await register();
    await vi.advanceTimersByTimeAsync(3_000); // initial tick
    await vi.advanceTimersByTimeAsync(60_000); // interval tick

    expect(loggerError).toHaveBeenCalledWith(
      'Dev maintenance tick failed',
      expect.objectContaining({ error: 'tick string failure' })
    );
  });
});
