/**
 * Tests for the generic event log (Seam 9 — fork-readiness).
 *
 * `logEvent` delegates to `logAdminAction`, reusing its fire-and-forget DB
 * write and secret-redaction pipeline. The tests here prove:
 *  1. Correct field mapping (no `changes` column — only `metadata`).
 *  2. Secret-named keys in `metadata` are redacted BEFORE the DB write
 *     (proves delegation to `logAdminAction`'s sanitization, not a parallel
 *     reimplementation).
 *  3. Fire-and-forget contract: synchronous `undefined` return, no throw on
 *     DB error.
 *
 * Mocking style: mirrors admin-audit-logger.test.ts — mock the Prisma client
 * and logger at the module boundary, then assert against the actual call args
 * passed to `prisma.aiAdminAuditLog.create`.
 *
 * Source: lib/events/event-log.ts
 */

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
import { logEvent } from '@/lib/events/event-log';

/** Flush the microtask queue so fire-and-forget DB writes complete. */
function flushPromises() {
  return new Promise((r) => setTimeout(r, 0));
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Happy-path default: the DB write succeeds.
  vi.mocked(prisma.aiAdminAuditLog.create).mockResolvedValue({} as never);
});

describe('logEvent', () => {
  it('writes the provided fields to prisma.aiAdminAuditLog.create', async () => {
    // Arrange
    const entry = {
      action: 'questionnaire.submitted',
      entityType: 'questionnaire',
      entityId: 'q-42',
      entityName: 'Onboarding survey',
      userId: 'user-1',
      clientIp: '10.0.0.1',
      metadata: { score: 95 },
    };

    // Act
    logEvent(entry);
    await flushPromises();

    // Assert — the row written to the DB contains the correct field values.
    // We assert against what prisma received (not what the mock returns) to
    // prove logEvent constructed the right write, not just that a mock exists.
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledOnce();
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'questionnaire.submitted',
          entityType: 'questionnaire',
          entityId: 'q-42',
          entityName: 'Onboarding survey',
          userId: 'user-1',
          clientIp: '10.0.0.1',
        }),
      })
    );
  });

  it('omitted userId is persisted as null (system event)', async () => {
    // Arrange — userId intentionally absent; `logEvent` must default it to null.
    const entry = {
      action: 'export.requested',
      entityType: 'export',
    };

    // Act
    logEvent(entry);
    await flushPromises();

    // Assert — the DB row must carry null for userId, not undefined.
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: null }),
      })
    );
  });

  it('secret-named keys in metadata are redacted before the DB write, safe keys pass through', async () => {
    // This test proves delegation to logAdminAction's sanitization pipeline
    // rather than a parallel reimplementation: if logEvent merely copied the
    // metadata verbatim, `apiKey` would reach the DB un-redacted.
    const entry = {
      action: 'webhook.received',
      entityType: 'webhook',
      metadata: {
        apiKey: 'sk-secret-1234', // must be redacted
        safe: 'keep-me', // must pass through unchanged
      },
    };

    // Act
    logEvent(entry);
    await flushPromises();

    // Assert — inspect the actual call args, not mock return values.
    const call = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0];
    const storedMetadata = call.data.metadata as Record<string, unknown>;

    expect(storedMetadata['apiKey']).toBe('[REDACTED]');
    expect(storedMetadata['safe']).toBe('keep-me');
  });

  it('null metadata is stored as Prisma.JsonNull (not plain null)', async () => {
    // Matches the contract established by logAdminAction for nullable JSON columns.
    const entry = {
      action: 'system.heartbeat',
      entityType: 'system',
      metadata: null,
    };

    // Act
    logEvent(entry);
    await flushPromises();

    // Assert
    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ metadata: Prisma.JsonNull }),
      })
    );
  });

  it('returns undefined synchronously — confirming the void fire-and-forget signature', () => {
    // Callers must not await logEvent — it returns void intentionally.
    const result = logEvent({ action: 'test.event', entityType: 'test' });
    expect(result).toBeUndefined();
  });

  it('does not throw to the caller when the DB write rejects', async () => {
    // Arrange — simulate a DB failure.
    vi.mocked(prisma.aiAdminAuditLog.create).mockRejectedValue(new Error('Connection reset'));

    // Act + Assert — the synchronous call must not throw.
    // test-review:accept empty_not_throw — fire-and-forget: the rejection is
    // swallowed by logAdminAction's internal catch and logged; the caller
    // must never see it.
    expect(() => logEvent({ action: 'broken.write', entityType: 'test' })).not.toThrow();
    await flushPromises();

    // The error should have been handed off to logger.error (via logAdminAction).
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to write admin audit log',
      expect.objectContaining({ error: 'Connection reset' })
    );
  });

  it('there is NO changes field in the DB write (logEvent omits before/after diffs by design)', async () => {
    // The AppEventEntry type intentionally omits `changes`. Verify the write
    // does not accidentally forward a `changes` key from the logAdminAction call.
    // The expected value for null changes is Prisma.JsonNull (logAdminAction
    // normalises undefined/null → Prisma.JsonNull internally).
    const entry = {
      action: 'data.exported',
      entityType: 'report',
    };

    logEvent(entry);
    await flushPromises();

    const call = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0];
    // `changes` should be Prisma.JsonNull — no before/after diff for app events.
    expect(call.data.changes).toBe(Prisma.JsonNull);
  });
});
