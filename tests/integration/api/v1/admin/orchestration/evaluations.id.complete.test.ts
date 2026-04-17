/**
 * Integration Test: Admin Orchestration — Complete Evaluation Session
 *
 * POST /api/v1/admin/orchestration/evaluations/:id/complete
 *
 * @see app/api/v1/admin/orchestration/evaluations/[id]/complete/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - 200 on success: response body contains { session: CompleteEvaluationResult }
 * - 404 when handler throws NotFoundError
 * - 409 when handler throws ConflictError
 * - 400 when handler throws ValidationError
 * - 500 on plain Error — CRITICAL: response must NOT leak the raw error message
 * - Empty body is tolerated (completeEvaluationBodySchema accepts {})
 * - Bad CUID → 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/evaluations/[id]/complete/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { NotFoundError, ConflictError, ValidationError } from '@/lib/api/errors';

// ─── Mock dependencies ───────────────────────────────────────────────────────

// Simulate production so handleAPIError sanitizes unknown errors to a generic
// message rather than forwarding the raw Error.message. This is the key
// security invariant we are asserting in the "CRITICAL" test below.
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
  completeEvaluationSession: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { completeEvaluationSession } from '@/lib/orchestration/evaluations';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';

function makeCompleteResult() {
  return {
    sessionId: SESSION_ID,
    status: 'completed' as const,
    summary: 'The evaluation went well.',
    improvementSuggestions: ['Consider edge cases', 'Improve response time'],
    tokenUsage: { input: 1000, output: 500 },
    costUsd: 0.05,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown> = {}): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/${SESSION_ID}/complete`,
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/evaluations/:id/complete', () => {
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

  describe('Successful completion', () => {
    it('returns 200 with { session: CompleteEvaluationResult }', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(completeEvaluationSession).mockResolvedValue(makeCompleteResult());

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: {
          session: {
            sessionId: string;
            status: string;
            summary: string;
            improvementSuggestions: string[];
            tokenUsage: { input: number; output: number };
            costUsd: number;
          };
        };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.session.sessionId).toBe(SESSION_ID);
      expect(data.data.session.status).toBe('completed');
      expect(data.data.session.summary).toBe('The evaluation went well.');
      expect(Array.isArray(data.data.session.improvementSuggestions)).toBe(true);
      expect(data.data.session.tokenUsage).toEqual({ input: 1000, output: 500 });
      expect(data.data.session.costUsd).toBe(0.05);
    });

    it('tolerates an empty body (schema is z.object({}).passthrough())', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(completeEvaluationSession).mockResolvedValue(makeCompleteResult());

      // Empty body — no json field, simulates missing body
      const base = {
        method: 'POST',
        headers: new Headers(),
        json: () => Promise.reject(new Error('no body')),
        text: () => Promise.resolve(''),
        url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/${SESSION_ID}/complete`,
      };
      const request = {
        ...base,
        clone: () => ({ ...base }),
      } as unknown as NextRequest;

      const response = await POST(request, makeParams(SESSION_ID));

      expect(response.status).toBe(200);
    });

    it('calls completeEvaluationSession with sessionId and userId', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(completeEvaluationSession).mockResolvedValue(makeCompleteResult());

      await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(vi.mocked(completeEvaluationSession)).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID })
      );
    });
  });

  describe('Handler error mapping', () => {
    it('returns 404 when handler throws NotFoundError', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(completeEvaluationSession).mockRejectedValue(
        new NotFoundError('Evaluation session not found')
      );

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });

    it('returns 409 when handler throws ConflictError', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(completeEvaluationSession).mockRejectedValue(
        new ConflictError('Session already completed')
      );

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(409);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('CONFLICT');
    });

    it('returns 400 when handler throws ValidationError', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(completeEvaluationSession).mockRejectedValue(
        new ValidationError('No logs to analyse')
      );

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('CRITICAL: returns 500 on plain Error but does NOT leak raw error message in response', async () => {
      // Raw internal error messages (DB errors, stack traces, provider secrets) must
      // never reach the client. The catch-all in handleAPIError sanitizes unknown
      // errors to a generic message in production.
      const INTERNAL_MSG = 'internal blowup';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(completeEvaluationSession).mockRejectedValue(new Error(INTERNAL_MSG));

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(500);
      const raw = await response.text();
      // The raw error message must not appear anywhere in the response body
      expect(raw).not.toContain(INTERNAL_MSG);
      expect(raw).not.toContain('internal');
      expect(raw).not.toContain('blowup');
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is hit', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(429);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });
});
