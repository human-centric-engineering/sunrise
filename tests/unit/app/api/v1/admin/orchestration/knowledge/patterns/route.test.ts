/**
 * Unit Tests: Pattern List & Detail API Routes
 *
 * GET /api/v1/admin/orchestration/knowledge/patterns
 * GET /api/v1/admin/orchestration/knowledge/patterns/:number
 *
 * @see app/api/v1/admin/orchestration/knowledge/patterns/route.ts
 * @see app/api/v1/admin/orchestration/knowledge/patterns/[number]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Mock dependencies ──────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  listPatterns: vi.fn(),
  getPatternDetail: vi.fn(),
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

import { GET as ListPatterns } from '@/app/api/v1/admin/orchestration/knowledge/patterns/route';
import { GET as GetPattern } from '@/app/api/v1/admin/orchestration/knowledge/patterns/[number]/route';
import { auth } from '@/lib/auth/config';
import { listPatterns, getPatternDetail } from '@/lib/orchestration/knowledge/search';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeListRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/knowledge/patterns', {
    method: 'GET',
  });
}

function makeDetailRequest(num: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/patterns/${num}`,
    { method: 'GET' }
  );
}

function callGetPattern(num: string) {
  return (GetPattern as (...args: unknown[]) => Promise<Response>)(makeDetailRequest(num), {
    params: Promise.resolve({ number: num }),
  });
}

// ─── Tests: Pattern List ────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/patterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
  });

  it('returns pattern summaries', async () => {
    vi.mocked(listPatterns).mockResolvedValue([
      {
        patternNumber: 1,
        patternName: 'Chain',
        category: 'Reasoning',
        complexity: 'beginner',
        description: 'Step-by-step.',
        chunkCount: 5,
      },
    ]);

    const res = await ListPatterns(makeListRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].patternName).toBe('Chain');
  });

  it('returns empty array when no patterns exist', async () => {
    vi.mocked(listPatterns).mockResolvedValue([]);

    const res = await ListPatterns(makeListRequest());
    const body = await res.json();

    expect(body.data).toEqual([]);
  });

  it('rejects unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

    const res = await ListPatterns(makeListRequest());
    expect(res.status).toBe(401);
  });
});

// ─── Tests: Pattern Detail ──────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/patterns/:number', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
  });

  it('returns pattern detail for a valid number', async () => {
    vi.mocked(getPatternDetail).mockResolvedValue({
      patternName: 'Chain',
      chunks: [
        {
          id: 'c1',
          chunkKey: 'p1-overview',
          documentId: 'doc-1',
          content: 'Overview content',
          chunkType: 'pattern_overview',
          patternNumber: 1,
          patternName: 'Chain',
          category: 'Reasoning',
          section: 'overview',
          keywords: null,
          estimatedTokens: 50,
          embeddingModel: null,
          embeddingProvider: null,
          embeddedAt: null,
          metadata: null,
        },
      ],
      totalTokens: 50,
    });

    const res = await callGetPattern('1');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.patternName).toBe('Chain');
    expect(body.data.chunks).toHaveLength(1);
  });

  it('returns 404 when pattern does not exist', async () => {
    vi.mocked(getPatternDetail).mockResolvedValue({
      patternName: null,
      chunks: [],
      totalTokens: 0,
    });

    const res = await callGetPattern('999');

    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric pattern number', async () => {
    const res = await callGetPattern('abc');

    expect(res.status).toBe(400);
  });

  it('returns 400 for negative pattern number', async () => {
    const res = await callGetPattern('-1');

    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

    const res = await callGetPattern('1');

    expect(res.status).toBe(401);
  });
});
