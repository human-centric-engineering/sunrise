/**
 * Integration Test: Admin Orchestration — Pattern Detail
 *
 * GET /api/v1/admin/orchestration/knowledge/patterns/[number]
 *
 * @see app/api/v1/admin/orchestration/knowledge/patterns/[number]/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Non-numeric pattern number param returns 400
 * - Empty chunks array returns 404 (pattern not found)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/patterns/[number]/route';
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

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  getPatternDetail: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { getPatternDetail } from '@/lib/orchestration/knowledge/search';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePatternDetail(patternNumber = 4) {
  return {
    patternNumber,
    chunks: [
      {
        id: 'cmjbv4i3x00003wsloputgwul',
        chunkType: 'pattern',
        patternNumber,
        section: 'overview',
        content: 'Parallelization enables concurrent agent execution.',
      },
      {
        id: 'cmjbv4i3x00003wsloputgwu2',
        chunkType: 'pattern',
        patternNumber,
        section: 'examples',
        content: 'Use fan-out patterns for independent sub-tasks.',
      },
    ],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(number: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/patterns/${number}`
  );
}

function makeParams(number: string) {
  return { params: Promise.resolve({ number }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/patterns/:number', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest('4'), makeParams('4'));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest('4'), makeParams('4'));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns 200 with pattern detail including chunks', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getPatternDetail).mockResolvedValue(makePatternDetail(4) as never);

      const response = await GET(makeGetRequest('4'), makeParams('4'));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { patternNumber: number; chunks: unknown[] };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.patternNumber).toBe(4);
      expect(data.data.chunks).toHaveLength(2);
    });

    it('calls getPatternDetail with coerced integer', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getPatternDetail).mockResolvedValue(makePatternDetail(1) as never);

      await GET(makeGetRequest('1'), makeParams('1'));

      expect(vi.mocked(getPatternDetail)).toHaveBeenCalledWith(1);
    });
  });

  describe('Error cases', () => {
    it('returns 404 when getPatternDetail returns null', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getPatternDetail).mockResolvedValue(null as never);

      const response = await GET(makeGetRequest('99'), makeParams('99'));

      expect(response.status).toBe(404);
    });

    it('returns 404 when getPatternDetail returns empty chunks array', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getPatternDetail).mockResolvedValue({ patternNumber: 99, chunks: [] } as never);

      const response = await GET(makeGetRequest('99'), makeParams('99'));

      expect(response.status).toBe(404);
    });

    it('returns 400 when pattern number is not a valid integer (letters)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest('abc'), makeParams('abc'));

      expect(response.status).toBe(400);
    });

    it('returns 400 when pattern number is zero', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest('0'), makeParams('0'));

      expect(response.status).toBe(400);
    });

    it('returns 400 when pattern number is negative', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest('-1'), makeParams('-1'));

      expect(response.status).toBe(400);
    });
  });
});
