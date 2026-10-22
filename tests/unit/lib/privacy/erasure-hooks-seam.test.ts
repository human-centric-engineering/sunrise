/**
 * Erasure cleanup hooks: where a fork registers them, and whether erasure
 * sees them (#691)
 *
 * The registry was a plain module-scoped `Map` with no `lib/app/` seam. The
 * docs told forks to register "at startup", which means `initApp()` — and
 * `instrumentation.ts` loads in a separate module graph from the route handlers
 * that call `eraseUser()`. So the hook landed in one `Map` and erasure read
 * another: account deletion left the fork's data behind with nothing logged.
 *
 * `vi.resetModules()` + a fresh import stands in for the second graph: it gives
 * a new instance of the module, which is exactly what made the plain `Map` miss.
 *
 * @see lib/privacy/erasure-hooks.ts
 * @see lib/app/erasure.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: (): void => {} }));

vi.mock('@/lib/app/erasure', () => ({
  initAppErasureHooks: () => seam.init(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

type Registry = typeof import('@/lib/privacy/erasure-hooks');

async function freshRegistry(): Promise<Registry> {
  vi.resetModules();
  return import('@/lib/privacy/erasure-hooks');
}

beforeEach(async () => {
  seam.init = () => {};
  (await import('@/lib/privacy/erasure-hooks')).__resetErasureCleanupHooksForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('a hook registered in another module graph', () => {
  it('is returned by the instance erasure reads', async () => {
    // The boot graph: `initApp()` registers, as the docs said to.
    const boot = await freshRegistry();
    const hook = { name: 'fork-blobs', cleanupExternal: vi.fn() };
    boot.registerErasureCleanupHook(hook);

    // The route-handler graph: a separate instance of the same module.
    const request = await freshRegistry();
    expect(request).not.toBe(boot);
    expect(request.getErasureCleanupHooks()).toEqual([hook]);
  });
});

describe('the lib/app/erasure.ts seam', () => {
  it('runs once, before the first read, and its hooks are returned', async () => {
    const registry = await freshRegistry();
    const init = vi.fn(() => registry.registerErasureCleanupHook({ name: 'fork-scrub' }));
    seam.init = init;

    expect(registry.getErasureCleanupHooks().map((h) => h.name)).toEqual(['fork-scrub']);
    registry.getErasureCleanupHooks();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('rolls a throwing init back, keeps what was there, and says so', async () => {
    const registry = await freshRegistry();
    registry.registerErasureCleanupHook({ name: 'core-or-earlier' });
    seam.init = () => {
      registry.registerErasureCleanupHook({ name: 'half-registered' });
      throw new Error('fork init bug');
    };

    expect(registry.getErasureCleanupHooks().map((h) => h.name)).toEqual(['core-or-earlier']);

    const { logger } = await import('@/lib/logging');
    const messages = vi.mocked(logger.error).mock.calls.map((call) => String(call[0]));
    expect(messages).toContain(
      'erasure-hooks: initAppErasureHooks threw — app erasure hooks rolled back and disabled'
    );
  });
});

describe('stale writers declared from the same seam (§122)', () => {
  const writer = {
    file: 'lib/app/orders/notify.ts',
    model: 'AiWebhookSubscription',
    anchor: 'version',
    how: 'Saves with If-Match, refused when the subscription moved since it was read.',
  } as const;

  it('are returned once the init has run, one per file and model', async () => {
    const registry = await freshRegistry();
    seam.init = () => {
      registry.registerStaleWriter(writer);
      registry.registerStaleWriter({ ...writer, how: 'Re-registered under HMR: replaces.' });
    };

    expect(registry.getAppStaleWriters()).toEqual([
      { ...writer, how: 'Re-registered under HMR: replaces.' },
    ]);
  });

  it('are rolled back with the hooks when the init throws part-way', async () => {
    const registry = await freshRegistry();
    seam.init = () => {
      registry.registerStaleWriter(writer);
      registry.registerErasureCleanupHook({ name: 'half-registered' });
      throw new Error('fork init bug');
    };

    // Read the writers first: whichever read runs the init, both roll back.
    expect(registry.getAppStaleWriters()).toEqual([]);
    expect(registry.getErasureCleanupHooks()).toEqual([]);
  });
});
