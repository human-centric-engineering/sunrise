/**
 * Integration Test: Token-authenticated approve endpoint
 *
 * POST /api/v1/orchestration/approvals/:id/approve?token=<signed>
 *
 * Tests the public endpoint that uses HMAC-signed tokens for
 * approval instead of session cookies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/orchestration/approvals/[id]/approve/route';

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
const INVALID_ID = 'not-a-cuid';

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
        output: { prompt: 'Approve?' },
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
  const url = new URL(`http://localhost:3000/api/v1/orchestration/approvals/${id}/approve`);
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

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/orchestration/approvals/:id/approve (token auth)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 } as never);
  });

  it('returns 200 with valid token and transitions execution', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    const { token } = generateApprovalToken(EXECUTION_ID, 'approve', 60);

    const response = await POST(makeRequest(EXECUTION_ID, token), makeParams(EXECUTION_ID));
    expect(response.status).toBe(200);

    const body = await parseJson<{ success: boolean; data: { executionId: string } }>(response);
    expect(body.success).toBe(true);
    expect(body.data.executionId).toBe(EXECUTION_ID);
  });

  it('returns 401 when token is missing', async () => {
    const response = await POST(makeRequest(EXECUTION_ID), makeParams(EXECUTION_ID));
    expect(response.status).toBe(401);
  });

  it('returns 401 when token is expired', async () => {
    // Generate with 0 minutes → already expired
    const { token } = generateApprovalToken(EXECUTION_ID, 'approve', -1);
    const response = await POST(makeRequest(EXECUTION_ID, token), makeParams(EXECUTION_ID));
    expect(response.status).toBe(401);
  });

  it('returns 401 when token signature is tampered', async () => {
    const { token } = generateApprovalToken(EXECUTION_ID, 'approve', 60);
    const tampered = token.slice(0, -5) + 'XXXXX';
    const response = await POST(makeRequest(EXECUTION_ID, tampered), makeParams(EXECUTION_ID));
    expect(response.status).toBe(401);
  });

  it('returns 400 when token action is reject (wrong endpoint)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    const { token } = generateApprovalToken(EXECUTION_ID, 'reject', 60);
    const response = await POST(makeRequest(EXECUTION_ID, token), makeParams(EXECUTION_ID));
    expect(response.status).toBe(400);
  });

  it('returns 400 when token execution id does not match URL param', async () => {
    const { token } = generateApprovalToken('other-exec-id', 'approve', 60);
    const response = await POST(makeRequest(EXECUTION_ID, token), makeParams(EXECUTION_ID));
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid CUID param', async () => {
    const { token } = generateApprovalToken(INVALID_ID, 'approve', 60);
    const response = await POST(makeRequest(INVALID_ID, token), makeParams(INVALID_ID));
    expect(response.status).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(apiLimiter.check).mockReturnValue({ success: false } as never);
    const { token } = generateApprovalToken(EXECUTION_ID, 'approve', 60);
    const response = await POST(makeRequest(EXECUTION_ID, token), makeParams(EXECUTION_ID));
    expect(response.status).toBe(429);
  });

  it('returns 409 when concurrent approval races (updateMany count === 0)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 0 } as never);
    const { token } = generateApprovalToken(EXECUTION_ID, 'approve', 60);

    const response = await POST(makeRequest(EXECUTION_ID, token), makeParams(EXECUTION_ID));
    expect(response.status).toBe(409);
  });

  it('returns 404 when execution not found', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
    const { token } = generateApprovalToken(EXECUTION_ID, 'approve', 60);

    const response = await POST(makeRequest(EXECUTION_ID, token), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });
});
