/**
 * Integration Test: Admin Orchestration — Single Evaluation Session
 *
 * GET   /api/v1/admin/orchestration/evaluations/:id
 * PATCH /api/v1/admin/orchestration/evaluations/:id
 *
 * @see app/api/v1/admin/orchestration/evaluations/[id]/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Ownership enforced via findFirst({ where: { id, userId } })
 * - Cross-user access returns 404 (NOT 403)
 * - PATCH cannot set status='completed' — Zod schema excludes that value
 * - PATCH with empty body → 400 (schema refine requires at least one field)
 * - PATCH is rate limited
 * - Bad CUID returns 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH } from '@/app/api/v1/admin/orchestration/evaluations/[id]/route';
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
      findFirst: vi.fn(),
      update: vi.fn(),
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

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const SESSION_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';

function makeEvaluationSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: ADMIN_ID,
    agentId: AGENT_ID,
    title: 'Test Evaluation',
    description: null,
    status: 'draft',
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    agent: { id: AGENT_ID, name: 'Test Agent', slug: 'test-agent' },
    _count: { logs: 0 },
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(method: string = 'GET'): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/${SESSION_ID}`,
  } as unknown as NextRequest;
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'PATCH',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/${SESSION_ID}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/evaluations/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns 200 with the evaluation session', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(
        makeEvaluationSession() as never
      );

      const response = await GET(makeRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(SESSION_ID);
    });
  });

  describe('Cross-user access (CRITICAL — must be 404, not 403)', () => {
    it('returns 404 when session belongs to another user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(404);
      expect(response.status).not.toBe(403);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });
});

describe('PATCH /api/v1/admin/orchestration/evaluations/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await PATCH(makePatchRequest({ title: 'Updated' }), makeParams(SESSION_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await PATCH(makePatchRequest({ title: 'Updated' }), makeParams(SESSION_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful update', () => {
    it('returns 200 with the updated evaluation session', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(
        makeEvaluationSession() as never
      );
      vi.mocked(prisma.aiEvaluationSession.update).mockResolvedValue(
        makeEvaluationSession({ title: 'Updated Title' }) as never
      );

      const response = await PATCH(
        makePatchRequest({ title: 'Updated Title' }),
        makeParams(SESSION_ID)
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(SESSION_ID);
    });
  });

  describe('Cross-user access (CRITICAL — must be 404, not 403)', () => {
    it('returns 404 when session belongs to another user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(null);

      const response = await PATCH(makePatchRequest({ title: 'Updated' }), makeParams(SESSION_ID));

      expect(response.status).toBe(404);
      expect(response.status).not.toBe(403);
    });
  });

  describe('Full payload update', () => {
    it('updates all optional fields in a single payload', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(
        makeEvaluationSession() as never
      );
      vi.mocked(prisma.aiEvaluationSession.update).mockResolvedValue(
        makeEvaluationSession() as never
      );

      const fullPayload = {
        title: 'New Title',
        description: 'New description',
        status: 'in_progress' as const,
        metadata: { owner: 'qa' },
      };

      await PATCH(makePatchRequest(fullPayload), makeParams(SESSION_ID));

      const updateCall = vi.mocked(prisma.aiEvaluationSession.update).mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        title: 'New Title',
        description: 'New description',
        status: 'in_progress',
        metadata: { owner: 'qa' },
      });
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when body is empty (schema refine requires at least one field)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await PATCH(makePatchRequest({}), makeParams(SESSION_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when status is set to completed (Zod schema excludes that value)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await PATCH(
        makePatchRequest({ status: 'completed' }),
        makeParams(SESSION_ID)
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await PATCH(makePatchRequest({ title: 'Updated' }), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is hit on PATCH', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await PATCH(makePatchRequest({ title: 'Updated' }), makeParams(SESSION_ID));

      expect(response.status).toBe(429);
    });
  });
});
