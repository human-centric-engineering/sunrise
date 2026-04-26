/**
 * Integration Test: Admin Orchestration — Provider Health (circuit breaker)
 *
 * GET  /api/v1/admin/orchestration/providers/:id/health — read breaker state
 * POST /api/v1/admin/orchestration/providers/:id/health — reset the breaker
 *
 * @see app/api/v1/admin/orchestration/providers/[id]/health/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/providers/[id]/health/route';
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
    Response.json(
      { success: false, error: { code: 'RATE_LIMITED', message: 'rate limited' } },
      { status: 429 }
    )
  ),
}));

vi.mock('@/lib/orchestration/llm/circuit-breaker', () => {
  let mockState: { state: string; failureCount: number; openedAt: number | null } = {
    state: 'closed',
    failureCount: 0,
    openedAt: null,
  };

  return {
    getBreaker: vi.fn(() => ({
      reset: vi.fn(() => {
        mockState = { state: 'closed', failureCount: 0, openedAt: null };
      }),
    })),
    getCircuitBreakerStatus: vi.fn(() => ({
      ...mockState,
      config: { failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 },
    })),
    // Expose setter for test control
    __setMockState: (s: typeof mockState) => {
      mockState = s;
    },
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { getCircuitBreakerStatus } from '@/lib/orchestration/llm/circuit-breaker';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'cmjbv4i3x00003wsloputgwul';

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

function makeRequest(method = 'GET'): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve({}),
    url: `http://localhost:3000/api/v1/admin/orchestration/providers/${PROVIDER_ID}/health`,
  } as unknown as NextRequest;
}

function makeParams() {
  return { params: Promise.resolve({ id: PROVIDER_ID }) };
}

async function parseJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/providers/:id/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
  });

  it('returns 404 when provider not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it('returns circuit breaker status for existing provider', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);

    const res = await GET(makeRequest(), makeParams());

    expect(res.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: {
        providerId: string;
        slug: string;
        state: string;
        failureCount: number;
        config: object;
      };
    }>(res);

    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.providerId).toBe(PROVIDER_ID);
    expect(body.data.slug).toBe('anthropic');
    expect(body.data.state).toBe('closed');
    expect(body.data.failureCount).toBe(0);
    expect(body.data.config).toBeDefined();
  });

  it('returns default status when no breaker exists for the slug', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
    vi.mocked(getCircuitBreakerStatus).mockReturnValue(null);

    const res = await GET(makeRequest(), makeParams());

    expect(res.status).toBe(200);
    const body = await parseJson<{ data: { state: string; failureCount: number } }>(res);
    expect(body.data.state).toBe('closed');
    expect(body.data.failureCount).toBe(0);
  });
});

describe('POST /api/v1/admin/orchestration/providers/:id/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: true,
      limit: 100,
      remaining: 99,
      reset: Date.now() + 60_000,
    });
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await POST(makeRequest('POST'), makeParams());
    expect(res.status).toBe(401);
  });

  it('returns 404 when provider not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

    const res = await POST(makeRequest('POST'), makeParams());
    expect(res.status).toBe(404);
  });

  it('resets the circuit breaker and returns new status', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);

    const res = await POST(makeRequest('POST'), makeParams());

    expect(res.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: { providerId: string; slug: string; state: string };
    }>(res);

    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.providerId).toBe(PROVIDER_ID);
    expect(body.data.slug).toBe('anthropic');
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 100,
      remaining: 0,
      reset: Date.now() + 60_000,
    });

    const res = await POST(makeRequest('POST'), makeParams());
    expect(res.status).toBe(429);
  });
});
