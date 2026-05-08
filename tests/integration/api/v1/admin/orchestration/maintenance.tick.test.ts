/**
 * Integration Test: Admin Orchestration — Unified Maintenance Tick
 *
 * POST /api/v1/admin/orchestration/maintenance/tick
 *
 * @see app/api/v1/admin/orchestration/maintenance/tick/route.ts
 *
 * Key assertions:
 * - Admin auth required
 * - Returns 202 with schedules result + backgroundTasks list
 * - Invokes all 8 maintenance functions (one synchronous, seven background)
 * - Schedules error is captured in payload; background still kicks off
 * - Overlap guard prevents concurrent ticks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  POST,
  __test_setTickRunning,
} from '@/app/api/v1/admin/orchestration/maintenance/tick/route';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Module mocks ────────────────────────────────────────────────────────────

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

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('@/lib/orchestration/scheduling', () => ({
  processDueSchedules: vi.fn(),
  processOrphanedExecutions: vi.fn(),
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

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { logger } from '@/lib/logging';
import {
  processDueSchedules,
  processOrphanedExecutions,
  processPendingExecutions,
} from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
import { processPendingHookRetries } from '@/lib/orchestration/hooks/registry';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers(),
    url: 'http://localhost:3000/api/v1/admin/orchestration/maintenance/tick',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const SCHEDULE_RESULT = { processed: 2, succeeded: 2, failed: 0, errors: [] };
const RETENTION_RESULT = {
  deleted: 10,
  agentsProcessed: 2,
  webhookDeliveriesDeleted: 0,
  hookDeliveriesDeleted: 0,
  costLogsDeleted: 0,
  auditLogsDeleted: 0,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/maintenance/tick', () => {
  afterEach(() => {
    __test_setTickRunning(false);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processDueSchedules).mockResolvedValue(SCHEDULE_RESULT);
    vi.mocked(processPendingRetries).mockResolvedValue(3);
    vi.mocked(processPendingHookRetries).mockResolvedValue(2);
    vi.mocked(reapZombieExecutions).mockResolvedValue({
      reaped: 1,
      stalePending: 0,
      abandonedApprovals: 0,
    });
    vi.mocked(backfillMissingEmbeddings).mockResolvedValue({ processed: 5, failed: 0 });
    vi.mocked(enforceRetentionPolicies).mockResolvedValue(RETENTION_RESULT);
    vi.mocked(processPendingExecutions).mockResolvedValue({
      recovered: 0,
      failed: 0,
      errors: [],
    });
    vi.mocked(processOrphanedExecutions).mockResolvedValue({
      recovered: 0,
      exhausted: 0,
      errors: [],
    });
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await POST(makeRequest());

    expect(response.status).toBe(403);
  });

  it('returns 202 with schedules result and backgroundTasks list', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeRequest());

    expect(response.status).toBe(202);
    const body = await parseJson<{
      success: boolean;
      data: { schedules: unknown; backgroundTasks: string[]; durationMs: number };
    }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.schedules).toEqual(SCHEDULE_RESULT);
    expect(body.data.backgroundTasks).toEqual([
      'webhookRetries',
      'hookRetries',
      'orphanSweep',
      'zombieReaper',
      'embeddingBackfill',
      'retention',
      'pendingExecutionRecovery',
    ]);
    expect(body.data.durationMs).toEqual(expect.any(Number));
  });

  it('still invokes the seven background maintenance functions', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await POST(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    expect(processPendingRetries).toHaveBeenCalledTimes(1);
    expect(processPendingHookRetries).toHaveBeenCalledTimes(1);
    expect(processOrphanedExecutions).toHaveBeenCalledTimes(1);
    expect(reapZombieExecutions).toHaveBeenCalledTimes(1);
    expect(backfillMissingEmbeddings).toHaveBeenCalledTimes(1);
    expect(enforceRetentionPolicies).toHaveBeenCalledTimes(1);
    expect(processPendingExecutions).toHaveBeenCalledTimes(1);
  });

  it('logs the per-task background summary when the chain settles', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await POST(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.objectContaining({
        webhookRetries: 3,
        hookRetries: 2,
        orphanSweep: { recovered: 0, exhausted: 0, errors: [] },
        zombieReaper: { reaped: 1, stalePending: 0, abandonedApprovals: 0 },
        embeddingBackfill: { processed: 5, failed: 0 },
        retention: RETENTION_RESULT,
        totalDurationMs: expect.any(Number),
      })
    );
  });

  it('captures an individual background task failure in the log summary', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(processPendingRetries).mockRejectedValue(new Error('Redis connection failed'));

    const response = await POST(makeRequest());
    expect(response.status).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.objectContaining({
        webhookRetries: { error: expect.stringContaining('Redis connection failed') },
        // Other tasks still succeed
        zombieReaper: { reaped: 1, stalePending: 0, abandonedApprovals: 0 },
      })
    );
  });

  it('reports a schedules failure in the synchronous payload', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(processDueSchedules).mockRejectedValue(new Error('schedule lock timeout'));

    const response = await POST(makeRequest());
    expect(response.status).toBe(202);

    const body = await parseJson<{
      data: { schedules: { error: string } };
    }>(response);
    expect(body.data.schedules).toEqual({ error: 'schedule lock timeout' });
  });

  it('returns skipped when tick is already running', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    __test_setTickRunning(true);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: { skipped: boolean; reason: string };
    }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.data.skipped).toBe(true);
    expect(body.data.reason).toBe('previous tick still running');

    expect(processDueSchedules).not.toHaveBeenCalled();
    expect(processPendingRetries).not.toHaveBeenCalled();
    expect(processPendingHookRetries).not.toHaveBeenCalled();
    expect(reapZombieExecutions).not.toHaveBeenCalled();
  });
});
