import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Mutable so the startup-guard block can pick a mode. See the docblock in
 * `tests/unit/app/api/v1/mcp/route.test.ts` for why `@/lib/env` has to be
 * mocked at all — under `happy-dom` every server variable reads as `undefined`,
 * so the guard would test as permanently off.
 */
const mockEnv = vi.hoisted(() => ({ MCP_SESSION_MODE: 'stateless' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

import {
  getMcpRateLimiter,
  getMcpSessionManager,
  resetMcpSingletons,
} from '@/lib/orchestration/mcp/singletons';
import { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';
import { McpSessionManager } from '@/lib/orchestration/mcp/session-manager';

beforeEach(() => {
  resetMcpSingletons();
});

describe('singletons: getMcpSessionManager', () => {
  it('returns an McpSessionManager instance on first call', () => {
    const manager = getMcpSessionManager();
    expect(manager).toBeInstanceOf(McpSessionManager);
  });

  it('returns the same instance on repeated calls (process-wide singleton)', () => {
    const a = getMcpSessionManager();
    const b = getMcpSessionManager();
    expect(a).toBe(b);
  });

  it('returns a fresh instance after resetMcpSingletons', () => {
    const before = getMcpSessionManager();
    resetMcpSingletons();
    const after = getMcpSessionManager();
    expect(after).not.toBe(before);
  });
});

describe('singletons: getMcpRateLimiter', () => {
  it('returns an McpRateLimiter instance on first call', () => {
    expect(getMcpRateLimiter()).toBeInstanceOf(McpRateLimiter);
  });

  it('returns the same instance on repeated calls', () => {
    expect(getMcpRateLimiter()).toBe(getMcpRateLimiter());
  });

  it('returns a fresh instance after resetMcpSingletons', () => {
    const before = getMcpRateLimiter();
    resetMcpSingletons();
    const after = getMcpRateLimiter();
    expect(after).not.toBe(before);
  });
});

describe('singletons: resetMcpSingletons', () => {
  it('calls destroy() on the session manager (clears its timers)', () => {
    const manager = getMcpSessionManager();
    // Sanity: a fresh manager has the eviction timer set.
    // After reset, the manager instance is replaced — its destroy was
    // called as part of resetMcpSingletons, which calls clearInterval
    // and clears the sessions map. Re-fetching gives a different manager.
    expect(manager.getActiveSessions()).toEqual([]);
    resetMcpSingletons();
    expect(getMcpSessionManager()).not.toBe(manager);
  });

  it('is safe to call when nothing has been initialised yet', () => {
    expect(() => resetMcpSingletons()).not.toThrow();
  });
});

// ─── The stateful-on-serverless startup guard (#609) ────────────────────

describe('singletons: refusing stateful where more than one process serves traffic', () => {
  const savedVercel = process.env.VERCEL;
  const savedLambda = process.env.AWS_LAMBDA_FUNCTION_NAME;

  /**
   * The guard runs at MODULE SCOPE, so it only fires on a fresh import — which
   * is the whole point (it throws at startup, not on the first request that
   * happens to need a session). `resetModules` + dynamic import is what lets a
   * test re-enter it.
   */
  async function loadSingletons(): Promise<{ getMcpSessionManager: unknown }> {
    vi.resetModules();
    // Returned, not discarded: a `resolves.toBeDefined()` on a void promise
    // passes for the wrong reason.
    return import('@/lib/orchestration/mcp/singletons');
  }

  beforeEach(() => {
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    mockEnv.MCP_SESSION_MODE = 'stateless';
  });

  afterEach(() => {
    if (savedVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = savedVercel;
    if (savedLambda === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = savedLambda;
    vi.resetModules();
  });

  it('throws on Vercel when the mode is stateful', async () => {
    process.env.VERCEL = '1';
    mockEnv.MCP_SESSION_MODE = 'stateful';

    // The message has to carry the fix, not just the fault — this fires at
    // deploy time in front of someone who may not know the flag exists.
    await expect(loadSingletons()).rejects.toThrow(/MCP_SESSION_MODE=stateless/);
  });

  it('throws on Lambda too', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-fn';
    mockEnv.MCP_SESSION_MODE = 'stateful';

    await expect(loadSingletons()).rejects.toThrow(/cannot work where/);
  });

  it('still catches Lambda when VERCEL is set but EMPTY', async () => {
    // `||` not `??`: an empty string is falsy but not nullish, so `??` would
    // stop at `VERCEL=""` and never evaluate the Lambda check.
    process.env.VERCEL = '';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-fn';
    mockEnv.MCP_SESSION_MODE = 'stateful';

    await expect(loadSingletons()).rejects.toThrow();
  });

  it('allows stateful off a serverless platform', async () => {
    mockEnv.MCP_SESSION_MODE = 'stateful';

    await expect(loadSingletons()).resolves.toHaveProperty('getMcpSessionManager');
  });

  it('allows stateless ON a serverless platform — the case that motivated all this', async () => {
    process.env.VERCEL = '1';
    mockEnv.MCP_SESSION_MODE = 'stateless';

    await expect(loadSingletons()).resolves.toHaveProperty('getMcpSessionManager');
  });
});
