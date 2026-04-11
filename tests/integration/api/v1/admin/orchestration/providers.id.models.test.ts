/**
 * Integration Test: Per-provider live model listing
 *
 * GET /api/v1/admin/orchestration/providers/:id/models
 *
 * Key behaviours:
 *   - Returns the provider's live model list via getProvider(slug).listModels()
 *   - Returns 503 when listModels() throws (provider unreachable)
 *
 * @see app/api/v1/admin/orchestration/providers/[id]/models/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/providers/[id]/models/route';
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
    aiProviderConfig: {
      findUnique: vi.fn(),
    },
  },
}));

const mockListModels = vi.fn();

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(() => Promise.resolve({ listModels: mockListModels })),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeProviderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER_ID,
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    baseUrl: null,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    isLocal: false,
    isActive: true,
    metadata: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/providers/${PROVIDER_ID}/models`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/providers/:id/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('CUID validation', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });

  describe('Provider lookup', () => {
    it('returns 404 when provider row not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(404);
    });
  });

  describe('Successful model listing', () => {
    it('returns provider models list', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      mockListModels.mockResolvedValue(['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307']);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { providerId: string; slug: string; models: string[] };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.providerId).toBe(PROVIDER_ID);
      expect(data.data.slug).toBe('anthropic');
      expect(data.data.models).toContain('claude-3-5-sonnet-20241022');
    });

    it('calls getProvider with the provider slug from the database row', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      mockListModels.mockResolvedValue([]);

      await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(vi.mocked(getProvider)).toHaveBeenCalledWith('anthropic');
    });
  });

  describe('Provider unavailable', () => {
    it('returns 503 when listModels throws', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      mockListModels.mockRejectedValue(
        new Error('ECONNREFUSED 10.0.0.1:8080 internal-hostname.corp')
      );

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(503);
      const data = await parseJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('PROVIDER_UNAVAILABLE');
      // The raw SDK error must NOT leak through — it would be a
      // blind-SSRF exfiltration oracle for the configured baseUrl.
      expect(data.error.message).not.toContain('10.0.0.1');
      expect(data.error.message).not.toContain('internal-hostname');
      expect(data.error.message).not.toContain('ECONNREFUSED');
    });

    it('returns 503 when getProvider throws', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      vi.mocked(getProvider).mockRejectedValue(new Error('Provider not found'));

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(503);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('PROVIDER_UNAVAILABLE');
    });
  });
});
