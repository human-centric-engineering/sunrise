import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAdminAuditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

function flushPromises() {
  return new Promise((r) => setTimeout(r, 0));
}

// ─── computeChanges ──────────────────────────────────────────────────────────

describe('computeChanges', () => {
  it('returns null when before and after are identical', () => {
    // Arrange
    const before = { a: 1, b: 'hello', c: true };
    const after = { a: 1, b: 'hello', c: true };

    // Act
    const result = computeChanges(before, after);

    // Assert
    expect(result).toBeNull();
  });

  it('detects an added field (before missing key, after has it)', () => {
    // Arrange
    const before = {};
    const after = { x: 1 };

    // Act
    const result = computeChanges(before, after);

    // Assert
    expect(result).toEqual({ x: { from: undefined, to: 1 } });
  });

  it('detects a removed field (before has key, after missing it)', () => {
    // Arrange
    const before = { x: 1 };
    const after = {};

    // Act
    const result = computeChanges(before, after);

    // Assert
    expect(result).toEqual({ x: { from: 1, to: undefined } });
  });

  it('returns only the changed key when one of two fields changes', () => {
    // Arrange
    const before = { a: 1, b: 2 };
    const after = { a: 1, b: 3 };

    // Act
    const result = computeChanges(before, after);

    // Assert — only `b` changed; `a` must be absent from the result
    expect(result).toEqual({ b: { from: 2, to: 3 } });
    expect(result).not.toHaveProperty('a');
  });

  it('returns null when arrays with same elements in same order are compared', () => {
    // Arrange — JSON.stringify([1,2]) === JSON.stringify([1,2]), so no change detected
    const before = { arr: [1, 2] };
    const after = { arr: [1, 2] };

    // Act
    const result = computeChanges(before, after);

    // Assert
    expect(result).toBeNull();
  });
});

// ─── logAdminAction ───────────────────────────────────────────────────────────

describe('logAdminAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes all provided fields to prisma on the happy path', async () => {
    // Arrange
    vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);

    // Act
    logAdminAction({
      userId: 'u1',
      action: 'agent.create',
      entityType: 'agent',
      entityId: 'a1',
      entityName: 'My Agent',
      changes: { name: { from: 'old', to: 'new' } },
      metadata: { source: 'web' },
      clientIp: '1.2.3.4',
    });
    await flushPromises();

    // Assert — prisma was called once with the right data; logger.error was not called
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledOnce();
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          action: 'agent.create',
          entityType: 'agent',
          entityId: 'a1',
          entityName: 'My Agent',
          clientIp: '1.2.3.4',
        }),
      })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('defaults optional fields to null when omitted', async () => {
    // Arrange
    vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);

    // Act — only required fields provided
    logAdminAction({ userId: 'u2', action: 'settings.update', entityType: 'settings' });
    await flushPromises();

    // Assert — each optional field coerced to null at the DB boundary
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u2',
          action: 'settings.update',
          entityType: 'settings',
          entityId: null,
          entityName: null,
          changes: null,
          metadata: null,
          clientIp: null,
        }),
      })
    );
  });

  it('redacts changes fields matching the secret pattern and passes non-matching fields through', async () => {
    // Arrange
    vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);

    // Act — include three secret-matching keys and one safe key; also a case-insensitive key
    logAdminAction({
      userId: 'u3',
      action: 'agent.update',
      entityType: 'agent',
      changes: {
        password: { from: 'hunter2', to: 'betterpass' },
        apiKey: { from: 'old-key', to: 'new-key' },
        refreshToken: { from: 'tok-a', to: 'tok-b' },
        API_KEY: { from: 'UP_OLD', to: 'UP_NEW' }, // uppercase — exercises /i flag
        displayName: { from: 'Alice', to: 'Bob' }, // safe field, must pass through
      },
    });
    await flushPromises();

    // Assert
    const call = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0];
    const storedChanges = call.data.changes as Record<string, { from: unknown; to: unknown }>;

    expect(storedChanges.password).toEqual({ from: '[REDACTED]', to: '[REDACTED]' });
    expect(storedChanges.apiKey).toEqual({ from: '[REDACTED]', to: '[REDACTED]' });
    expect(storedChanges.refreshToken).toEqual({ from: '[REDACTED]', to: '[REDACTED]' });
    expect(storedChanges.API_KEY).toEqual({ from: '[REDACTED]', to: '[REDACTED]' });
    expect(storedChanges.displayName).toEqual({ from: 'Alice', to: 'Bob' });
  });

  it('stores null in the changes column when changes is null', async () => {
    // Arrange
    vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);

    // Act
    logAdminAction({
      userId: 'u4',
      action: 'workflow.delete',
      entityType: 'workflow',
      changes: null,
    });
    await flushPromises();

    // Assert
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ changes: null }),
      })
    );
  });

  it('swallows DB errors and logs them — does not throw to the caller', async () => {
    // Arrange
    vi.mocked(prisma.aiAdminAuditLog.create).mockRejectedValue(new Error('DB down'));

    // Act — must not throw synchronously
    expect(() =>
      logAdminAction({ userId: 'u5', action: 'agent.create', entityType: 'agent', entityId: 'a5' })
    ).not.toThrow();
    await flushPromises();

    // Assert — error was logged with the literal first-arg string and context fields
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to write admin audit log',
      expect.objectContaining({
        error: 'DB down',
        action: 'agent.create',
        entityType: 'agent',
        entityId: 'a5',
      })
    );
  });

  it('returns undefined synchronously — confirms the void fire-and-forget signature', () => {
    // Arrange
    vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);

    // Act + Assert — callers must not attempt to await the return value
    const result = logAdminAction({
      userId: 'u6',
      action: 'workflow.update',
      entityType: 'workflow',
    });
    expect(result).toBeUndefined();
  });

  it('passes metadata as-is without mutation or serialisation', async () => {
    // Arrange
    vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);
    const complexMetadata = { nested: { a: [1, 2, null] }, x: null };

    // Act
    logAdminAction({
      userId: 'u7',
      action: 'settings.update',
      entityType: 'settings',
      metadata: complexMetadata,
    });
    await flushPromises();

    // Assert — the exact metadata object is forwarded to prisma unchanged
    const call = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0];
    expect(call.data.metadata).toEqual(complexMetadata);
  });
});
