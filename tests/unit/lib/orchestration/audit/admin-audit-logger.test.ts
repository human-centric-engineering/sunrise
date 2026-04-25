import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

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

  it('handles non-serializable values (BigInt) without throwing', () => {
    // Arrange — BigInt throws on JSON.stringify
    const before = { count: BigInt(1) } as unknown as Record<string, unknown>;
    const after = { count: BigInt(2) } as unknown as Record<string, unknown>;

    // Act — must not throw
    const result = computeChanges(before, after);

    // Assert — captured as [unserializable]
    expect(result).toEqual({ count: { from: '[unserializable]', to: '[unserializable]' } });
  });

  it('handles circular references without throwing', () => {
    // Arrange — circular ref throws on JSON.stringify
    const circular: Record<string, unknown> = { name: 'test' };
    circular.self = circular;

    const before = { config: circular };
    const after = { config: { name: 'updated' } };

    // Act — must not throw
    const result = computeChanges(before, after);

    // Assert — captured as [unserializable]
    expect(result).toEqual({ config: { from: '[unserializable]', to: '[unserializable]' } });
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

    // Assert — each optional field coerced to null/JsonNull at the DB boundary
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u2',
          action: 'settings.update',
          entityType: 'settings',
          entityId: null,
          entityName: null,
          changes: Prisma.JsonNull,
          metadata: Prisma.JsonNull,
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

  it('does not redact fields where key/token are prefixes of longer words', async () => {
    vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);

    logAdminAction({
      userId: 'u-noredact',
      action: 'agent.update',
      entityType: 'agent',
      changes: {
        apiKeyCount: { from: 3, to: 5 },
        tokenizeInput: { from: false, to: true },
        encryptionKeyRotation: { from: 'weekly', to: 'daily' },
        displayName: { from: 'Alice', to: 'Bob' },
      },
    });
    await flushPromises();

    const call = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0];
    const storedChanges = call.data.changes as Record<string, { from: unknown; to: unknown }>;

    // 'key' and 'token' as prefixes of longer words should NOT be redacted
    expect(storedChanges.apiKeyCount).toEqual({ from: 3, to: 5 });
    expect(storedChanges.tokenizeInput).toEqual({ from: false, to: true });
    expect(storedChanges.encryptionKeyRotation).toEqual({ from: 'weekly', to: 'daily' });
    expect(storedChanges.displayName).toEqual({ from: 'Alice', to: 'Bob' });
  });

  it('redacts secret-named keys nested inside changes from/to values', async () => {
    // Arrange — simulates a hook update where the `action` field contains
    // headers with secret-named keys (e.g. X-Api-Key). The top-level field
    // name `action` does NOT match SECRET_PATTERN, but the nested key should.
    vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);

    logAdminAction({
      userId: 'u-nested',
      action: 'webhook.update',
      entityType: 'webhook',
      changes: {
        action: {
          from: {
            type: 'webhook',
            url: 'https://old.example.com',
            headers: { 'X-Api-Key': 'old-secret' },
          },
          to: {
            type: 'webhook',
            url: 'https://new.example.com',
            headers: { 'X-Api-Key': 'new-secret' },
          },
        },
        name: { from: 'Old Hook', to: 'New Hook' },
      },
    });
    await flushPromises();

    const call = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0];
    const storedChanges = call.data.changes as Record<string, { from: unknown; to: unknown }>;

    // The nested X-Api-Key should be redacted in both from and to
    expect(storedChanges.action).toEqual({
      from: {
        type: 'webhook',
        url: 'https://old.example.com',
        headers: { 'X-Api-Key': '[REDACTED]' },
      },
      to: {
        type: 'webhook',
        url: 'https://new.example.com',
        headers: { 'X-Api-Key': '[REDACTED]' },
      },
    });
    // Non-secret fields pass through unchanged
    expect(storedChanges.name).toEqual({ from: 'Old Hook', to: 'New Hook' });
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

    // Assert — null changes stored as Prisma.JsonNull
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ changes: Prisma.JsonNull }),
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

  it('passes non-secret metadata through structurally unchanged', async () => {
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

    // Assert — structural equality preserved; no secret keys to redact
    const call = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0];
    expect(call.data.metadata).toEqual(complexMetadata);
  });

  it('redacts secret-matching keys in metadata at any nesting depth', async () => {
    // Arrange
    vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);

    // Act — secrets at top level, nested in a safe container, and a whole
    // secret-named subtree that must be redacted wholesale
    logAdminAction({
      userId: 'u8',
      action: 'webhook.create',
      entityType: 'webhook',
      metadata: {
        password: 'hunter2',
        safe: 'keep-me',
        headers: { authorization: 'Bearer x', 'x-trace': 'abc', apiKey: 'leak' },
        credentials: [{ apiKey: 'k1' }, { apiKey: 'k2' }],
      },
    });
    await flushPromises();

    // Assert — secret-named keys are redacted wholesale (matching sanitizeChanges
    // behaviour); non-secret containers are walked and inner secrets redacted
    const call = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0];
    expect(call.data.metadata).toEqual({
      password: '[REDACTED]',
      safe: 'keep-me',
      headers: { authorization: 'Bearer x', 'x-trace': 'abc', apiKey: '[REDACTED]' },
      credentials: '[REDACTED]',
    });
  });
});
