/**
 * Unit Test: Embedding Status API
 *
 * GET /api/v1/admin/orchestration/knowledge/embedding-status
 *
 * Returns chunk embedding progress and whether an active provider exists.
 *
 * @see app/api/v1/admin/orchestration/knowledge/embedding-status/route.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/embedding-status/route';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Mock dependencies ──────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

// `hasActiveProvider` is answered by running the embedding resolver rather than
// by counting rows (see the route). That is a wider dependency surface than the
// single `findFirst` this file used to need — deliberately, because the row
// count and the resolver stopped agreeing once the embedding chain started
// consulting the provider-eligibility rule.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeChunk: { count: vi.fn() },
    aiProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() },
    aiOrchestrationSettings: { findFirst: vi.fn() },
    aiProviderModel: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(async () => 'text-embedding-3-small'),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  registerProviderEligibility,
  resetProviderEligibility,
} from '@/lib/orchestration/llm/provider-eligibility';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest(
    'http://localhost:3000/api/v1/admin/orchestration/knowledge/embedding-status',
    { method: 'GET' }
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/embedding-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeChunk.count).mockResolvedValue(100);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: BigInt(80) }] as never);
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue({ id: 'prov-1' } as never);
    // The resolver's own reads: no operator pin, one usable provider row.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      {
        id: 'prov-1',
        slug: 'together',
        providerType: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnvVar: null,
        isLocal: false,
        isActive: true,
      },
    ] as never);
    resetProviderEligibility();
  });

  afterEach(() => {
    resetProviderEligibility();
  });

  it('returns embedding status with counts', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(100);
    expect(body.data.embedded).toBe(80);
    expect(body.data.pending).toBe(20);
    expect(body.data.hasActiveProvider).toBe(true);
  });

  it('reports hasActiveProvider true when only OPENAI_API_KEY is set', async () => {
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
    const originalEnv = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-test';

    try {
      const res = await GET(makeRequest());
      const body = await res.json();
      expect(body.data.hasActiveProvider).toBe(true);
    } finally {
      if (originalEnv === undefined) {
        delete process.env['OPENAI_API_KEY'];
      } else {
        process.env['OPENAI_API_KEY'] = originalEnv;
      }
    }
  });

  it('reports hasActiveProvider false when no provider and no env key', async () => {
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
    const originalEnv = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    try {
      const res = await GET(makeRequest());
      const body = await res.json();
      expect(body.data.hasActiveProvider).toBe(false);
    } finally {
      if (originalEnv !== undefined) {
        process.env['OPENAI_API_KEY'] = originalEnv;
      }
    }
  });

  it('reports hasActiveProvider false when the eligibility rule refuses every provider', async () => {
    // Arrange: a provider row exists — the exact state the old row-count check
    // called "available" — but the app's rule permits nothing.
    registerProviderEligibility(() => []);

    // Act
    const res = await GET(makeRequest());
    const body = await res.json();

    // Assert: the admin UI gates "Generate Embeddings" on this field, so a
    // `true` here is an enabled button for a run that cannot succeed.
    expect(body.data.hasActiveProvider).toBe(false);
  });

  it('handles empty query result safely (null-safe count)', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.data.embedded).toBe(0);
    expect(body.data.pending).toBe(100);
  });

  it('rejects unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });
});
