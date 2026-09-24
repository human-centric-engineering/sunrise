/**
 * Tests: the MCP runtime singletons (§39 t-718)
 *
 * One holder is left. `sessionManager` and the module-scope guard that refused
 * `MCP_SESSION_MODE=stateful` on a function-per-request platform went with the
 * stateful transport, and so did this file's `@/lib/env` mock — nothing here
 * reads an environment variable any more.
 *
 * @see lib/orchestration/mcp/singletons.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getMcpRateLimiter, resetMcpSingletons } from '@/lib/orchestration/mcp/singletons';
import { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';

beforeEach(() => {
  resetMcpSingletons();
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
    expect(getMcpRateLimiter()).not.toBe(before);
  });

  it('is safe to reset when nothing has been initialised yet', () => {
    expect(() => resetMcpSingletons()).not.toThrow();
  });
});

describe('singletons: importing the module has no side effects', () => {
  /**
   * The module used to THROW at import on a misconfigured deploy, which failed
   * the whole app — `resource-update-hooks.ts` pulled this barrel into seven
   * non-MCP admin routes, so Next's page-data collection hit it at build. There
   * is no process-held MCP session state left for a multi-instance deploy to get
   * wrong, so there is nothing to refuse. Asserted with the serverless markers
   * set, because that is the exact configuration that used to be fatal.
   *
   * **`vi.resetModules()` is what makes this able to fail at all.** The first
   * version of this test set the two environment variables and awaited a dynamic
   * `import()` — but the same module is statically imported at the top of this
   * file, so it had already been evaluated at file load with the variables
   * UNSET, and the dynamic import returned the cached namespace without
   * re-running module scope. Measured: reinstating a module-scope
   * `if (process.env.VERCEL) throw` left all five tests in this file green.
   * Resetting the registry inside the arranged environment is what forces a
   * fresh evaluation, so the throw would now land here.
   */
  it('imports cleanly on a function-per-request platform', async () => {
    const savedVercel = process.env.VERCEL;
    const savedLambda = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.VERCEL = '1';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-fn';
    try {
      vi.resetModules();
      // Returned, not discarded: a `resolves.toBeDefined()` on a void promise
      // passes for the wrong reason.
      await expect(import('@/lib/orchestration/mcp/singletons')).resolves.toHaveProperty(
        'getMcpRateLimiter'
      );
    } finally {
      if (savedVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = savedVercel;
      if (savedLambda === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      else process.env.AWS_LAMBDA_FUNCTION_NAME = savedLambda;
      // The registry is shared with every other test in this file, and the
      // statically-imported `getMcpRateLimiter` above must keep pointing at the
      // same module instance the `beforeEach` reset acts on.
      vi.resetModules();
    }
  });
});
