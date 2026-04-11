/**
 * Integration Test: Admin Orchestration Providers (list + create)
 *
 * GET  /api/v1/admin/orchestration/providers
 * POST /api/v1/admin/orchestration/providers
 *
 * Key assertions:
 *   - GET response includes `apiKeyPresent: boolean` (never the raw env-var value)
 *   - POST creates a provider row and returns 201
 *   - Slug/name conflict → 409
 *
 * @see app/api/v1/admin/orchestration/providers/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/providers/route';
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
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
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
import { isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

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

const VALID_PROVIDER = {
  name: 'Anthropic',
  slug: 'anthropic',
  providerType: 'anthropic',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  isLocal: false,
  isActive: true,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/providers');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/providers',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(403);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    });
  });

  describe('Successful retrieval', () => {
    it('returns paginated providers list with apiKeyPresent field', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
      const providers = [
        makeProvider(),
        makeProvider({ id: 'cmjbv4i3x00003wsloputgwu2', slug: 'openai' }),
      ];
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(providers as never);
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(2);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: Array<{ apiKeyPresent: boolean }>;
        meta: unknown;
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
      expect(typeof data.data[0].apiKeyPresent).toBe('boolean');
      expect(data.meta).toBeDefined();
    });

    it('returns apiKeyPresent: true when env var is set', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(1);

      const response = await GET(makeGetRequest());

      const data = await parseJson<{ data: Array<{ apiKeyPresent: boolean }> }>(response);
      expect(data.data[0].apiKeyPresent).toBe(true);
    });

    it('returns apiKeyPresent: false when env var is not set', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(false);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(1);

      const response = await GET(makeGetRequest());

      const data = await parseJson<{ data: Array<{ apiKeyPresent: boolean }> }>(response);
      expect(data.data[0].apiKeyPresent).toBe(false);
    });

    it('returns empty array when no providers exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(0);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: unknown[] }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(0);
    });
  });

  describe('Filtering', () => {
    it('passes isActive filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(0);

      await GET(makeGetRequest({ isActive: 'true' }));

      expect(vi.mocked(prisma.aiProviderConfig.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isActive: true }) })
      );
    });

    it('passes providerType filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(0);

      await GET(makeGetRequest({ providerType: 'anthropic' }));

      expect(vi.mocked(prisma.aiProviderConfig.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ providerType: 'anthropic' }) })
      );
    });

    it('passes search query as OR filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'anthropic' }));

      expect(vi.mocked(prisma.aiProviderConfig.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        })
      );
    });
  });
});

describe('POST /api/v1/admin/orchestration/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(VALID_PROVIDER));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(VALID_PROVIDER));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(VALID_PROVIDER));

      expect(response.status).toBe(429);
    });
  });

  describe('Successful creation', () => {
    it('creates provider and returns 201 with apiKeyPresent field', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
      const created = makeProvider();
      vi.mocked(prisma.aiProviderConfig.create).mockResolvedValue(created as never);

      const response = await POST(makePostRequest(VALID_PROVIDER));

      expect(response.status).toBe(201);
      const data = await parseJson<{
        success: boolean;
        data: { slug: string; apiKeyPresent: boolean };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.slug).toBe('anthropic');
      expect(typeof data.data.apiKeyPresent).toBe('boolean');
    });

    it('stores createdBy from session user id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.create).mockResolvedValue(makeProvider() as never);

      await POST(makePostRequest(VALID_PROVIDER));

      expect(vi.mocked(prisma.aiProviderConfig.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdBy: ADMIN_ID }),
        })
      );
    });
  });

  describe('Validation errors', () => {
    it('returns 400 for missing required fields', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({}));

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 for invalid providerType', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makePostRequest({ ...VALID_PROVIDER, providerType: 'invalid-type' })
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for apiKeyEnvVar that is not SCREAMING_SNAKE_CASE', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makePostRequest({ ...VALID_PROVIDER, apiKeyEnvVar: 'lowercase_key' })
      );

      expect(response.status).toBe(400);
    });

    // SSRF guard — every unsafe baseUrl must be rejected at the schema
    // boundary so malicious admin input can't reach the outbound fetch.
    it.each([
      'http://169.254.169.254/latest/meta-data/', // AWS IMDS
      'http://metadata.google.internal/', // GCP metadata
      'http://10.0.0.1/', // RFC1918
      'http://192.168.1.1/', // RFC1918
      'http://172.16.0.1/', // RFC1918
      'http://127.0.0.1:11434/v1', // loopback without isLocal
      'http://localhost:11434/v1', // loopback hostname without isLocal
      'http://[::1]/', // IPv6 loopback
      'http://0.0.0.0/', // unspecified
      'file:///etc/passwd', // disallowed scheme
    ])('returns 400 for SSRF-unsafe baseUrl %s', async (baseUrl) => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makePostRequest({
          ...VALID_PROVIDER,
          slug: 'custom',
          name: 'Custom',
          providerType: 'openai-compatible',
          baseUrl,
          isLocal: false,
        })
      );

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });
  });

  describe('Conflict errors', () => {
    it('returns 409 when slug/name already exists (P2002)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiProviderConfig.create).mockRejectedValue(p2002);

      const response = await POST(makePostRequest(VALID_PROVIDER));

      expect(response.status).toBe(409);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    });
  });
});
