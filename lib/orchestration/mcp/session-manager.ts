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
import {
  MCP_LATEST_PROTOCOL_VERSION,
  type McpLogLevel,
  type McpProtocolVersion,
  type McpSession,
  type JsonRpcNotification,
} from '@/types/mcp';

/** Callback registered by an SSE stream to receive server-to-client notifications */
export type NotificationSink = (notification: JsonRpcNotification) => void;

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Max URIs a single session may subscribe to. */
export const MAX_SUBSCRIPTIONS_PER_SESSION = 50;

export class McpSessionManager {
  private sessions = new Map<string, McpSession>();
  private sseListeners = new Map<string, NotificationSink>();
  /**
   * Per-session set of resource URIs the client wants update notifications for.
   * Cleared with the session on destroy / expiry, so a forgotten unsubscribe
   * never leaks beyond the session lifetime (1 h TTL).
   */
  private subscriptions = new Map<string, Set<string>>();
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
   *
   * The session starts at the server's latest supported protocol version.
   * `initialize` replaces this with the negotiated version once the client
   * declares which spec revision it speaks.
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
      protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
      // Default to 'warning' so clients that never call logging/setLevel
      // don't get flooded with info/debug noise.
      logLevel: 'warning',
      createdAt: now,
      lastActivityAt: now,
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Record the protocol version negotiated during `initialize`. Called from
   * the protocol handler once it has run `negotiateMcpProtocolVersion`.
   */
  setProtocolVersion(sessionId: string, version: McpProtocolVersion): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.protocolVersion = version;
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Update the minimum log level the client wants pushed via
   * `notifications/message`. Called from `logging/setLevel`.
   */
  setLogLevel(sessionId: string, level: McpLogLevel): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.logLevel = level;
      session.lastActivityAt = Date.now();
    }
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
    this.subscriptions.delete(sessionId);
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
        this.subscriptions.delete(id);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.info('MCP session: evicted expired sessions', { evicted });
    }
  }

  // ---------------------------------------------------------------------------
  // Resource subscriptions (MCP 2025-06-18)
  // ---------------------------------------------------------------------------

  /**
   * Subscribe a session to update notifications for a concrete resource URI.
   *
   * Returns:
   *  - `'ok'` for fresh or duplicate subscribes (idempotent per spec).
   *  - `'session-not-found'` if the session is unknown or expired.
   *  - `'limit-exceeded'` if the session is already at MAX_SUBSCRIPTIONS_PER_SESSION.
   */
  subscribe(sessionId: string, uri: string): 'ok' | 'session-not-found' | 'limit-exceeded' {
    if (!this.getSession(sessionId)) return 'session-not-found';
    let set = this.subscriptions.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscriptions.set(sessionId, set);
    }
    if (set.has(uri)) return 'ok';
    if (set.size >= MAX_SUBSCRIPTIONS_PER_SESSION) return 'limit-exceeded';
    set.add(uri);
    return 'ok';
  }

  /** Unsubscribe is always a no-op success — duplicates are tolerated. */
  unsubscribe(sessionId: string, uri: string): 'ok' | 'session-not-found' {
    if (!this.getSession(sessionId)) return 'session-not-found';
    this.subscriptions.get(sessionId)?.delete(uri);
    return 'ok';
  }

  /** Returns the session IDs subscribed to a given URI (active sessions only). */
  getSubscribers(uri: string): string[] {
    const out: string[] = [];
    for (const [sessionId, set] of this.subscriptions) {
      if (set.has(uri) && this.getSession(sessionId)) out.push(sessionId);
    }
    return out;
  }

  /** Test/inspection helper — current subscription count for a session. */
  getSubscriptionCount(sessionId: string): number {
    return this.subscriptions.get(sessionId)?.size ?? 0;
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
   * Push a notification to SSE clients. Fire-and-forget — errors in
   * individual sinks are logged and swallowed.
   *
   * `targetSessionIds`:
   *  - `undefined` (default): broadcast to every connected session.
   *  - An array: deliver only to those sessions that are still connected.
   *    Used by per-session features (progress updates, targeted resource
   *    update fan-out) so notifications don't leak across sessions.
   */
  broadcastNotification(
    notification: JsonRpcNotification,
    targetSessionIds?: readonly string[]
  ): void {
    const recipients =
      targetSessionIds === undefined
        ? Array.from(this.sseListeners.keys())
        : targetSessionIds.filter((id) => this.sseListeners.has(id));
    for (const sessionId of recipients) {
      const sink = this.sseListeners.get(sessionId);
      if (!sink) continue;
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
    this.subscriptions.clear();
  }
}
