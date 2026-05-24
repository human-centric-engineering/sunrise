import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpSession } from '@/types/mcp';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const broadcastSpy = vi.fn();
const getActiveSessionsSpy = vi.fn();

vi.mock('@/lib/orchestration/mcp/singletons', () => ({
  getMcpSessionManager: vi.fn(() => ({
    broadcastNotification: broadcastSpy,
    getActiveSessions: getActiveSessionsSpy,
  })),
}));

import { emitMcpLog, _resetLogEmitter } from '@/lib/orchestration/mcp/log-emitter';

function makeSession(id: string, logLevel: McpSession['logLevel']): McpSession {
  return {
    id,
    apiKeyId: 'k',
    initialized: true,
    protocolVersion: '2025-06-18',
    logLevel,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetLogEmitter();
});

describe('emitMcpLog: level filter', () => {
  it('delivers when message level == session level', () => {
    getActiveSessionsSpy.mockReturnValue([makeSession('s-1', 'info')]);
    emitMcpLog(null, 'info', 'core', { msg: 'hello' });
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it('delivers when message level > session level (more severe)', () => {
    getActiveSessionsSpy.mockReturnValue([makeSession('s-1', 'info')]);
    emitMcpLog(null, 'error', 'core', { msg: 'boom' });
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it('drops when message level < session level (less severe)', () => {
    getActiveSessionsSpy.mockReturnValue([makeSession('s-1', 'warning')]);
    emitMcpLog(null, 'debug', 'core', { msg: 'noise' });
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('honours session-specific filter when sessionId is supplied', () => {
    getActiveSessionsSpy.mockReturnValue([
      makeSession('s-1', 'debug'),
      makeSession('s-2', 'error'),
    ]);
    emitMcpLog('s-2', 'info', 'core', { msg: 'x' });
    // s-2 is at error level; info is below threshold → no delivery.
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('broadcasts only to sessions that pass the filter', () => {
    getActiveSessionsSpy.mockReturnValue([
      makeSession('s-debug', 'debug'),
      makeSession('s-warn', 'warning'),
      makeSession('s-error', 'error'),
    ]);
    emitMcpLog(null, 'warning', 'core', { msg: 'x' });

    // Only s-debug and s-warn should receive (s-error wants ≥ error).
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [, targets] = broadcastSpy.mock.calls[0];
    expect((targets as string[]).sort()).toEqual(['s-debug', 's-warn']);
  });
});

describe('emitMcpLog: payload shaping', () => {
  beforeEach(() => {
    getActiveSessionsSpy.mockReturnValue([makeSession('s-1', 'debug')]);
  });

  it('emits with level, data, and logger name', () => {
    emitMcpLog(null, 'notice', 'my-logger', { foo: 'bar' });
    const [notification] = broadcastSpy.mock.calls[0];
    expect(notification.method).toBe('notifications/message');
    expect(notification.params).toEqual({
      level: 'notice',
      logger: 'my-logger',
      data: { foo: 'bar' },
    });
  });

  it('omits logger field when not provided', () => {
    emitMcpLog(null, 'info', undefined, { x: 1 });
    const [notification] = broadcastSpy.mock.calls[0];
    expect(notification.params).not.toHaveProperty('logger');
  });

  it('truncates logger name to 64 chars', () => {
    const longName = 'x'.repeat(100);
    emitMcpLog(null, 'info', longName, { x: 1 });
    const [notification] = broadcastSpy.mock.calls[0];
    expect((notification.params as { logger: string }).logger).toHaveLength(64);
  });

  it('replaces data exceeding 4 KB with a truncated sentinel', () => {
    const big = { payload: 'x'.repeat(5 * 1024) };
    emitMcpLog(null, 'info', 'core', big);
    const [notification] = broadcastSpy.mock.calls[0];
    expect((notification.params as { data: unknown }).data).toEqual({
      truncated: true,
      reason: 'data exceeded 4 KB limit',
    });
  });

  it('handles non-JSON-serialisable data without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => emitMcpLog(null, 'info', 'core', circular)).not.toThrow();
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });
});

describe('emitMcpLog: rate limit', () => {
  it('drops messages above 100/sec per session', () => {
    getActiveSessionsSpy.mockReturnValue([makeSession('s-1', 'debug')]);
    for (let i = 0; i < 150; i++) emitMcpLog('s-1', 'debug', 'core', { i });
    expect(broadcastSpy).toHaveBeenCalledTimes(100);
  });

  it('rate limit is per-session', () => {
    getActiveSessionsSpy.mockReturnValue([
      makeSession('s-a', 'debug'),
      makeSession('s-b', 'debug'),
    ]);
    for (let i = 0; i < 100; i++) emitMcpLog('s-a', 'debug', 'core', { i });
    emitMcpLog('s-b', 'debug', 'core', { x: 1 });
    expect(broadcastSpy).toHaveBeenCalledTimes(101);
  });
});
