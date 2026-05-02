import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { McpSessionManager } from '@/lib/orchestration/mcp/session-manager';
import { logger } from '@/lib/logging';
import type { JsonRpcNotification } from '@/types/mcp';

const KEY_ID = 'api-key-abc';
const KEY_ID_2 = 'api-key-xyz';

describe('McpSessionManager', () => {
  let manager: McpSessionManager;

  beforeEach(() => {
    manager = new McpSessionManager(1000); // 1 second TTL for fast expiry tests
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('createSession', () => {
    it('returns a session with correct shape', () => {
      const session = manager.createSession(KEY_ID, 5);
      expect(session).not.toBeNull();
      expect(session?.id).toBeTypeOf('string');
      expect(session?.apiKeyId).toBe(KEY_ID);
      expect(session?.initialized).toBe(false);
      expect(session?.createdAt).toBeTypeOf('number');
      expect(session?.lastActivityAt).toBeTypeOf('number');
    });

    it('returns a UUID as session id', () => {
      const session = manager.createSession(KEY_ID, 5);
      expect(session?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('creates multiple sessions for different keys', () => {
      const s1 = manager.createSession(KEY_ID, 5);
      const s2 = manager.createSession(KEY_ID_2, 5);
      expect(s1).not.toBeNull();
      expect(s2).not.toBeNull();
      expect(s1?.id).not.toBe(s2?.id);
    });

    it('creates up to the max sessions per key', () => {
      const s1 = manager.createSession(KEY_ID, 2);
      const s2 = manager.createSession(KEY_ID, 2);
      expect(s1).not.toBeNull();
      expect(s2).not.toBeNull();
    });

    it('returns null when the key has reached its session limit', () => {
      manager.createSession(KEY_ID, 2);
      manager.createSession(KEY_ID, 2);
      const s3 = manager.createSession(KEY_ID, 2);
      expect(s3).toBeNull();
    });

    it('does not count sessions from other keys toward the limit', () => {
      manager.createSession(KEY_ID_2, 1);
      manager.createSession(KEY_ID_2, 1);
      const s = manager.createSession(KEY_ID, 1);
      expect(s).not.toBeNull();
    });
  });

  describe('getSession', () => {
    it('returns the session when it exists and is not expired', () => {
      const created = manager.createSession(KEY_ID, 5);
      const fetched = manager.getSession(created!.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created?.id);
    });

    it('returns null for an unknown session id', () => {
      expect(manager.getSession('does-not-exist')).toBeNull();
    });

    it('returns null and evicts an expired session', async () => {
      const shortTtl = new McpSessionManager(50); // 50ms TTL
      const session = shortTtl.createSession(KEY_ID, 5);
      await new Promise((r) => setTimeout(r, 100));
      const result = shortTtl.getSession(session!.id);
      expect(result).toBeNull();
      shortTtl.destroy();
    });

    it('updates lastActivityAt on each access', () => {
      const session = manager.createSession(KEY_ID, 5);
      const firstActivity = session!.lastActivityAt;
      const fetched = manager.getSession(session!.id);
      expect(fetched!.lastActivityAt).toBeGreaterThanOrEqual(firstActivity);
    });
  });

  describe('markInitialized', () => {
    it('sets initialized to true', () => {
      const session = manager.createSession(KEY_ID, 5);
      expect(session?.initialized).toBe(false);
      manager.markInitialized(session!.id);
      const fetched = manager.getSession(session!.id);
      // test-review:accept tobe_true — boolean state field `initialized`; verifying markInitialized() mutated session state
      expect(fetched?.initialized).toBe(true);
    });

    it('is a no-op for an unknown session id', () => {
      expect(() => manager.markInitialized('nonexistent')).not.toThrow();
    });

    it('updates lastActivityAt when marking initialized', () => {
      const session = manager.createSession(KEY_ID, 5);
      const before = session!.lastActivityAt;
      manager.markInitialized(session!.id);
      const raw = manager.getSession(session!.id);
      expect(raw!.lastActivityAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('destroySession', () => {
    it('returns true when the session is removed', () => {
      const session = manager.createSession(KEY_ID, 5);
      expect(manager.destroySession(session!.id)).toBe(true);
    });

    it('returns false when the session does not exist', () => {
      expect(manager.destroySession('no-such-session')).toBe(false);
    });

    it('makes the session unretrievable after destruction', () => {
      const session = manager.createSession(KEY_ID, 5);
      manager.destroySession(session!.id);
      expect(manager.getSession(session!.id)).toBeNull();
    });

    it('allows creating a new session after destroying the old one', () => {
      const s1 = manager.createSession(KEY_ID, 1);
      manager.destroySession(s1!.id);
      const s2 = manager.createSession(KEY_ID, 1);
      expect(s2).not.toBeNull();
    });
  });

  describe('getActiveSessions', () => {
    it('returns an empty array when there are no sessions', () => {
      expect(manager.getActiveSessions()).toEqual([]);
    });

    it('returns all active sessions', () => {
      manager.createSession(KEY_ID, 5);
      manager.createSession(KEY_ID, 5);
      manager.createSession(KEY_ID_2, 5);
      expect(manager.getActiveSessions()).toHaveLength(3);
    });

    it('excludes expired sessions', async () => {
      const shortTtl = new McpSessionManager(50);
      shortTtl.createSession(KEY_ID, 5);
      await new Promise((r) => setTimeout(r, 100));
      expect(shortTtl.getActiveSessions()).toHaveLength(0);
      shortTtl.destroy();
    });

    it('does not include destroyed sessions', () => {
      const s = manager.createSession(KEY_ID, 5);
      manager.destroySession(s!.id);
      expect(manager.getActiveSessions()).toHaveLength(0);
    });
  });

  describe('getActiveSessionCount', () => {
    it('returns 0 when no sessions exist for a key', () => {
      expect(manager.getActiveSessionCount(KEY_ID)).toBe(0);
    });

    it('counts only sessions belonging to the given key', () => {
      manager.createSession(KEY_ID, 5);
      manager.createSession(KEY_ID, 5);
      manager.createSession(KEY_ID_2, 5);
      expect(manager.getActiveSessionCount(KEY_ID)).toBe(2);
      expect(manager.getActiveSessionCount(KEY_ID_2)).toBe(1);
    });
  });

  describe('destroy', () => {
    it('clears all sessions', () => {
      manager.createSession(KEY_ID, 5);
      manager.createSession(KEY_ID_2, 5);
      manager.destroy();
      expect(manager.getActiveSessions()).toHaveLength(0);
    });

    it('can be called multiple times without throwing', () => {
      manager.destroy();
      expect(() => manager.destroy()).not.toThrow();
    });
  });

  describe('registerSseListener / unregisterSseListener', () => {
    it('stores a sink that can be looked up via broadcastNotification', () => {
      const session = manager.createSession(KEY_ID, 5);
      const sink = vi.fn();
      manager.registerSseListener(session!.id, sink);

      const notification: JsonRpcNotification = { jsonrpc: '2.0', method: 'test/notification' };
      manager.broadcastNotification(notification);

      expect(sink).toHaveBeenCalledWith(notification);
    });

    it('does not call the sink after unregistering', () => {
      const session = manager.createSession(KEY_ID, 5);
      const sink = vi.fn();
      manager.registerSseListener(session!.id, sink);
      manager.unregisterSseListener(session!.id);

      manager.broadcastNotification({ jsonrpc: '2.0', method: 'test/notification' });

      expect(sink).not.toHaveBeenCalled();
    });

    it('supports listeners on multiple sessions simultaneously', () => {
      const s1 = manager.createSession(KEY_ID, 5);
      const s2 = manager.createSession(KEY_ID_2, 5);
      const sink1 = vi.fn();
      const sink2 = vi.fn();
      manager.registerSseListener(s1!.id, sink1);
      manager.registerSseListener(s2!.id, sink2);

      const notification: JsonRpcNotification = { jsonrpc: '2.0', method: 'multi/test' };
      manager.broadcastNotification(notification);

      expect(sink1).toHaveBeenCalledWith(notification);
      expect(sink2).toHaveBeenCalledWith(notification);
    });

    it('unregisterSseListener is a no-op for an unknown session id', () => {
      expect(() => manager.unregisterSseListener('no-such-session')).not.toThrow();
    });
  });

  describe('broadcastNotification', () => {
    it('does nothing when no listeners are registered', () => {
      expect(() =>
        manager.broadcastNotification({ jsonrpc: '2.0', method: 'no/listeners' })
      ).not.toThrow();
    });

    it('continues broadcasting to other sinks when one sink throws', () => {
      const s1 = manager.createSession(KEY_ID, 5);
      const s2 = manager.createSession(KEY_ID_2, 5);

      const throwingSink = vi.fn(() => {
        throw new Error('SSE write failure');
      });
      const goodSink = vi.fn();

      manager.registerSseListener(s1!.id, throwingSink);
      manager.registerSseListener(s2!.id, goodSink);

      const notification: JsonRpcNotification = { jsonrpc: '2.0', method: 'test/resilience' };
      expect(() => manager.broadcastNotification(notification)).not.toThrow();

      expect(throwingSink).toHaveBeenCalled();
      expect(goodSink).toHaveBeenCalledWith(notification);
    });

    it('logs a warning when a sink throws', () => {
      vi.clearAllMocks();
      const session = manager.createSession(KEY_ID, 5);
      manager.registerSseListener(session!.id, () => {
        throw new Error('write error');
      });

      manager.broadcastNotification({ jsonrpc: '2.0', method: 'test/warn' });

      expect(logger.warn).toHaveBeenCalledWith(
        'MCP SSE: failed to send notification',
        expect.objectContaining({ method: 'test/warn' })
      );
    });

    it('passes params to the sink when present', () => {
      const session = manager.createSession(KEY_ID, 5);
      const sink = vi.fn();
      manager.registerSseListener(session!.id, sink);

      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'tools/list_changed',
        params: { reason: 'tool_added' },
      };
      manager.broadcastNotification(notification);

      expect(sink).toHaveBeenCalledWith(notification);
    });
  });

  describe('destroy clears listeners', () => {
    it('removes all SSE listeners when destroy is called', () => {
      const session = manager.createSession(KEY_ID, 5);
      const sink = vi.fn();
      manager.registerSseListener(session!.id, sink);

      manager.destroy();

      // After destroy, a new manager would be needed — but we verify by
      // calling broadcastNotification: listeners map was cleared, so sink
      // must not be called.
      // Re-create the manager is not needed: we use a fresh manager in
      // beforeEach. Here we just verify the sink is not invoked.
      manager.broadcastNotification({ jsonrpc: '2.0', method: 'post/destroy' });

      expect(sink).not.toHaveBeenCalled();
    });
  });

  describe('evictExpired (interval callback)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it('removes all expired sessions when the eviction interval fires', () => {
      // Arrange: use fake timers so we can control the 5-minute eviction interval.
      // McpSessionManager(1000) means sessions expire after 1 second.
      vi.useFakeTimers();
      const evictMgr = new McpSessionManager(1000); // 1 second TTL

      evictMgr.createSession(KEY_ID, 5);
      evictMgr.createSession(KEY_ID_2, 5);

      // Advance time so sessions expire (past TTL) then trigger the 5-minute
      // eviction interval (EVICTION_INTERVAL_MS = 5 * 60 * 1000 = 300000ms)
      vi.advanceTimersByTime(301000); // past TTL AND past eviction interval

      // Assert: sessions evicted — getActiveSessions() returns empty
      expect(evictMgr.getActiveSessions()).toHaveLength(0);

      // logger.info should have been called with eviction message
      expect(logger.info).toHaveBeenCalledWith(
        'MCP session: evicted expired sessions',
        expect.objectContaining({ evicted: 2 })
      );

      evictMgr.destroy();
    });

    it('only evicts expired sessions and keeps active ones', () => {
      // Arrange: call evictExpired() directly to avoid advancing fake timers
      // past s2's TTL. This tests the mixed-session eviction logic without
      // timing coordination issues from the interval.
      vi.useFakeTimers();
      const evictMgr = new McpSessionManager(1000); // 1s TTL

      const s1 = evictMgr.createSession(KEY_ID, 5);

      // Advance 500ms — s1 still within TTL
      vi.advanceTimersByTime(500);

      // Create s2 at t=500ms — lastActivityAt = 500ms
      const s2 = evictMgr.createSession(KEY_ID_2, 5);

      // Advance 600ms more — total 1100ms for s1 (expired: 1100 > 1000),
      // 600ms for s2 (active: 600 < 1000)
      vi.advanceTimersByTime(600);

      // Act: call evictExpired() directly (bypasses interval timing)
      (evictMgr as unknown as { evictExpired: () => void }).evictExpired();

      // Assert: only s1 was evicted
      expect(evictMgr.getSession(s1!.id)).toBeNull();
      // s2 is still retrievable (touches lastActivityAt, resetting its TTL)
      expect(evictMgr.getSession(s2!.id)).not.toBeNull();

      // getActiveSessions reflects one remaining active session
      expect(evictMgr.getActiveSessions()).toHaveLength(1);
      expect(evictMgr.getActiveSessions()[0].apiKeyId).toBe(KEY_ID_2);

      evictMgr.destroy();
    });

    it('does not log when no sessions are evicted', () => {
      // Arrange: no expired sessions — exercises the if(evicted > 0) false arm
      vi.useFakeTimers();
      vi.clearAllMocks();
      const evictMgr = new McpSessionManager(DEFAULT_TTL_SENTINEL); // long TTL

      evictMgr.createSession(KEY_ID, 5);

      // Trigger eviction interval — nothing should be evicted
      vi.advanceTimersByTime(300001);

      // Assert: logger.info NOT called for eviction (no sessions expired)
      const evictionCalls = vi
        .mocked(logger.info)
        .mock.calls.filter((c) => String(c[0]).includes('evicted'));
      expect(evictionCalls).toHaveLength(0);

      evictMgr.destroy();
    });

    it('calls evictExpired directly via private method — all expired, logs info', () => {
      // Arrange: use real timers; call evictExpired via (mgr as any) to test the method directly
      const directMgr = new McpSessionManager(1); // near-zero TTL
      vi.clearAllMocks();

      directMgr.createSession(KEY_ID, 5);

      // Wait a tick for TTL to pass (real time — just 1ms TTL)
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // Act: call evictExpired directly
          (directMgr as unknown as { evictExpired: () => void }).evictExpired();

          // Assert
          expect(logger.info).toHaveBeenCalledWith(
            'MCP session: evicted expired sessions',
            expect.objectContaining({ evicted: expect.any(Number) })
          );

          directMgr.destroy();
          resolve();
        }, 10); // 10ms > 1ms TTL — session is expired
      });
    });
  });
});

// Sentinel value: a long TTL that won't expire during the test
// (used to test the no-eviction path without timing fragility)
const DEFAULT_TTL_SENTINEL = 60 * 60 * 1000; // 1 hour
