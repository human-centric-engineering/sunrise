/**
 * Integration Test: Admin Orchestration — Quiz Scores
 *
 * GET  /api/v1/admin/orchestration/quiz-scores — list quiz scores for the caller
 * POST /api/v1/admin/orchestration/quiz-scores — save a quiz score
 *
 * @see app/api/v1/admin/orchestration/quiz-scores/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/quiz-scores/route';
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
    aiEvaluationSession: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    aiAgent: {
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

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_ID = 'cmjbv4i3x00003wsloputgwus';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwua';
const BASE_URL = 'http://localhost:3000/api/v1/admin/orchestration/quiz-scores';

function makeEvaluationSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    metadata: { quizScore: { correct: 8, total: 10 } },
    completedAt: new Date('2025-06-01T12:00:00.000Z'),
    ...overrides,
  };
}

function makeGetRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: BASE_URL,
  } as unknown as NextRequest;
}

function makePostRequest(body: Record<string, unknown> = { correct: 8, total: 10 }): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
    url: BASE_URL,
  };
  return {
    ...base,
    clone: () => ({ ...base }),
  } as unknown as NextRequest;
}

// makeParams is not needed for these routes — no dynamic segments

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── GET Tests ────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/quiz-scores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Successful listing', () => {
    it('returns 200 with an array of quiz scores', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([
        makeEvaluationSession(),
      ] as never);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: Array<{ id: string; correct: number; total: number; completedAt: string }>;
      }>(response);

      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].id).toBe(SESSION_ID);
      expect(data.data[0].correct).toBe(8);
      expect(data.data[0].total).toBe(10);
    });

    it('returns empty array when no quiz scores exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([] as never);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: unknown[] }>(response);
      expect(data.data).toHaveLength(0);
    });

    it('defaults correct and total to 0 when metadata lacks quizScore', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([
        makeEvaluationSession({ metadata: {} }),
      ] as never);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: Array<{ correct: number; total: number }> }>(response);
      expect(data.data[0].correct).toBe(0);
      expect(data.data[0].total).toBe(0);
    });

    it('filters by the caller user ID (query passes userId = session.user.id)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([] as never);

      await GET(makeGetRequest());

      const callArgs = vi.mocked(prisma.aiEvaluationSession.findMany).mock.calls[0][0];
      expect(callArgs?.where?.userId).toBe('cmjbv4i3x00003wsloputgwul');
    });
  });
});

// ─── POST Tests ───────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/quiz-scores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest());

      expect(response.status).toBe(429);
    });
  });

  describe('Validation', () => {
    it('returns 400 when correct is missing from body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ total: 10 }));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when total is missing from body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ correct: 5 }));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when total is 0 (must be >= 1)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ correct: 0, total: 0 }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when correct exceeds total', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ correct: 11, total: 10 }));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Successful save', () => {
    it('returns 201 with the saved quiz score', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiEvaluationSession.create).mockResolvedValue({
        id: SESSION_ID,
        metadata: { quizScore: { correct: 8, total: 10 } },
        completedAt: new Date(),
      } as never);

      const response = await POST(makePostRequest({ correct: 8, total: 10 }));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        success: boolean;
        data: { id: string; correct: number; total: number };
      }>(response);

      expect(data.success).toBe(true);
      expect(data.data.id).toBe(SESSION_ID);
      expect(data.data.correct).toBe(8);
      expect(data.data.total).toBe(10);
    });

    it('creates the session with null agentId when quiz-master agent is not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.aiEvaluationSession.create).mockResolvedValue({
        id: SESSION_ID,
        metadata: { quizScore: { correct: 5, total: 5 } },
        completedAt: new Date(),
      } as never);

      const response = await POST(makePostRequest({ correct: 5, total: 5 }));

      expect(response.status).toBe(201);
      const createCall = vi.mocked(prisma.aiEvaluationSession.create).mock.calls[0][0];
      expect(createCall.data.agentId).toBeNull();
    });

    it('passes the correct userId from the session to the create call', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.aiEvaluationSession.create).mockResolvedValue({
        id: SESSION_ID,
        metadata: { quizScore: { correct: 10, total: 10 } },
        completedAt: new Date(),
      } as never);

      await POST(makePostRequest({ correct: 10, total: 10 }));

      const createCall = vi.mocked(prisma.aiEvaluationSession.create).mock.calls[0][0];
      expect(createCall.data.userId).toBe('cmjbv4i3x00003wsloputgwul');
    });

    it('stores correct and total in metadata.quizScore', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.aiEvaluationSession.create).mockResolvedValue({
        id: SESSION_ID,
        metadata: { quizScore: { correct: 3, total: 7 } },
        completedAt: new Date(),
      } as never);

      await POST(makePostRequest({ correct: 3, total: 7 }));

      const createCall = vi.mocked(prisma.aiEvaluationSession.create).mock.calls[0][0];
      const metadata = createCall.data.metadata as {
        quizScore: { correct: number; total: number };
      };
      expect(metadata.quizScore.correct).toBe(3);
      expect(metadata.quizScore.total).toBe(7);
    });

    it('accepts correct=0 (perfect score of 0/N is valid)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.aiEvaluationSession.create).mockResolvedValue({
        id: SESSION_ID,
        metadata: { quizScore: { correct: 0, total: 5 } },
        completedAt: new Date(),
      } as never);

      const response = await POST(makePostRequest({ correct: 0, total: 5 }));

      expect(response.status).toBe(201);
    });
  });
});
