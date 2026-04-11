/**
 * Integration Test: Admin Orchestration — Evaluation Logs
 *
 * GET /api/v1/admin/orchestration/evaluations/:id/logs
 *
 * @see app/api/v1/admin/orchestration/evaluations/[id]/logs/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Ownership enforced on the parent session — cross-user returns 404
 * - Logs ordered by sequenceNumber ascending
 * - take equals the limit param
 * - before cursor forwarded into where.sequenceNumber.lt (numeric, not CUID)
 * - Invalid limit (e.g. 9999 > max 500) → 400
 * - Bad CUID → 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/evaluations/[id]/logs/route';
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
    },
    aiEvaluationLog: {
      findMany: vi.fn(),
    },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const SESSION_ID = 'cmjbv4i3x00003wsloputgwu3';
const LOG_ID = 'cmjbv4i3x00003wsloputgwu4';
const CURSOR_SEQUENCE = 42;
const INVALID_ID = 'not-a-cuid';

function makeLog(overrides: Record<string, unknown> = {}) {
  return {
    id: LOG_ID,
    sessionId: SESSION_ID,
    sequenceNumber: 1,
    eventType: 'message',
    content: 'Hello',
    metadata: null,
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeParentSession() {
  return { id: SESSION_ID };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/evaluations/${SESSION_ID}/logs`
  );
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/evaluations/:id/logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Cross-user access (CRITICAL — must be 404, not 403)', () => {
    it('returns 404 when parent session belongs to another user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(null);

      const response = await GET(makeGetRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(404);
      expect(response.status).not.toBe(403);
    });

    it('scopes parent session lookup to session.user.id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(
        makeParentSession() as never
      );
      vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue([]);

      await GET(makeGetRequest(), makeParams(SESSION_ID));

      expect(vi.mocked(prisma.aiEvaluationSession.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: SESSION_ID, userId: ADMIN_ID }),
        })
      );
    });
  });

  describe('Successful log retrieval', () => {
    it('returns 200 with logs array ordered by sequenceNumber ascending', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(
        makeParentSession() as never
      );
      vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue([makeLog()] as never);

      const response = await GET(makeGetRequest(), makeParams(SESSION_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { logs: unknown[] } }>(response);
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data.logs)).toBe(true);
    });

    it('passes orderBy: { sequenceNumber: asc } to findMany', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(
        makeParentSession() as never
      );
      vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue([]);

      await GET(makeGetRequest(), makeParams(SESSION_ID));

      expect(vi.mocked(prisma.aiEvaluationLog.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { sequenceNumber: 'asc' },
        })
      );
    });

    it('passes take: limit to findMany', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(
        makeParentSession() as never
      );
      vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue([]);

      await GET(makeGetRequest({ limit: '25' }), makeParams(SESSION_ID));

      expect(vi.mocked(prisma.aiEvaluationLog.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ take: 25 })
      );
    });

    it('forwards before cursor param into where.sequenceNumber.lt', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(
        makeParentSession() as never
      );
      vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue([]);

      await GET(makeGetRequest({ before: String(CURSOR_SEQUENCE) }), makeParams(SESSION_ID));

      expect(vi.mocked(prisma.aiEvaluationLog.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            sequenceNumber: expect.objectContaining({ lt: CURSOR_SEQUENCE }),
          }),
        })
      );
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when limit exceeds maximum (9999 > 500)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(
        makeParentSession() as never
      );

      const response = await GET(makeGetRequest({ limit: '9999' }), makeParams(SESSION_ID));

      expect(response.status).toBe(400);
    });

    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });
});
