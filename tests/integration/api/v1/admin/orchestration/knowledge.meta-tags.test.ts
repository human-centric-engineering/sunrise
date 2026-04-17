/**
 * Integration Test: Admin Orchestration — Knowledge Meta-Tags
 *
 * GET /api/v1/admin/orchestration/knowledge/meta-tags
 *
 * @see app/api/v1/admin/orchestration/knowledge/meta-tags/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Returns categories and keywords with counts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/meta-tags/route';
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

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  listMetaTags: vi.fn(),
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
import { listMetaTags } from '@/lib/orchestration/knowledge/document-manager';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/meta-tags',
  } as unknown as NextRequest;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/meta-tags', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 for unauthenticated users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());

    const response = await GET(makeRequest());
    expect(response.status).toBe(403);
  });

  // ── Rate limiting ────────────────────────────────────────────────────────

  it('returns 429 when rate limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await GET(makeRequest());
    expect(response.status).toBe(429);
  });

  // ── Success ──────────────────────────────────────────────────────────────

  it('returns meta-tags grouped by scope', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(listMetaTags).mockResolvedValue({
      app: {
        categories: [
          { value: 'sales', chunkCount: 15, documentCount: 3 },
          { value: 'engineering', chunkCount: 8, documentCount: 2 },
        ],
        keywords: [{ value: 'pricing', chunkCount: 5, documentCount: 1 }],
      },
      system: {
        categories: [{ value: 'patterns', chunkCount: 20, documentCount: 1 }],
        keywords: [],
      },
    });

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: {
        app: {
          categories: Array<{ value: string; chunkCount: number; documentCount: number }>;
          keywords: Array<{ value: string; chunkCount: number; documentCount: number }>;
        };
        system: {
          categories: Array<{ value: string; chunkCount: number; documentCount: number }>;
          keywords: Array<{ value: string; chunkCount: number; documentCount: number }>;
        };
      };
    };
    expect(body.data.app.categories).toHaveLength(2);
    expect(body.data.app.categories[0].value).toBe('sales');
    expect(body.data.app.keywords).toHaveLength(1);
    expect(body.data.system.categories).toHaveLength(1);
  });

  it('returns empty scopes when no meta-tags exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(listMetaTags).mockResolvedValue({
      app: { categories: [], keywords: [] },
      system: { categories: [], keywords: [] },
    });

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: {
        app: { categories: unknown[]; keywords: unknown[] };
        system: { categories: unknown[]; keywords: unknown[] };
      };
    };
    expect(body.data.app.categories).toHaveLength(0);
    expect(body.data.system.keywords).toHaveLength(0);
  });
});
