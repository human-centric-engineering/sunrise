/**
 * Unit Test: Quiz Scores API
 *
 * POST /api/v1/admin/orchestration/quiz-scores — save a quiz score
 * GET  /api/v1/admin/orchestration/quiz-scores — list quiz scores
 *
 * @see app/api/v1/admin/orchestration/quiz-scores/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/quiz-scores/route';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Mock dependencies ──────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn() },
    aiEvaluationSession: {
      create: vi.fn(),
      findMany: vi.fn(),
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

// ─── Imports after mocks ────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/quiz-scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/quiz-scores', {
    method: 'GET',
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/quiz-scores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(prisma.aiEvaluationSession.create).mockResolvedValue({
      id: 'session-1',
      metadata: { quizScore: { correct: 3, total: 5 } },
    } as never);
  });

  it('rejects unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

    const res = await POST(makePostRequest({ correct: 3, total: 5 }));
    expect(res.status).toBe(401);
  });

  it('saves a valid quiz score', async () => {
    const res = await POST(makePostRequest({ correct: 3, total: 5 }));
    const body = await res.json();

    expect(res.status).toBe(201);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.correct).toBe(3);
    expect(body.data.total).toBe(5);

    expect(prisma.aiEvaluationSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          metadata: { quizScore: { correct: 3, total: 5 } },
        }),
      })
    );
  });

  it('rejects when correct > total', async () => {
    const res = await POST(makePostRequest({ correct: 6, total: 5 }));
    expect(res.status).toBe(400);
  });

  it('rejects negative numbers', async () => {
    const res = await POST(makePostRequest({ correct: -1, total: 5 }));
    expect(res.status).toBe(400);
  });

  it('rejects non-integer values', async () => {
    const res = await POST(makePostRequest({ correct: 1.5, total: 5 }));
    expect(res.status).toBe(400);
  });

  it('rejects total of 0', async () => {
    const res = await POST(makePostRequest({ correct: 0, total: 0 }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/admin/orchestration/quiz-scores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
  });

  it('returns persisted quiz scores', async () => {
    vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([
      {
        id: 'session-1',
        metadata: { quizScore: { correct: 3, total: 5 } },
        completedAt: new Date('2026-04-17T10:00:00Z'),
      },
    ] as never);

    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].correct).toBe(3);
    expect(body.data[0].total).toBe(5);
  });

  it('returns empty array when no scores exist', async () => {
    vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([]);

    const res = await GET(makeGetRequest());
    const body = await res.json();

    expect(body.data).toEqual([]);
  });
});
