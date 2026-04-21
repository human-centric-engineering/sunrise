/**
 * MCP Session Manager
 *
 * In-memory session tracking with TTL eviction and per-key limits.
 * Sessions are lost on restart — MCP clients re-initialize on
 * session-not-found, which is acceptable for v1.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logging';
import type { McpSession, JsonRpcNotification } from '@/types/mcp';

/** Callback registered by an SSE stream to receive server-to-client notifications */
export type NotificationSink = (notification: JsonRpcNotification) => void;

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class McpSessionManager {
  private sessions = new Map<string, McpSession>();
  private sseListeners = new Map<string, NotificationSink>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {
    this.evictionTimer = setInterval(() => this.evictExpired(), EVICTION_INTERVAL_MS);
    // Allow process to exit even if this timer is still running
    if (this.evictionTimer.unref) {
      this.evictionTimer.unref();
    }
  }

  /**
   * Create a new session for the given API key.
   * Returns null if the key has reached its session limit.
   */
  createSession(apiKeyId: string, maxSessionsPerKey: number): McpSession | null {
    const activeCount = this.getActiveSessionCount(apiKeyId);
    if (activeCount >= maxSessionsPerKey) {
      logger.warn('MCP session: max sessions exceeded', {
        apiKeyId,
        activeCount,
        maxSessionsPerKey,
      });
      return null;
    }

    const now = Date.now();
    const session: McpSession = {
      id: randomUUID(),
      apiKeyId,
      initialized: false,
      createdAt: now,
      lastActivityAt: now,
    };

    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): McpSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (Date.now() - session.lastActivityAt > this.ttlMs) {
      this.sessions.delete(sessionId);
      return null;
    }

    session.lastActivityAt = Date.now();
    return session;
  }

  markInitialized(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.initialized = true;
      session.lastActivityAt = Date.now();
    }
  }

  destroySession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  getActiveSessionCount(apiKeyId: string): number {
    const now = Date.now();
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.apiKeyId === apiKeyId && now - session.lastActivityAt <= this.ttlMs) {
        count++;
      }
    }
    return count;
  }

  getActiveSessions(): McpSession[] {
    const now = Date.now();
    const active: McpSession[] = [];
    for (const session of this.sessions.values()) {
      if (now - session.lastActivityAt <= this.ttlMs) {
        active.push(session);
      }
    }
    return active;
  }

  private evictExpired(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > this.ttlMs) {
        this.sessions.delete(id);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.info('MCP session: evicted expired sessions', { evicted });
    }
  }

  /**
   * Register an SSE notification sink for a session.
   * Called when a client opens a GET /api/v1/mcp SSE stream.
   */
  registerSseListener(sessionId: string, sink: NotificationSink): void {
    this.sseListeners.set(sessionId, sink);
  }

  /**
   * Unregister an SSE notification sink (on client disconnect).
   */
  unregisterSseListener(sessionId: string): void {
    this.sseListeners.delete(sessionId);
  }

  /**
   * Broadcast a notification to all connected SSE clients.
   * Fire-and-forget — errors in individual sinks are logged and swallowed.
   */
  broadcastNotification(notification: JsonRpcNotification): void {
    for (const [sessionId, sink] of this.sseListeners) {
      try {
        sink(notification);
      } catch (err) {
        logger.warn('MCP SSE: failed to send notification', {
          sessionId,
          method: notification.method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** For testing and shutdown */
  destroy(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.sessions.clear();
    this.sseListeners.clear();
  }
}
