/**
 * Integration Test: Admin Orchestration — Unified Maintenance Tick
 *
 * POST /api/v1/admin/orchestration/maintenance/tick
 *
 * @see app/api/v1/admin/orchestration/maintenance/tick/route.ts
 *
 * Key assertions:
 * - Admin auth required
 * - Calls all 5 maintenance functions
 * - Returns results from each function
 * - Handles individual function failures gracefully
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
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  processPendingRetries: vi.fn(),
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
import { processDueSchedules } from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/maintenance/tick', () => {
  afterEach(() => {
    __test_setTickRunning(false);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processDueSchedules).mockResolvedValue({
      processed: 2,
      succeeded: 2,
      failed: 0,
      errors: [],
    });
    vi.mocked(processPendingRetries).mockResolvedValue(3);
    vi.mocked(reapZombieExecutions).mockResolvedValue({ reaped: 1 });
    vi.mocked(backfillMissingEmbeddings).mockResolvedValue({ processed: 5, failed: 0 });
    vi.mocked(enforceRetentionPolicies).mockResolvedValue({ deleted: 10, agentsProcessed: 2 });
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

  it('calls all maintenance functions and returns results', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: Record<string, unknown> }>(response);
    expect(body.success).toBe(true);
    expect(body.data.schedules).toEqual({ processed: 2, succeeded: 2, failed: 0, errors: [] });
    expect(body.data.webhookRetries).toBe(3);
    expect(body.data.zombieReaper).toEqual({ reaped: 1 });
    expect(body.data.embeddingBackfill).toEqual({ processed: 5, failed: 0 });
    expect(body.data.retention).toEqual({ deleted: 10, agentsProcessed: 2 });
    expect(body.data.durationMs).toEqual(expect.any(Number));
  });

  it('handles individual function failures gracefully', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(processPendingRetries).mockRejectedValue(new Error('Redis connection failed'));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: Record<string, unknown> }>(response);
    expect(body.success).toBe(true);
    // The failed function should report an error string
    expect(body.data.webhookRetries).toEqual({
      error: expect.stringContaining('Redis connection failed'),
    });
    // Other functions should succeed
    expect(body.data.schedules).toEqual({ processed: 2, succeeded: 2, failed: 0, errors: [] });
    expect(body.data.zombieReaper).toEqual({ reaped: 1 });
  });

  it('returns skipped when tick is already running', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    __test_setTickRunning(true);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: { skipped: boolean; reason: string } }>(
      response
    );
    expect(body.success).toBe(true);
    expect(body.data.skipped).toBe(true);
    expect(body.data.reason).toBe('previous tick still running');

    // None of the maintenance functions should have been called
    expect(processDueSchedules).not.toHaveBeenCalled();
    expect(processPendingRetries).not.toHaveBeenCalled();
    expect(reapZombieExecutions).not.toHaveBeenCalled();
  });
});
