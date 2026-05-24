/**
 * MCP log emitter
 *
 * Pushes `notifications/message { level, logger?, data }` to connected
 * SSE clients per MCP 2025-06-18 logging spec.
 *
 * - Per-session level filter: only emit when the message's level rank is
 *   ≥ the session's configured minimum (`McpSession.logLevel`).
 * - Per-session sliding-window rate limit (100/sec) — excess silently
 *   dropped so a runaway emitter can't blow up the SSE buffer.
 * - `data` truncated to 4 KB serialised JSON.
 * - `logger` field truncated to 64 chars.
 *
 * Use sparingly: this is for events the client genuinely cares about
 * (cost-cap hits, resource handler fallbacks). Internal server logging
 * goes to `lib/logging`, not here.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';
import { getMcpSessionManager } from '@/lib/orchestration/mcp/singletons';
import { McpLogLevelRank, type McpLogLevel } from '@/types/mcp';

const MAX_DATA_BYTES = 4 * 1024;
const MAX_LOGGER_NAME_LENGTH = 64;
const MAX_NOTIFICATIONS_PER_SEC = 100;
const WINDOW_MS = 1000;

const sentTimestamps = new Map<string, number[]>();

/**
 * Emit a log message to a specific session (or to all sessions when
 * `sessionId === null`). The session's level filter is honoured — a
 * session at level `error` ignores `info` messages.
 *
 * `logger` is an optional short identifier (truncated to 64 chars).
 * `data` is arbitrary JSON-serialisable payload — truncated to 4 KB
 * (overlong payloads are replaced with a sentinel `{ truncated: true }`
 * so the client still sees a notification).
 */
export function emitMcpLog(
  sessionId: string | null,
  level: McpLogLevel,
  loggerName: string | undefined,
  data: unknown
): void {
  const manager = getMcpSessionManager();
  const requiredRank = McpLogLevelRank[level];

  // Resolve recipients with their session-level filter applied.
  const targets: string[] = [];
  for (const session of manager.getActiveSessions()) {
    if (sessionId !== null && session.id !== sessionId) continue;
    if (McpLogLevelRank[session.logLevel] <= requiredRank) {
      if (allowAnotherNotification(session.id)) {
        targets.push(session.id);
      }
    }
  }

  if (targets.length === 0) return;

  const params: Record<string, unknown> = {
    level,
    data: clampData(data),
  };
  if (loggerName) {
    params.logger = loggerName.slice(0, MAX_LOGGER_NAME_LENGTH);
  }

  manager.broadcastNotification(
    {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params,
    },
    targets
  );
}

function clampData(data: unknown): unknown {
  try {
    const serialised = JSON.stringify(data);
    if (serialised !== undefined && Buffer.byteLength(serialised, 'utf8') > MAX_DATA_BYTES) {
      return { truncated: true, reason: 'data exceeded 4 KB limit' };
    }
    return data;
  } catch (err) {
    logger.warn('MCP log emitter: failed to serialise data', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { truncated: true, reason: 'data not JSON-serialisable' };
  }
}

function allowAnotherNotification(sessionId: string): boolean {
  const now = Date.now();
  let stamps = sentTimestamps.get(sessionId);
  if (!stamps) {
    stamps = [];
    sentTimestamps.set(sessionId, stamps);
  }
  const cutoff = now - WINDOW_MS;
  while (stamps.length > 0 && stamps[0] < cutoff) {
    stamps.shift();
  }
  if (stamps.length >= MAX_NOTIFICATIONS_PER_SEC) return false;
  stamps.push(now);
  return true;
}

/** Test helper — clears the per-session rate-window state. */
export function _resetLogEmitter(): void {
  sentTimestamps.clear();
}
