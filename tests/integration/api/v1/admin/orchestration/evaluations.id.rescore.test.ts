/**
 * Integration Test: Admin Orchestration — Re-score Evaluation Session
 *
 * POST /api/v1/admin/orchestration/evaluations/:id/rescore
 *
 * @see app/api/v1/admin/orchestration/evaluations/[id]/rescore/route.ts
 *
 * Mirrors the complete-route test pattern. Key assertions:
 * - Admin auth required (401/403)
 * - 200 on success: response body contains { session: RescoreEvaluationResult }
 * - 404 on NotFoundError, 409 on ConflictError, 400 on ValidationError
 * - Empty body tolerated
 * - Bad CUID → 400
 * - Plain Error → 500 with sanitized message (no leak)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/evaluations/[id]/rescore/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { NotFoundError, ConflictError, ValidationError } from '@/lib/api/errors';

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'http://localhost:3000',
  },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/orchestration/evaluations', () => ({
  rescoreEvaluationSession: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { rescoreEvaluationSession } from '@/lib/orchestration/evaluations';
import { adminLimiter } from '@/lib/security/rate-limit';

const SESSION_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';

function makeRescoreResult() {
  return {
    sessionId: SESSION_ID,
    metricSummary: {
      avgFaithfulness: 0.87,
      avgGroundedness: 0.82,
      avgRelevance: 0.91,
      scoredLogCount: 5,
      judgeProvider: 'anthropic',
      judgeModel: 'claude-sonnet-4-6',
      scoredAt: '2026-05-04T09:30:00.000Z',
      totalScoringCostUsd: 0.024,
    },
  };
}

function makePostRequest(body: Record<string, unknown> = {}): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/${SESSION_ID}/rescore`,
  };
  return {
    ...base,
    clone: () => ({ ...base }),
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe('POST /api/v1/admin/orchestration/evaluations/:id/rescore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful re-score', () => {
    it('returns 200 with { session: RescoreEvaluationResult }', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(rescoreEvaluationSession).mockResolvedValue(makeRescoreResult());

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: {
          session: {
            sessionId: string;
            metricSummary: {
              avgFaithfulness: number;
              scoredLogCount: number;
              totalScoringCostUsd: number;
            };
          };
        };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.session.sessionId).toBe(SESSION_ID);
      expect(data.data.session.metricSummary.avgFaithfulness).toBe(0.87);
      expect(data.data.session.metricSummary.scoredLogCount).toBe(5);
      expect(data.data.session.metricSummary.totalScoringCostUsd).toBe(0.024);
    });

    it('calls rescoreEvaluationSession with sessionId and userId', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(rescoreEvaluationSession).mockResolvedValue(makeRescoreResult());

      await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(vi.mocked(rescoreEvaluationSession)).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID })
      );
    });

    it('tolerates an empty body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(rescoreEvaluationSession).mockResolvedValue(makeRescoreResult());

      const base = {
        method: 'POST',
        headers: new Headers(),
        json: () => Promise.reject(new Error('no body')),
        text: () => Promise.resolve(''),
        url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/${SESSION_ID}/rescore`,
      };
      const request = { ...base, clone: () => ({ ...base }) } as unknown as NextRequest;

      const response = await POST(request, makeParams(SESSION_ID));
      expect(response.status).toBe(200);
    });
  });

  describe('Handler error mapping', () => {
    it('returns 404 when handler throws NotFoundError', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(rescoreEvaluationSession).mockRejectedValue(new NotFoundError('not here'));

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));
      expect(response.status).toBe(404);
    });

    it('returns 409 when handler throws ConflictError (session not completed)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(rescoreEvaluationSession).mockRejectedValue(
        new ConflictError('Only completed evaluation sessions can be re-scored')
      );

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));
      expect(response.status).toBe(409);
    });

    it('returns 400 when handler throws ValidationError', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(rescoreEvaluationSession).mockRejectedValue(new ValidationError('no logs'));

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));
      expect(response.status).toBe(400);
    });

    it('CRITICAL: returns 500 on plain Error and does NOT leak the raw message', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(rescoreEvaluationSession).mockRejectedValue(new Error('judge api key invalid'));

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));
      expect(response.status).toBe(500);
      const body = await response.text();
      // Critical security invariant — raw error never leaks to client.
      expect(body).not.toContain('judge api key invalid');
    });
  });

  describe('Validation', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const base = {
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('{}'),
        url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/${INVALID_ID}/rescore`,
      };
      const request = { ...base, clone: () => ({ ...base }) } as unknown as NextRequest;
      const response = await POST(request, makeParams(INVALID_ID));
      expect(response.status).toBe(400);
    });
  });
});
