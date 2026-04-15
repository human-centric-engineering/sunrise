/**
 * Integration Test: Admin Orchestration — Embedding Models
 *
 * GET /api/v1/admin/orchestration/embedding-models
 *
 * Tests the full request lifecycle including authentication, rate limiting,
 * query parameter parsing, and filtered catalogue responses.
 *
 * Key assertions:
 *   - Admin auth required (401 unauthenticated, 403 non-admin)
 *   - Rate limited via adminLimiter
 *   - No params → all 9 models returned
 *   - schemaCompatibleOnly=true → only schema-compatible models
 *   - hasFreeTier=true → only free-tier models
 *   - local=true → only local models
 *   - local=false → only cloud models
 *   - Combined filters work correctly
 *   - Response uses standard { success: true, data: [...] } format
 *
 * @see app/api/v1/admin/orchestration/embedding-models/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/embedding-models/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import type { EmbeddingModelInfo } from '@/lib/orchestration/llm/embedding-models';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/embedding-models');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/orchestration/embedding-models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ─── Authentication & Authorization ───────────────────────────────────────

  describe('Authentication & Authorization', () => {
    it('should return 401 when the request is unauthenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await GET(makeGetRequest());

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 403 when authenticated as a non-admin user', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await GET(makeGetRequest());

      // Assert
      expect(response.status).toBe(403);
    });

    it('should return 200 when authenticated as an admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest());

      // Assert
      expect(response.status).toBe(200);
    });
  });

  // ─── Rate Limiting ────────────────────────────────────────────────────────

  describe('Rate Limiting', () => {
    it('should call adminLimiter.check on every request', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      await GET(makeGetRequest());

      // Assert
      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });

    it('should return 429 when the rate limit is exceeded', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      // Act
      const response = await GET(makeGetRequest());

      // Assert
      expect(response.status).toBe(429);
    });
  });

  // ─── Response Format ──────────────────────────────────────────────────────

  describe('Response format', () => {
    it('should return a standard success response envelope', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest());
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('should return objects with the expected EmbeddingModelInfo fields', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest());
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert: every item must have the core fields
      for (const model of body.data) {
        expect(typeof model.id).toBe('string');
        expect(typeof model.name).toBe('string');
        expect(typeof model.provider).toBe('string');
        expect(typeof model.model).toBe('string');
        expect(typeof model.dimensions).toBe('number');
        expect(typeof model.schemaCompatible).toBe('boolean');
        expect(typeof model.hasFreeTier).toBe('boolean');
        expect(typeof model.local).toBe('boolean');
        expect(typeof model.costPerMillionTokens).toBe('number');
      }
    });
  });

  // ─── No query params → all models ────────────────────────────────────────

  describe('GET without query parameters', () => {
    it('should return all 9 models when no filters are provided', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest());
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      expect(body.data).toHaveLength(9);
    });

    it('should include models from all providers', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest());
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert: at least the six provider brands are present
      const providers = new Set(body.data.map((m) => m.provider));
      expect(providers.has('Voyage AI')).toBe(true);
      expect(providers.has('OpenAI')).toBe(true);
      expect(providers.has('Cohere')).toBe(true);
      expect(providers.has('Google')).toBe(true);
      expect(providers.has('Mistral')).toBe(true);
      expect(providers.has('Ollama')).toBe(true);
    });
  });

  // ─── schemaCompatibleOnly filter ──────────────────────────────────────────

  describe('GET ?schemaCompatibleOnly=true', () => {
    it('should return only schema-compatible models', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ schemaCompatibleOnly: 'true' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.data.length).toBeGreaterThan(0);
      for (const model of body.data) {
        expect(model.schemaCompatible).toBe(true);
      }
    });

    it('should return fewer models than the unfiltered set', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const allResponse = await GET(makeGetRequest());
      const filteredResponse = await GET(makeGetRequest({ schemaCompatibleOnly: 'true' }));
      const allBody = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(allResponse);
      const filteredBody = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(filteredResponse);

      // Assert
      expect(filteredBody.data.length).toBeLessThan(allBody.data.length);
    });

    it('should include voyage-3 and OpenAI embedding models', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ schemaCompatibleOnly: 'true' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert: known schema-compatible models
      const ids = body.data.map((m) => m.id);
      expect(ids).toContain('voyage/voyage-3');
      expect(ids).toContain('openai/text-embedding-3-small');
      expect(ids).toContain('openai/text-embedding-3-large');
    });

    it('should exclude Ollama models (not schema-compatible)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ schemaCompatibleOnly: 'true' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      const providers = body.data.map((m) => m.provider);
      expect(providers).not.toContain('Ollama');
    });

    it('should treat schemaCompatibleOnly=false as no filter (return all)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ schemaCompatibleOnly: 'false' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert: same as no filter
      expect(body.data).toHaveLength(9);
    });
  });

  // ─── hasFreeTier filter ───────────────────────────────────────────────────

  describe('GET ?hasFreeTier=true', () => {
    it('should return only models with a free tier', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ hasFreeTier: 'true' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.data.length).toBeGreaterThan(0);
      for (const model of body.data) {
        expect(model.hasFreeTier).toBe(true);
      }
    });

    it('should include Voyage (free tier) and Ollama (free) models', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ hasFreeTier: 'true' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      const ids = body.data.map((m) => m.id);
      expect(ids).toContain('voyage/voyage-3');
      expect(ids).toContain('ollama/nomic-embed-text');
    });

    it('should treat hasFreeTier=false as no filter (return all)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ hasFreeTier: 'false' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      expect(body.data).toHaveLength(9);
    });
  });

  // ─── local filter ─────────────────────────────────────────────────────────

  describe('GET ?local=true', () => {
    it('should return only local models', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ local: 'true' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.data.length).toBeGreaterThan(0);
      for (const model of body.data) {
        expect(model.local).toBe(true);
      }
    });

    it('should return only Ollama models (the only local provider)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ local: 'true' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      const providers = body.data.map((m) => m.provider);
      for (const p of providers) {
        expect(p).toBe('Ollama');
      }
    });
  });

  describe('GET ?local=false', () => {
    it('should return only cloud models', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ local: 'false' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.data.length).toBeGreaterThan(0);
      for (const model of body.data) {
        expect(model.local).toBe(false);
      }
    });

    it('should not include Ollama models when local=false', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest({ local: 'false' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      const providers = body.data.map((m) => m.provider);
      expect(providers).not.toContain('Ollama');
    });
  });

  describe('GET without explicit local param', () => {
    it('should return all models when local param is absent (no filtering)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act: no local param in URL
      const response = await GET(makeGetRequest());
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert: both local and non-local models present
      const hasLocal = body.data.some((m) => m.local);
      const hasCloud = body.data.some((m) => !m.local);
      expect(hasLocal).toBe(true);
      expect(hasCloud).toBe(true);
    });
  });

  // ─── Combined filters ─────────────────────────────────────────────────────

  describe('GET with combined filters', () => {
    it('should apply schemaCompatibleOnly + hasFreeTier together', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(
        makeGetRequest({ schemaCompatibleOnly: 'true', hasFreeTier: 'true' })
      );
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert: every result satisfies both constraints
      expect(response.status).toBe(200);
      expect(body.data.length).toBeGreaterThan(0);
      for (const model of body.data) {
        expect(model.schemaCompatible).toBe(true);
        expect(model.hasFreeTier).toBe(true);
      }
    });

    it('should return no models for schemaCompatibleOnly + local=true (no compatible local models)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act: impossible intersection in current catalogue
      const response = await GET(makeGetRequest({ schemaCompatibleOnly: 'true', local: 'true' }));
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(0);
    });

    it('should apply all three filters simultaneously', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(
        makeGetRequest({
          schemaCompatibleOnly: 'true',
          hasFreeTier: 'true',
          local: 'false',
        })
      );
      const body = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(response);

      // Assert: every result must satisfy all three
      expect(response.status).toBe(200);
      expect(body.data.length).toBeGreaterThan(0);
      for (const model of body.data) {
        expect(model.schemaCompatible).toBe(true);
        expect(model.hasFreeTier).toBe(true);
        expect(model.local).toBe(false);
      }

      // voyage-3 is the primary candidate matching all three
      const ids = body.data.map((m) => m.id);
      expect(ids).toContain('voyage/voyage-3');
    });

    it('should return a response with fewer items when more filters are applied', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const allResponse = await GET(makeGetRequest());
      const filteredResponse = await GET(
        makeGetRequest({ schemaCompatibleOnly: 'true', hasFreeTier: 'true' })
      );

      const allBody = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(allResponse);
      const filteredBody = await parseJson<ApiResponse<EmbeddingModelInfo[]>>(filteredResponse);

      // Assert: combined filters produce a strict subset
      expect(filteredBody.data.length).toBeLessThan(allBody.data.length);
    });
  });
});
