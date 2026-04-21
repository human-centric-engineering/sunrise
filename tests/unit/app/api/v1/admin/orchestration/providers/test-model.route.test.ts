/**
 * Unit Test: POST /api/v1/admin/orchestration/providers/:id/test-model
 *
 * Tests the model-level connection test endpoint.
 *
 * Test Coverage:
 * - Rejects unauthenticated requests (401)
 * - Rejects non-admin users (403)
 * - Validates provider ID (invalid CUID → 422/400)
 * - Validates request body (missing model → 422/400)
 * - Returns 404 for non-existent provider
 * - Success: returns { ok: true, latencyMs, model }
 * - Provider chat failure: returns { ok: false, latencyMs: null, model } (not a 500)
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/providers/[id]/test-model/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/providers/[id]/test-model/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ────────────────────────────────────────────────────────

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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';
const MODEL = 'claude-opus-4-6';

function makeProvider(overrides: Record<string, unknown> = {}) {
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
    timeoutMs: null,
    maxRetries: null,
    createdBy: 'cmjbv4i3x00003wsloputgwul',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

/** Creates a mock provider instance with a working chat method. */
function makeMockProvider(chatImpl?: () => Promise<unknown>) {
  return {
    chat: chatImpl ?? vi.fn().mockResolvedValue({ content: 'Hello!' }),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePostRequest(body: unknown = { model: MODEL }): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/providers/${PROVIDER_ID}/test-model`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/providers/:id/test-model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── Authentication & Authorization ─────────────────────────────────────────

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Assert
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as a non-admin user', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Assert
      expect(response.status).toBe(403);
    });
  });

  // ── Input validation ───────────────────────────────────────────────────────

  describe('Input validation', () => {
    it('returns 4xx for an invalid (non-CUID) provider ID', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await POST(makePostRequest(), makeParams(INVALID_ID));

      // Assert: 400 or 422 for validation failure
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    it('returns 4xx when request body is missing the model field', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);

      // Act: body has no model field
      const response = await POST(makePostRequest({}), makeParams(PROVIDER_ID));

      // Assert
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    it('returns 4xx when model is an empty string', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await POST(makePostRequest({ model: '' }), makeParams(PROVIDER_ID));

      // Assert
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });
  });

  // ── Resource not found ─────────────────────────────────────────────────────

  describe('Resource not found', () => {
    it('returns 404 when the provider does not exist', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

      // Act
      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Assert
      expect(response.status).toBe(404);
    });
  });

  // ── Success ───────────────────────────────────────────────────────────────

  describe('Success', () => {
    it('returns 200 with ok: true, latencyMs number, and model on success', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(getProvider).mockResolvedValue(makeMockProvider() as never);

      // Act
      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Assert
      expect(response.status).toBe(200);
      const body = await parseJson<{
        success: boolean;
        data: { ok: boolean; latencyMs: number; model: string };
      }>(response);
      expect(body.success).toBe(true);
      expect(body.data.ok).toBe(true);
      expect(typeof body.data.latencyMs).toBe('number');
      expect(body.data.latencyMs).toBeGreaterThanOrEqual(0);
      expect(body.data.model).toBe(MODEL);
    });

    it('calls getProvider with the provider slug', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(getProvider).mockResolvedValue(makeMockProvider() as never);

      // Act
      await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Assert: getProvider was called with the provider's slug
      expect(getProvider).toHaveBeenCalledWith('anthropic');
    });

    it('calls provider.chat with the specified model', async () => {
      // Arrange
      const mockChat = vi.fn().mockResolvedValue({ content: 'Hello!' });
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(getProvider).mockResolvedValue({ chat: mockChat } as never);

      // Act
      await POST(makePostRequest({ model: 'gpt-4o' }), makeParams(PROVIDER_ID));

      // Assert: chat called with the requested model
      expect(mockChat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ model: 'gpt-4o' })
      );
    });
  });

  // ── Provider chat failure ──────────────────────────────────────────────────

  describe('Provider chat failure', () => {
    it('returns 200 with ok: false and latencyMs: null when provider.chat throws', async () => {
      // Arrange: the provider exists but .chat() fails
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(getProvider).mockResolvedValue(
        makeMockProvider(() => Promise.reject(new Error('Model not found'))) as never
      );

      // Act
      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Assert: 200 (not a 500) with ok: false
      expect(response.status).toBe(200);
      const body = await parseJson<{
        success: boolean;
        data: { ok: boolean; latencyMs: null; model: string };
      }>(response);
      expect(body.success).toBe(true);
      expect(body.data.ok).toBe(false);
      expect(body.data.latencyMs).toBeNull();
      expect(body.data.model).toBe(MODEL);
    });

    it('returns 200 with ok: false when getProvider itself throws', async () => {
      // Arrange: getProvider() fails (e.g. unknown slug)
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(getProvider).mockRejectedValue(new Error('Unknown provider slug: anthropic'));

      // Act
      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Assert: graceful failure, not a 500
      expect(response.status).toBe(200);
      const body = await parseJson<{ data: { ok: boolean } }>(response);
      expect(body.data.ok).toBe(false);
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    it('returns 429 when the rate limit is exceeded', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      // Act
      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Assert
      expect(response.status).toBe(429);
    });

    it('does not query the database when rate-limited', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      // Act
      await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Assert: DB was not queried
      expect(prisma.aiProviderConfig.findUnique).not.toHaveBeenCalled();
    });
  });
});
