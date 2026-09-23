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

import { describe, it, expect, beforeEach } from 'vitest';

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
   */
  it('imports cleanly on a function-per-request platform', async () => {
    const savedVercel = process.env.VERCEL;
    const savedLambda = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.VERCEL = '1';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-fn';
    try {
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
    }
  });
});
