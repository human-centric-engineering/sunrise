/**
 * Integration Test: Admin Orchestration Single Provider (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/providers/:id
 * PATCH  /api/v1/admin/orchestration/providers/:id
 * DELETE /api/v1/admin/orchestration/providers/:id
 *
 * Critical (no-secrets test): PATCH a provider to use an apiKeyEnvVar that
 * points at a known env-var value. Assert the raw secret NEVER appears in the
 * JSON response — only `apiKeyPresent: boolean` is exposed.
 *
 * @see app/api/v1/admin/orchestration/providers/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/providers/[id]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { Prisma } from '@prisma/client';

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
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isApiKeyEnvVarSet: vi.fn(() => false),
  clearCache: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { isApiKeyEnvVarSet, clearCache } from '@/lib/orchestration/llm/provider-manager';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

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
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(method = 'GET', body?: Record<string, unknown>): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body ?? {}),
    url: `http://localhost:3000/api/v1/admin/orchestration/providers/${PROVIDER_ID}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/providers/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns provider with apiKeyPresent field', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);

      const response = await GET(makeRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { id: string; apiKeyPresent: boolean };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(PROVIDER_ID);
      expect(typeof data.data.apiKeyPresent).toBe('boolean');
    });
  });

  describe('Error cases', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });

    it('returns 404 when provider not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(404);
    });
  });
});

describe('PATCH /api/v1/admin/orchestration/providers/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await PATCH(
        makeRequest('PATCH', { name: 'Updated' }),
        makeParams(PROVIDER_ID)
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await PATCH(
        makeRequest('PATCH', { name: 'Updated' }),
        makeParams(PROVIDER_ID)
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on PATCH (mutating route)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(prisma.aiProviderConfig.update).mockResolvedValue(
        makeProvider({ name: 'Updated' }) as never
      );

      await PATCH(makeRequest('PATCH', { name: 'Updated' }), makeParams(PROVIDER_ID));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });

  describe('Successful update', () => {
    it('updates provider and returns 200 with apiKeyPresent field', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(prisma.aiProviderConfig.update).mockResolvedValue(
        makeProvider({ name: 'Updated' }) as never
      );

      const response = await PATCH(
        makeRequest('PATCH', { name: 'Updated' }),
        makeParams(PROVIDER_ID)
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { apiKeyPresent: boolean } }>(
        response
      );
      expect(data.success).toBe(true);
      expect(typeof data.data.apiKeyPresent).toBe('boolean');
    });

    it('clears provider cache after update', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(prisma.aiProviderConfig.update).mockResolvedValue(
        makeProvider({ name: 'Updated' }) as never
      );

      await PATCH(makeRequest('PATCH', { name: 'Updated' }), makeParams(PROVIDER_ID));

      expect(vi.mocked(clearCache)).toHaveBeenCalled();
    });
  });

  describe('No-secrets guarantee', () => {
    it('never returns the raw apiKey value even when apiKeyEnvVar is changed', async () => {
      // Arrange: set a known secret in the process environment
      const secretEnvVar = 'TEST_SECRET_PROVIDER_KEY_XYZ';
      const secretValue = 'super-secret-api-key-value-12345';
      process.env[secretEnvVar] = secretValue;

      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
      const current = makeProvider({ apiKeyEnvVar: 'OLD_KEY' });
      const updated = makeProvider({ apiKeyEnvVar: secretEnvVar });
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(current as never);
      vi.mocked(prisma.aiProviderConfig.update).mockResolvedValue(updated as never);

      // Act: PATCH with the env var name pointing at the secret
      const response = await PATCH(
        makeRequest('PATCH', { apiKeyEnvVar: secretEnvVar }),
        makeParams(PROVIDER_ID)
      );

      // Assert: secret value NEVER appears in any part of the response
      const responseText = await response.text();
      expect(responseText).not.toContain(secretValue);

      // The response should have `apiKeyPresent: boolean` not the raw value
      const data = JSON.parse(responseText) as {
        data: { apiKeyPresent: boolean; apiKeyEnvVar?: string };
      };
      expect(typeof data.data.apiKeyPresent).toBe('boolean');

      // Cleanup
      delete process.env[secretEnvVar];
    });
  });

  describe('Error cases', () => {
    it('returns 404 when provider not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

      const response = await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(PROVIDER_ID));

      expect(response.status).toBe(404);
    });

    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });

    // SSRF guard on PATCH — the update schema runs the same check.
    it.each([
      'http://169.254.169.254/',
      'http://10.0.0.1/',
      'http://127.0.0.1:11434/v1',
      'http://localhost/',
      'file:///etc/passwd',
    ])('returns 400 when PATCH tries to set SSRF-unsafe baseUrl %s', async (baseUrl) => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);

      const response = await PATCH(
        makeRequest('PATCH', { baseUrl, isLocal: false }),
        makeParams(PROVIDER_ID)
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for P2002 slug/name conflict on PATCH', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiProviderConfig.update).mockRejectedValue(p2002);

      const response = await PATCH(
        makeRequest('PATCH', { slug: 'existing-slug' }),
        makeParams(PROVIDER_ID)
      );

      expect(response.status).toBe(400);
    });
  });
});

describe('DELETE /api/v1/admin/orchestration/providers/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(makeRequest('DELETE'), makeParams(PROVIDER_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(makeRequest('DELETE'), makeParams(PROVIDER_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful soft delete', () => {
    it('sets isActive to false and returns success', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(prisma.aiProviderConfig.update).mockResolvedValue(
        makeProvider({ isActive: false }) as never
      );

      const response = await DELETE(makeRequest('DELETE'), makeParams(PROVIDER_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string; isActive: boolean } }>(
        response
      );
      expect(data.success).toBe(true);
      expect(data.data.isActive).toBe(false);

      expect(vi.mocked(prisma.aiProviderConfig.update)).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } })
      );
    });

    it('clears provider cache after soft delete', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(prisma.aiProviderConfig.update).mockResolvedValue(
        makeProvider({ isActive: false }) as never
      );

      await DELETE(makeRequest('DELETE'), makeParams(PROVIDER_ID));

      expect(vi.mocked(clearCache)).toHaveBeenCalledWith('anthropic');
    });
  });

  describe('Error cases', () => {
    it('returns 404 when provider not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

      const response = await DELETE(makeRequest('DELETE'), makeParams(PROVIDER_ID));

      expect(response.status).toBe(404);
    });

    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await DELETE(makeRequest('DELETE'), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });
});
