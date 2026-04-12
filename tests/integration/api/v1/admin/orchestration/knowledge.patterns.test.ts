/**
 * Integration Test: Admin Orchestration — Pattern list endpoint
 *
 * GET /api/v1/admin/orchestration/knowledge/patterns
 *
 * @see app/api/v1/admin/orchestration/knowledge/patterns/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/patterns/route';
import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  listPatterns: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { listPatterns } from '@/lib/orchestration/knowledge/search';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_PATTERNS = [
  {
    patternNumber: 1,
    patternName: 'Chain of Thought',
    category: 'Reasoning',
    complexity: 'beginner',
    description: 'Step-by-step reasoning.',
    chunkCount: 5,
  },
  {
    patternNumber: 2,
    patternName: 'ReAct',
    category: 'Action',
    complexity: 'intermediate',
    description: 'Reasoning + acting.',
    chunkCount: 3,
  },
];

function makeRequest() {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/knowledge/patterns');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/patterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 for unauthenticated users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns pattern list for admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(listPatterns).mockResolvedValue(MOCK_PATTERNS);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].patternName).toBe('Chain of Thought');
    expect(body.data[1].patternName).toBe('ReAct');
  });

  it('returns empty array when no patterns exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(listPatterns).mockResolvedValue([]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(0);
  });
});
