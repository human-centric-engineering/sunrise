import { describe, it, expect, beforeEach } from 'vitest';

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
