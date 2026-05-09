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
      delete: vi.fn(),
    },
    aiAgent: {
      count: vi.fn(),
    },
    aiCostLog: {
      count: vi.fn(),
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

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
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
    timeoutMs: null,
    maxRetries: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(
  method = 'GET',
  body?: Record<string, unknown>,
  query?: Record<string, string>
): NextRequest {
  const url = new URL(`http://localhost:3000/api/v1/admin/orchestration/providers/${PROVIDER_ID}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body ?? {}),
    url: url.toString(),
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
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

    it('returns 429 when rate limit exceeded on PATCH', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await PATCH(
        makeRequest('PATCH', { name: 'Updated' }),
        makeParams(PROVIDER_ID)
      );

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.aiProviderConfig.findUnique)).not.toHaveBeenCalled();
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(typeof data.data.apiKeyPresent).toBe('boolean');
    });

    it('updates all optional fields in a single payload', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(prisma.aiProviderConfig.update).mockResolvedValue(makeProvider() as never);

      const fullPayload = {
        name: 'New Name',
        slug: 'new-slug',
        providerType: 'openai-compatible' as const,
        baseUrl: 'https://api.example.com',
        apiKeyEnvVar: 'NEW_KEY_ENV',
        isLocal: false,
        isActive: false,
        metadata: { team: 'platform' },
      };

      await PATCH(makeRequest('PATCH', fullPayload), makeParams(PROVIDER_ID));

      const updateCall = vi.mocked(prisma.aiProviderConfig.update).mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        name: 'New Name',
        slug: 'new-slug',
        providerType: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        apiKeyEnvVar: 'NEW_KEY_ENV',
        isLocal: false,
        isActive: false,
        metadata: { team: 'platform' },
      });
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

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded on DELETE', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await DELETE(makeRequest('DELETE'), makeParams(PROVIDER_ID));

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.aiProviderConfig.findUnique)).not.toHaveBeenCalled();
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
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

describe('DELETE /api/v1/admin/orchestration/providers/:id?permanent=true', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    // Default to "no references found" — individual tests override.
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);
    vi.mocked(prisma.aiCostLog.count).mockResolvedValue(0);
  });

  it('hard-deletes when no agents or cost logs reference the slug', async () => {
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
    vi.mocked(prisma.aiProviderConfig.delete).mockResolvedValue(makeProvider() as never);

    const response = await DELETE(
      makeRequest('DELETE', undefined, { permanent: 'true' }),
      makeParams(PROVIDER_ID)
    );

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: { deleted: boolean; permanent: boolean };
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data.deleted).toBe(true);
    expect(data.data.permanent).toBe(true);

    // Real delete, NOT update.
    expect(prisma.aiProviderConfig.delete).toHaveBeenCalledWith({ where: { id: PROVIDER_ID } });
    expect(prisma.aiProviderConfig.update).not.toHaveBeenCalled();

    // Reference checks ran against both agent paths and cost log.
    expect(prisma.aiAgent.count).toHaveBeenCalledWith({ where: { provider: 'anthropic' } });
    expect(prisma.aiAgent.count).toHaveBeenCalledWith({
      where: { fallbackProviders: { has: 'anthropic' } },
    });
    expect(prisma.aiCostLog.count).toHaveBeenCalledWith({ where: { provider: 'anthropic' } });
  });

  it('returns 409 when agents reference the slug as primary provider', async () => {
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
    vi.mocked(prisma.aiAgent.count)
      .mockResolvedValueOnce(3) // primary provider count
      .mockResolvedValueOnce(0); // fallback count

    const response = await DELETE(
      makeRequest('DELETE', undefined, { permanent: 'true' }),
      makeParams(PROVIDER_ID)
    );

    expect(response.status).toBe(409);
    const data = await parseJson<{
      success: boolean;
      error: { code: string; message: string; details?: unknown };
    }>(response);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('CONFLICT');
    expect(data.error.message).toMatch(/3 agents/i);

    // Refused — no actual delete or update happened.
    expect(prisma.aiProviderConfig.delete).not.toHaveBeenCalled();
    expect(prisma.aiProviderConfig.update).not.toHaveBeenCalled();
  });

  it('returns 409 when agents reference the slug as a fallback', async () => {
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
    vi.mocked(prisma.aiAgent.count)
      .mockResolvedValueOnce(0) // primary
      .mockResolvedValueOnce(2); // fallback

    const response = await DELETE(
      makeRequest('DELETE', undefined, { permanent: 'true' }),
      makeParams(PROVIDER_ID)
    );

    expect(response.status).toBe(409);
    const data = await parseJson<{
      success: boolean;
      error: { code: string; message: string };
    }>(response);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('CONFLICT');
    expect(prisma.aiProviderConfig.delete).not.toHaveBeenCalled();
  });

  it('returns 409 when cost log rows reference the slug', async () => {
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
    vi.mocked(prisma.aiCostLog.count).mockResolvedValue(42);

    const response = await DELETE(
      makeRequest('DELETE', undefined, { permanent: 'true' }),
      makeParams(PROVIDER_ID)
    );

    expect(response.status).toBe(409);
    const data = await parseJson<{
      success: boolean;
      error: { code: string; message: string };
    }>(response);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('CONFLICT');
    expect(data.error.message).toMatch(/42 cost log/i);
    expect(prisma.aiProviderConfig.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when the provider does not exist', async () => {
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

    const response = await DELETE(
      makeRequest('DELETE', undefined, { permanent: 'true' }),
      makeParams(PROVIDER_ID)
    );

    expect(response.status).toBe(404);
    expect(prisma.aiAgent.count).not.toHaveBeenCalled();
  });

  it('clears the provider cache after a successful permanent delete', async () => {
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
    vi.mocked(prisma.aiProviderConfig.delete).mockResolvedValue(makeProvider() as never);

    await DELETE(makeRequest('DELETE', undefined, { permanent: 'true' }), makeParams(PROVIDER_ID));

    expect(clearCache).toHaveBeenCalledWith('anthropic');
  });

  it('soft-deletes (not hard) when permanent param is missing or false', async () => {
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
    vi.mocked(prisma.aiProviderConfig.update).mockResolvedValue(
      makeProvider({ isActive: false }) as never
    );

    // Without ?permanent=true → soft-delete branch, no reference checks.
    const response = await DELETE(makeRequest('DELETE'), makeParams(PROVIDER_ID));

    expect(response.status).toBe(200);
    expect(prisma.aiProviderConfig.delete).not.toHaveBeenCalled();
    expect(prisma.aiProviderConfig.update).toHaveBeenCalled();
    expect(prisma.aiAgent.count).not.toHaveBeenCalled();
  });
});
