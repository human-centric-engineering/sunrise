/**
 * Integration Test: Token-authenticated reject endpoint
 *
 * POST /api/v1/orchestration/approvals/:id/reject?token=<signed>
 *
 * Tests the public endpoint that uses HMAC-signed tokens for
 * rejection instead of session cookies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/orchestration/approvals/[id]/reject/route';

// ─── Mock dependencies ─────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
  },
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { apiLimiter } from '@/lib/security/rate-limit';
import { generateApprovalToken } from '@/lib/orchestration/approval-tokens';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: 'wf-1',
    userId: 'user-1',
    status: 'paused_for_approval',
    currentStep: 'approval-step',
    executionTrace: [
      {
        stepId: 'approval-step',
        stepType: 'human_approval',
        label: 'Review',
        status: 'awaiting_approval',
        output: { prompt: 'Approve this action?' },
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:00:00Z',
        durationMs: 0,
      },
    ],
    ...overrides,
  };
}

function makeRequest(id: string, token?: string, body?: Record<string, unknown>): NextRequest {
  const url = new URL(`http://localhost:3000/api/v1/orchestration/approvals/${id}/reject`);
  if (token) url.searchParams.set('token', token);

  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/orchestration/approvals/:id/reject (token auth)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 } as never);
  });

  it('returns 200 with valid token and reason', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);

    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'Not appropriate' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(200);
  });

  it('returns 401 when token is missing', async () => {
    const response = await POST(
      makeRequest(EXECUTION_ID, undefined, { reason: 'test' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(401);
  });

  it('returns 401 when token is expired', async () => {
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', -1);
    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'test' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(401);
  });

  it('returns 400 when token action is approve (wrong endpoint)', async () => {
    const { token } = generateApprovalToken(EXECUTION_ID, 'approve', 60);
    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'test' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 when reason is missing', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);

    const response = await POST(makeRequest(EXECUTION_ID, token, {}), makeParams(EXECUTION_ID));
    expect(response.status).toBe(400);
  });

  it('returns 400 when reason is empty string', async () => {
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);
    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: '' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 when body is not JSON', async () => {
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);
    const url = new URL(
      `http://localhost:3000/api/v1/orchestration/approvals/${EXECUTION_ID}/reject`
    );
    url.searchParams.set('token', token);
    const request = new NextRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    const response = await POST(request, makeParams(EXECUTION_ID));
    expect(response.status).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(apiLimiter.check).mockReturnValue({ success: false } as never);
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);
    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'test' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(429);
  });

  it('returns 409 when concurrent rejection races', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 0 } as never);
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);

    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'test' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(409);
  });

  it('returns 404 when execution not found', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);

    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'test' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(404);
  });

  it('returns 400 for invalid CUID param', async () => {
    const invalidId = 'not-a-cuid';
    const { token } = generateApprovalToken(invalidId, 'reject', 60);
    const response = await POST(
      makeRequest(invalidId, token, { reason: 'test' }),
      makeParams(invalidId)
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 when token execution id does not match URL param', async () => {
    const { token } = generateApprovalToken('other-exec-id', 'reject', 60);
    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'test' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 when execution is not paused_for_approval (INVALID_STATUS)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'completed' }) as never
    );
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);

    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'test' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(400);
  });

  it('returns 500 when executeRejection throws unexpected error', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockRejectedValue(
      new Error('DB connection lost')
    );
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);

    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'test' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(500);
  });

  // ─── Trace integrity ─────────────────────────────────────────────────────────

  it('returns 400 when execution trace is corrupted (not parseable)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ executionTrace: 'not-an-array' }) as never
    );
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);

    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'Not appropriate' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 when trace has no awaiting_approval entry', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({
        executionTrace: [
          {
            stepId: 'step-1',
            stepType: 'llm_call',
            label: 'Generate',
            status: 'completed',
            output: {},
            tokensUsed: 100,
            costUsd: 0.01,
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:00:01Z',
            durationMs: 1000,
          },
        ],
      }) as never
    );
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);

    const response = await POST(
      makeRequest(EXECUTION_ID, token, { reason: 'Not appropriate' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(400);
  });
});
