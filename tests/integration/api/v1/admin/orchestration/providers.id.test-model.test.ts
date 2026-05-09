/**
 * Integration Test: Admin Orchestration — Model-level connection test
 *
 * POST /api/v1/admin/orchestration/providers/:id/test-model
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

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';
const MODEL = 'claude-3-5-haiku-20241022';
const BASE_URL = `http://localhost:3000/api/v1/admin/orchestration/providers/${PROVIDER_ID}/test-model`;

function makeProvider() {
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
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

function makeRequest(body: Record<string, unknown> = { model: MODEL }): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
    url: BASE_URL,
  };
  return {
    ...base,
    clone: () => ({ ...base }),
  } as unknown as NextRequest;
}

function makeParams(id: string = PROVIDER_ID) {
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

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(429);
    });
  });

  describe('Validation', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when model is missing from body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);

      const response = await POST(makeRequest({}), makeParams());

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when model is an empty string', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);

      const response = await POST(makeRequest({ model: '' }), makeParams());

      expect(response.status).toBe(400);
    });
  });

  describe('Not found', () => {
    it('returns 404 when provider does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Successful model test', () => {
    it('returns 200 with ok=true and latencyMs when model responds', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(getProvider).mockResolvedValue({
        chat: vi.fn().mockResolvedValue({ content: 'Hello!' }),
      } as never);

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { ok: boolean; latencyMs: number | null; model: string };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.ok).toBe(true);
      expect(typeof data.data.latencyMs).toBe('number');
      expect(data.data.model).toBe(MODEL);
    });

    it('returns 200 with ok=false and latencyMs=null when provider throws', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(getProvider).mockResolvedValue({
        chat: vi.fn().mockRejectedValue(new Error('Connection refused')),
      } as never);

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { ok: boolean; latencyMs: null; model: string; error: string };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.ok).toBe(false);
      expect(data.data.latencyMs).toBeNull();
      expect(data.data.model).toBe(MODEL);
      expect(data.data.error).toBe('model_test_failed');
    });

    it('returns 200 with ok=false when getProvider itself throws', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(getProvider).mockRejectedValue(new Error('Provider not configured'));

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: { ok: boolean; error: string } }>(response);
      expect(data.data.ok).toBe(false);
      expect(data.data.error).toBe('model_test_failed');
    });
  });

  describe('Capability-aware routing', () => {
    it('routes embedding capability through provider.embed (not chat)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      const chatMock = vi.fn();
      const embedMock = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      vi.mocked(getProvider).mockResolvedValue({
        chat: chatMock,
        embed: embedMock,
      } as never);

      const response = await POST(
        makeRequest({ model: 'text-embedding-3-small', capability: 'embedding' }),
        makeParams()
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { ok: boolean; latencyMs: number | null; capability: string };
      }>(response);
      expect(data.data.ok).toBe(true);
      expect(typeof data.data.latencyMs).toBe('number');
      expect(data.data.capability).toBe('embedding');
      expect(embedMock).toHaveBeenCalledTimes(1);
      expect(chatMock).not.toHaveBeenCalled();
    });

    it('refuses unsupported capabilities without invoking the SDK', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      const chatMock = vi.fn();
      const embedMock = vi.fn();
      vi.mocked(getProvider).mockResolvedValue({
        chat: chatMock,
        embed: embedMock,
      } as never);

      const response = await POST(
        makeRequest({ model: 'o3-pro', capability: 'reasoning' }),
        makeParams()
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { ok: boolean; capability: string; error: string; message: string };
      }>(response);
      expect(data.data.ok).toBe(false);
      expect(data.data.capability).toBe('reasoning');
      expect(data.data.error).toBe('unsupported_test_capability');
      expect(data.data.message).toMatch(/reasoning models use/i);
      // Crucially — neither SDK surface should be touched. A real
      // chat call here would 404 (the bug that motivated Phase B).
      expect(chatMock).not.toHaveBeenCalled();
      expect(embedMock).not.toHaveBeenCalled();
    });

    it('returns the unsupported response for image / audio / moderation / unknown', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(getProvider).mockResolvedValue({
        chat: vi.fn(),
        embed: vi.fn(),
      } as never);

      for (const capability of ['image', 'audio', 'moderation', 'unknown'] as const) {
        const response = await POST(makeRequest({ model: 'whatever', capability }), makeParams());
        expect(response.status).toBe(200);
        const data = await parseJson<{
          data: { ok: boolean; capability: string; error: string };
        }>(response);
        expect(data.data.ok).toBe(false);
        expect(data.data.capability).toBe(capability);
        expect(data.data.error).toBe('unsupported_test_capability');
      }
    });

    it('defaults to chat capability when omitted (backwards compat)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      const chatMock = vi.fn().mockResolvedValue({ content: 'Hello' });
      vi.mocked(getProvider).mockResolvedValue({
        chat: chatMock,
        embed: vi.fn(),
      } as never);

      // No capability in body — pre-Phase B callers (wizard smoke
      // test, agent-form test card) keep working.
      const response = await POST(makeRequest({ model: MODEL }), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: { ok: boolean; capability: string } }>(response);
      expect(data.data.ok).toBe(true);
      expect(data.data.capability).toBe('chat');
      expect(chatMock).toHaveBeenCalledTimes(1);
    });
  });
});
