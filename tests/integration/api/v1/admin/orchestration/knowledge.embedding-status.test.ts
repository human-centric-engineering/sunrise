/**
 * Integration Test: Admin Orchestration — Embedding Status
 *
 * GET /api/v1/admin/orchestration/knowledge/embedding-status
 *
 * @see app/api/v1/admin/orchestration/knowledge/embedding-status/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limiting enforced by proxy.ts (orchestration tier)
 * - Returns correct counts: total, embedded, pending
 * - hasActiveProvider: true when an active aiProviderConfig row RESOLVES
 *   (the route runs the embedding resolver rather than counting rows, so a row
 *   the app's eligibility rule refuses does not count as available)
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

// `hasActiveProvider` is answered by running the embedding resolver, not by
// counting rows — see the route. Hence the resolver's own reads below.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeChunk: {
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
    aiProviderConfig: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    aiOrchestrationSettings: { findFirst: vi.fn() },
    aiProviderModel: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(async () => 'text-embedding-3-small'),
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
    // Default: no env key
    delete process.env['OPENAI_API_KEY'];
    // Resolver baseline: no operator pin, no provider rows. Each test below
    // sets the rows it needs.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
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

  describe('Successful status response', () => {
    it('returns correct counts and hasActiveProvider: true when provider row exists', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiKnowledgeChunk.count).mockResolvedValue(10);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 4n }] as never);
      vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue({ id: 'p1' } as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
        {
          id: 'p1',
          slug: 'together',
          providerType: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKeyEnvVar: null,
          isLocal: false,
          isActive: true,
        },
      ] as never);

      const response = await GET(makeRequest());
      const body = await parseJson<{ success: boolean; data: StatusResponseData }>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(body.success).toBe(true);
      expect(body.data.total).toBe(10);
      expect(body.data.embedded).toBe(4);
      expect(body.data.pending).toBe(6);
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
