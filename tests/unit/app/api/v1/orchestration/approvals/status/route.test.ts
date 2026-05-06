/**
 * Unit Test: Public token-authenticated execution status
 *
 * GET /api/v1/orchestration/approvals/:id/status?token=<signed-token>
 *
 * Backs the polling loop on chat-rendered approval cards (admin chat +
 * embed widget). Same auth posture as the sibling approve/reject
 * routes; permissive CORS so the embed widget can poll from any
 * configured customer origin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

const mockVerify = vi.fn();
vi.mock('@/lib/orchestration/approval-tokens', () => ({
  verifyApprovalToken: (token: string): unknown => mockVerify(token),
}));

const { prisma } = await import('@/lib/db/client');
const { GET, OPTIONS } = await import('@/app/api/v1/orchestration/approvals/[id]/status/route');

const findUnique = prisma.aiWorkflowExecution.findUnique as ReturnType<typeof vi.fn>;

const VALID_ID = 'cmexec99validid01234567890';

function makeRequest(token: string | null): NextRequest {
  const url = new URL(
    `https://example.com/api/v1/orchestration/approvals/${VALID_ID}/status${
      token === null ? '' : `?token=${encodeURIComponent(token)}`
    }`
  );
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/v1/orchestration/approvals/:id/status', () => {
  it('OPTIONS returns 204 with permissive CORS headers', () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('returns 401 when token is missing', async () => {
    const res = await GET(makeRequest(null), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('returns 401 when token verification throws', async () => {
    mockVerify.mockImplementation(() => {
      throw new Error('expired');
    });
    const res = await GET(makeRequest('garbage'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 when token executionId does not match the URL param', async () => {
    mockVerify.mockReturnValue({
      executionId: 'someotheridvalidid01234567',
      action: 'approve',
      expiresAt: new Date('2030-01-01').toISOString(),
    });
    const res = await GET(makeRequest('valid-but-wrong-id'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when execution row is not found', async () => {
    mockVerify.mockReturnValue({
      executionId: VALID_ID,
      action: 'approve',
      expiresAt: new Date('2030-01-01').toISOString(),
    });
    findUnique.mockResolvedValue(null);
    const res = await GET(makeRequest('valid-token'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('returns the execution status, error message, and trace on success', async () => {
    mockVerify.mockReturnValue({
      executionId: VALID_ID,
      action: 'approve',
      expiresAt: new Date('2030-01-01').toISOString(),
    });
    findUnique.mockResolvedValue({
      id: VALID_ID,
      status: 'completed',
      errorMessage: null,
      executionTrace: [
        {
          stepId: 's1',
          stepType: 'human_approval',
          label: 'Approve',
          status: 'completed',
          output: { ok: true },
          tokensUsed: 0,
          costUsd: 0,
          startedAt: '2026-05-06T00:00:00.000Z',
          durationMs: 0,
        },
      ],
      completedAt: new Date('2026-05-06T01:00:00Z'),
    });

    const res = await GET(makeRequest('valid-token'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { status: string; executionTrace: unknown[] };
    };
    expect(body.data.status).toBe('completed');
    expect(body.data.executionTrace).toHaveLength(1);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
