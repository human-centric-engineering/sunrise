/**
 * Integration Test: Provider connection test
 *
 * POST /api/v1/admin/orchestration/providers/:id/test
 *
 * Key behaviours:
 *   - Returns HTTP 200 when testProvider returns { ok: true }
 *   - Returns HTTP 200 (not 5xx) when testProvider returns { ok: false }
 *     (the endpoint succeeded; the provider failed — different things)
 *   - Returns HTTP 200 when testProvider THROWS a ProviderError
 *     (same shape, error message surfaced as { ok: false, error: string })
 *
 * @see app/api/v1/admin/orchestration/providers/[id]/test/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/providers/[id]/test/route';
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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  testProvider: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { testProvider } from '@/lib/orchestration/llm/provider-manager';

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

function makePostRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve({}),
    url: `http://localhost:3000/api/v1/admin/orchestration/providers/${PROVIDER_ID}/test`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/providers/:id/test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('CUID validation', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });

  describe('Provider lookup', () => {
    it('returns 404 when provider row not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(404);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(429);
    });
  });

  describe('testProvider succeeds', () => {
    it('returns HTTP 200 when testProvider returns { ok: true }', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      vi.mocked(testProvider).mockResolvedValue({
        ok: true,
        models: ['claude-3-5-sonnet-20241022'],
      });

      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { ok: boolean; models: string[] } }>(
        response
      );
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.ok).toBe(true);
      expect(data.data.models).toContain('claude-3-5-sonnet-20241022');
    });
  });

  describe('testProvider fails gracefully', () => {
    it('returns HTTP 200 even when testProvider returns { ok: false }', async () => {
      // The endpoint succeeded; the provider just failed — different things.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      vi.mocked(testProvider).mockResolvedValue({
        ok: false,
        models: [],
        error: 'Connection refused',
      });

      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { ok: boolean; error?: string } }>(
        response
      );
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.ok).toBe(false);
      expect(data.data.error).toBeDefined();
    });

    it('returns HTTP 200 when testProvider throws a ProviderError', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      vi.mocked(testProvider).mockRejectedValue(
        new Error('ECONNREFUSED 169.254.169.254:80 secret-internal-detail')
      );

      const response = await POST(makePostRequest(), makeParams(PROVIDER_ID));

      // Route catches the throw and returns 200 with ok: false
      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { ok: boolean; error?: string } }>(
        response
      );
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.ok).toBe(false);
      // The raw SDK error must NOT be forwarded to the client —
      // it would act as a blind-SSRF exfiltration oracle.
      expect(data.data.error).toBe('connection_failed');
      expect(data.data.error).not.toContain('169.254');
      expect(data.data.error).not.toContain('secret-internal-detail');
    });
  });
});
