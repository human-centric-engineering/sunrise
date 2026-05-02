/**
 * Integration Test: Get execution status (lightweight)
 *
 * GET /api/v1/admin/orchestration/executions/:id/status
 *
 * Sibling of `/executions/:id` — same auth, ownership, and CUID guards, but
 * returns a narrow projection (no trace, no input/output) suited to polling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/executions/[id]/status/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      findUnique: vi.fn(),
    },
  },
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

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_USER_ID = 'cmjbv4i3x00003wsloputgwz9';
const INVALID_ID = 'not-a-cuid';

function makeStatusRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    userId: ADMIN_ID,
    status: 'running',
    currentStep: 'step2',
    errorMessage: null,
    totalTokensUsed: 42,
    totalCostUsd: 0.123,
    startedAt: new Date('2026-05-01T12:00:00Z'),
    completedAt: null,
    createdAt: new Date('2026-05-01T11:59:55Z'),
    ...overrides,
  };
}

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}/status`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe('GET /api/v1/admin/orchestration/executions/:id/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(403);
  });

  it('returns 400 for invalid CUID param', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await GET(makeRequest(), makeParams(INVALID_ID));
    expect(response.status).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(429);
  });

  it('returns 404 when execution not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns 404 when execution belongs to a different user (not 403)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeStatusRow({ userId: OTHER_USER_ID }) as never
    );
    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns the projected status fields on the happy path', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeStatusRow() as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(200);

    const body = await parseJson<{
      success: boolean;
      data: Record<string, unknown>;
    }>(response);

    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      id: EXECUTION_ID,
      status: 'running',
      currentStep: 'step2',
      errorMessage: null,
      totalTokensUsed: 42,
      totalCostUsd: 0.123,
      startedAt: '2026-05-01T12:00:00.000Z',
      completedAt: null,
      createdAt: '2026-05-01T11:59:55.000Z',
    });
  });

  it('does not leak userId, executionTrace, inputData, or outputData', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeStatusRow() as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    const body = await parseJson<{ data: Record<string, unknown> }>(response);

    expect(body.data).not.toHaveProperty('userId');
    expect(body.data).not.toHaveProperty('executionTrace');
    expect(body.data).not.toHaveProperty('inputData');
    expect(body.data).not.toHaveProperty('outputData');
    expect(body.data).not.toHaveProperty('workflow');
  });

  it('queries Prisma with a narrow select (regression guard)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeStatusRow() as never);

    await GET(makeRequest(), makeParams(EXECUTION_ID));

    expect(prisma.aiWorkflowExecution.findUnique).toHaveBeenCalledWith({
      where: { id: EXECUTION_ID },
      select: {
        id: true,
        status: true,
        currentStep: true,
        errorMessage: true,
        totalTokensUsed: true,
        totalCostUsd: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        userId: true,
      },
    });
  });
});
