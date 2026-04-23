/**
 * Tests: Unified Maintenance Tick Endpoint
 *
 * POST /api/v1/admin/orchestration/maintenance/tick
 *
 * Runs all periodic maintenance tasks in one call and returns a summary
 * of results. Auth: Admin role required.
 *
 * Test Coverage:
 * - Returns 401 when unauthenticated
 * - Returns 429 when rate limited
 * - Returns 200 with all task results on success
 * - Includes durationMs in the response
 * - Partial failures: each task result is unwrapped independently
 *   (one task throwing does not prevent others from running)
 * - Error string is returned when a task rejects
 * - All five tasks are called on every request
 *
 * @see app/api/v1/admin/orchestration/maintenance/tick/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────���────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/scheduling', () => ({
  processDueSchedules: vi.fn(),
  processPendingExecutions: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  processPendingRetries: vi.fn(),
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  processPendingHookRetries: vi.fn(),
}));

vi.mock('@/lib/orchestration/engine/execution-reaper', () => ({
  reapZombieExecutions: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat/message-embedder', () => ({
  backfillMissingEmbeddings: vi.fn(),
}));

vi.mock('@/lib/orchestration/retention', () => ({
  enforceRetentionPolicies: vi.fn(),
}));

// ─── Imports ──────────────────────────────────���────────────────────────────���

import { auth } from '@/lib/auth/config';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { processDueSchedules, processPendingExecutions } from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
import { processPendingHookRetries } from '@/lib/orchestration/hooks/registry';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { POST } from '@/app/api/v1/admin/orchestration/maintenance/tick/route';

// ─── Helpers ─────────────────────────────────────────────────────────���──────

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/maintenance/tick', {
    method: 'POST',
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Fixtures ───────────────────��─────────────────────────────────��──────────

const DEFAULT_SCHEDULE_RESULT = { triggered: 2, skipped: 0 };
const DEFAULT_RETRY_RESULT = 3;
const DEFAULT_HOOK_RETRY_RESULT = 2;
const DEFAULT_REAPER_RESULT = { reaped: 1 };
const DEFAULT_EMBEDDER_RESULT = { backfilled: 5, failed: 0 };
const DEFAULT_RETENTION_RESULT = {
  deleted: 10,
  agentsProcessed: 2,
  webhookDeliveriesDeleted: 0,
  hookDeliveriesDeleted: 0,
  costLogsDeleted: 0,
  auditLogsDeleted: 0,
};
const DEFAULT_PENDING_RECOVERY_RESULT = { recovered: 0, failed: 0, errors: [] };

// ─── Tests ────────────────────────────────────────────────────────────────��─

describe('POST /api/v1/admin/orchestration/maintenance/tick', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: admin auth passes
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Default: rate limit passes
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(createRateLimitResponse).mockReturnValue(
      Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
    );

    // Default: all tasks succeed
    vi.mocked(processDueSchedules).mockResolvedValue(DEFAULT_SCHEDULE_RESULT as never);
    vi.mocked(processPendingRetries).mockResolvedValue(DEFAULT_RETRY_RESULT);
    vi.mocked(processPendingHookRetries).mockResolvedValue(DEFAULT_HOOK_RETRY_RESULT);
    vi.mocked(reapZombieExecutions).mockResolvedValue(DEFAULT_REAPER_RESULT);
    vi.mocked(backfillMissingEmbeddings).mockResolvedValue(DEFAULT_EMBEDDER_RESULT as never);
    vi.mocked(enforceRetentionPolicies).mockResolvedValue(DEFAULT_RETENTION_RESULT);
    vi.mocked(processPendingExecutions).mockResolvedValue(DEFAULT_PENDING_RECOVERY_RESULT);
  });

  // ── Authentication ──────────────────────���───────────────────���───────────

  it('returns 401 when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    const response = await POST(makeRequest());

    // Assert
    expect(response.status).toBe(401);
  });

  it('does not call any maintenance tasks when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    await POST(makeRequest());

    // Assert: no tasks run
    expect(processDueSchedules).not.toHaveBeenCalled();
    expect(processPendingRetries).not.toHaveBeenCalled();
    expect(reapZombieExecutions).not.toHaveBeenCalled();
    expect(backfillMissingEmbeddings).not.toHaveBeenCalled();
    expect(enforceRetentionPolicies).not.toHaveBeenCalled();
  });

  // ── Rate limiting ───────────────────────────────────────────────────────

  it('returns 429 when rate limited', async () => {
    // Arrange: rate limit exceeded
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await POST(makeRequest());

    // Assert
    expect(response.status).toBe(429);
  });

  it('does not run tasks when rate limited', async () => {
    // Arrange
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    await POST(makeRequest());

    // Assert: no tasks run
    expect(processDueSchedules).not.toHaveBeenCalled();
  });

  // ── Happy path ──────────────────────────────���───────────────────────────

  it('returns 200 with all task results on success', async () => {
    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{ success: boolean; data: Record<string, unknown> }>(response);

    // Assert
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('includes schedules result in response data', async () => {
    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{ data: { schedules: unknown } }>(response);

    // Assert
    expect(body.data.schedules).toEqual(DEFAULT_SCHEDULE_RESULT);
  });

  it('includes webhookRetries result in response data', async () => {
    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{ data: { webhookRetries: number } }>(response);

    // Assert
    expect(body.data.webhookRetries).toBe(DEFAULT_RETRY_RESULT);
  });

  it('includes hookRetries result in response data', async () => {
    const response = await POST(makeRequest());
    const body = await parseJson<{ data: { hookRetries: number } }>(response);

    expect(body.data.hookRetries).toBe(DEFAULT_HOOK_RETRY_RESULT);
  });

  it('includes zombieReaper result in response data', async () => {
    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{ data: { zombieReaper: unknown } }>(response);

    // Assert
    expect(body.data.zombieReaper).toEqual(DEFAULT_REAPER_RESULT);
  });

  it('includes embeddingBackfill result in response data', async () => {
    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{ data: { embeddingBackfill: unknown } }>(response);

    // Assert
    expect(body.data.embeddingBackfill).toEqual(DEFAULT_EMBEDDER_RESULT);
  });

  it('includes retention result in response data', async () => {
    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{ data: { retention: unknown } }>(response);

    // Assert
    expect(body.data.retention).toEqual(DEFAULT_RETENTION_RESULT);
  });

  it('includes durationMs in response data', async () => {
    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{ data: { durationMs: number } }>(response);

    // Assert: durationMs is a non-negative number
    expect(typeof body.data.durationMs).toBe('number');
    expect(body.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('calls all seven maintenance tasks', async () => {
    // Act
    await POST(makeRequest());

    // Assert: all tasks called exactly once
    expect(processDueSchedules).toHaveBeenCalledTimes(1);
    expect(processPendingRetries).toHaveBeenCalledTimes(1);
    expect(processPendingHookRetries).toHaveBeenCalledTimes(1);
    expect(reapZombieExecutions).toHaveBeenCalledTimes(1);
    expect(backfillMissingEmbeddings).toHaveBeenCalledTimes(1);
    expect(enforceRetentionPolicies).toHaveBeenCalledTimes(1);
    expect(processPendingExecutions).toHaveBeenCalledTimes(1);
  });

  it('includes pendingExecutionRecovery in response data', async () => {
    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{
      data: { pendingExecutionRecovery: unknown };
    }>(response);

    // Assert
    expect(body.data.pendingExecutionRecovery).toEqual(DEFAULT_PENDING_RECOVERY_RESULT);
  });

  // ── Partial task failure ────────────────────────────────────────────────

  it('returns 200 even when one task throws — other results still included', async () => {
    // Arrange: schedules task fails
    vi.mocked(processDueSchedules).mockRejectedValue(new Error('DB timeout'));

    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{
      success: boolean;
      data: {
        schedules: unknown;
        webhookRetries: unknown;
        zombieReaper: unknown;
      };
    }>(response);

    // Assert: 200 despite partial failure
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    // Other tasks still return their results
    expect(body.data.webhookRetries).toBe(DEFAULT_RETRY_RESULT);
    expect(body.data.zombieReaper).toEqual(DEFAULT_REAPER_RESULT);
  });

  it('returns error string for a failed task result', async () => {
    // Arrange: retention task fails
    vi.mocked(enforceRetentionPolicies).mockRejectedValue(new Error('Prisma connection lost'));

    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{
      data: { retention: { error: string } };
    }>(response);

    // Assert: error is captured as string
    expect(body.data.retention).toHaveProperty('error');
    expect(body.data.retention.error).toContain('Prisma connection lost');
  });

  it('returns error strings for all tasks when all fail', async () => {
    // Arrange: all tasks fail
    vi.mocked(processDueSchedules).mockRejectedValue(new Error('Error A'));
    vi.mocked(processPendingRetries).mockRejectedValue(new Error('Error B'));
    vi.mocked(processPendingHookRetries).mockRejectedValue(new Error('Error B2'));
    vi.mocked(reapZombieExecutions).mockRejectedValue(new Error('Error C'));
    vi.mocked(backfillMissingEmbeddings).mockRejectedValue(new Error('Error D'));
    vi.mocked(enforceRetentionPolicies).mockRejectedValue(new Error('Error E'));
    vi.mocked(processPendingExecutions).mockRejectedValue(new Error('Error F'));

    // Act
    const response = await POST(makeRequest());
    const body = await parseJson<{
      success: boolean;
      data: {
        schedules: { error: string };
        webhookRetries: { error: string };
        hookRetries: { error: string };
        zombieReaper: { error: string };
        embeddingBackfill: { error: string };
        retention: { error: string };
        pendingExecutionRecovery: { error: string };
      };
    }>(response);

    // Assert: response is still 200 with error fields
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.schedules).toHaveProperty('error');
    expect(body.data.webhookRetries).toHaveProperty('error');
    expect(body.data.hookRetries).toHaveProperty('error');
    expect(body.data.zombieReaper).toHaveProperty('error');
    expect(body.data.embeddingBackfill).toHaveProperty('error');
    expect(body.data.retention).toHaveProperty('error');
    expect(body.data.pendingExecutionRecovery).toHaveProperty('error');
  });

  it('tasks run concurrently (Promise.allSettled semantics)', async () => {
    // Arrange: track call order
    const callOrder: string[] = [];
    vi.mocked(processDueSchedules).mockImplementation(async () => {
      callOrder.push('schedules');
      return DEFAULT_SCHEDULE_RESULT as never;
    });
    vi.mocked(reapZombieExecutions).mockImplementation(async () => {
      callOrder.push('reaper');
      return DEFAULT_REAPER_RESULT;
    });

    // Act
    await POST(makeRequest());

    // Assert: both were called (order may vary with concurrent execution)
    expect(callOrder).toContain('schedules');
    expect(callOrder).toContain('reaper');
  });
});
