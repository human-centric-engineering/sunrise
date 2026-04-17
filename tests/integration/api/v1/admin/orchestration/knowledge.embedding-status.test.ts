/**
 * Integration Test: Admin Orchestration — Embedding Status
 *
 * GET /api/v1/admin/orchestration/knowledge/embedding-status
 *
 * @see app/api/v1/admin/orchestration/knowledge/embedding-status/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Returns correct counts: total, embedded, pending
 * - hasActiveProvider: true when active aiProviderConfig row exists
 * - hasActiveProvider: true via OPENAI_API_KEY env fallback
 * - hasActiveProvider: false when no provider and no env key
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/embedding-status/route';
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
    aiKnowledgeChunk: {
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
    aiProviderConfig: {
      findFirst: vi.fn(),
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/embedding-status',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

interface StatusResponseData {
  total: number;
  embedded: number;
  pending: number;
  hasActiveProvider: boolean;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/embedding-status', () => {
  const originalOpenAiKey = process.env['OPENAI_API_KEY'];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    // Default: no env key
    delete process.env['OPENAI_API_KEY'];
  });

  afterEach(() => {
    // Restore original env key
    if (originalOpenAiKey !== undefined) {
      process.env['OPENAI_API_KEY'] = originalOpenAiKey;
    } else {
      delete process.env['OPENAI_API_KEY'];
    }
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await GET(makeRequest());

      expect(response.status).toBe(429);
    });
  });

  describe('Successful status response', () => {
    it('returns correct counts and hasActiveProvider: true when provider row exists', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeChunk.count).mockResolvedValue(10);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 4n }] as never);
      vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue({ id: 'p1' } as never);

      const response = await GET(makeRequest());
      const body = await parseJson<{ success: boolean; data: StatusResponseData }>(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.total).toBe(10);
      expect(body.data.embedded).toBe(4);
      expect(body.data.pending).toBe(6);
      expect(body.data.hasActiveProvider).toBe(true);
    });

    it('returns hasActiveProvider: true via OPENAI_API_KEY env fallback when no provider row', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeChunk.count).mockResolvedValue(0);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 0n }] as never);
      vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(null);
      process.env['OPENAI_API_KEY'] = 'sk-test';

      const response = await GET(makeRequest());
      const body = await parseJson<{ success: boolean; data: StatusResponseData }>(response);

      expect(response.status).toBe(200);
      expect(body.data.hasActiveProvider).toBe(true);
    });

    it('returns hasActiveProvider: false when no provider row and no env key', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeChunk.count).mockResolvedValue(3);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 1n }] as never);
      vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(null);
      // OPENAI_API_KEY is deleted in beforeEach

      const response = await GET(makeRequest());
      const body = await parseJson<{ success: boolean; data: StatusResponseData }>(response);

      expect(response.status).toBe(200);
      expect(body.data.hasActiveProvider).toBe(false);
      expect(body.data.total).toBe(3);
      expect(body.data.embedded).toBe(1);
      expect(body.data.pending).toBe(2);
    });
  });
});
