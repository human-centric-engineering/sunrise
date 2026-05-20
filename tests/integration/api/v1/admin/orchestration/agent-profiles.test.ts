/**
 * Integration Test: Admin Orchestration Agent Profiles (list + create)
 *
 * GET  /api/v1/admin/orchestration/agent-profiles
 * POST /api/v1/admin/orchestration/agent-profiles
 *
 * Key assertions:
 *   - GET list returns profiles with `agentCount` derived from the
 *     _count.agents relation include.
 *   - POST creates a profile and returns 201.
 *   - Duplicate slug -> 409.
 *   - Auth: 401 unauthenticated, 403 non-admin, 429 rate-limited.
 *
 * @see app/api/v1/admin/orchestration/agent-profiles/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgentProfile: {
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

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
}));

import { GET, POST } from '@/app/api/v1/admin/orchestration/agent-profiles/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const PROFILE_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    name: 'Support Family',
    slug: 'support-family',
    description: 'Shared persona/voice/guardrails for the support team.',
    persona: 'You are a calm senior support specialist.',
    brandVoiceInstructions: 'Friendly, concise, never use jargon.',
    guardrails: 'Never give medical or legal advice.',
    isSystem: false,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    _count: { agents: 0 },
    ...overrides,
  };
}

const VALID_PAYLOAD = {
  name: 'Support Family',
  slug: 'support-family',
  description: 'Shared profile.',
  persona: 'You are a calm senior support specialist.',
  brandVoiceInstructions: 'Friendly and concise.',
  guardrails: 'Never give medical advice.',
};

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/agent-profiles');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/agent-profiles',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe('GET /api/v1/admin/orchestration/agent-profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeGetRequest());
    expect(response.status).toBe(401);
    const data = await parseJson<{ error: { code: string } }>(response);
    expect(data.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await GET(makeGetRequest());
    expect(response.status).toBe(403);
  });

  it('returns paginated profiles with agentCount projected from _count', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findMany).mockResolvedValue([
      makeProfile({ _count: { agents: 3 } }),
      makeProfile({
        id: 'cmjbv4i3x00003wsloputgwu2',
        slug: 'vip',
        name: 'VIP Concierge',
        _count: { agents: 1 },
      }),
    ] as never);
    vi.mocked(prisma.aiAgentProfile.count).mockResolvedValue(2);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: Array<{ slug: string; agentCount: number; _count?: unknown }>;
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data).toHaveLength(2);
    expect(data.data[0].agentCount).toBe(3);
    expect(data.data[1].agentCount).toBe(1);
    // _count should be projected away — callers see a flat shape.
    expect(data.data[0]).not.toHaveProperty('_count');
  });

  it('passes the search query as a name/slug OR filter to Prisma', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiAgentProfile.count).mockResolvedValue(0);

    await GET(makeGetRequest({ q: 'support' }));

    expect(vi.mocked(prisma.aiAgentProfile.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
        include: { _count: { select: { agents: true } } },
      })
    );
  });

  it('orders by updatedAt desc so recently edited profiles surface first', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiAgentProfile.count).mockResolvedValue(0);

    await GET(makeGetRequest());

    expect(vi.mocked(prisma.aiAgentProfile.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { updatedAt: 'desc' } })
    );
  });
});

describe('POST /api/v1/admin/orchestration/agent-profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await POST(makePostRequest(VALID_PAYLOAD));
    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await POST(makePostRequest(VALID_PAYLOAD));
    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);
    const response = await POST(makePostRequest(VALID_PAYLOAD));
    expect(response.status).toBe(429);
  });

  it('creates a profile and returns 201 with agentCount: 0', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.create).mockResolvedValue(makeProfile() as never);

    const response = await POST(makePostRequest(VALID_PAYLOAD));

    expect(response.status).toBe(201);
    const data = await parseJson<{
      success: boolean;
      data: { slug: string; agentCount: number };
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data.slug).toBe('support-family');
    expect(data.data.agentCount).toBe(0);
  });

  it('stores createdBy from session.user.id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.create).mockResolvedValue(makeProfile() as never);

    await POST(makePostRequest(VALID_PAYLOAD));

    expect(vi.mocked(prisma.aiAgentProfile.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdBy: expect.any(String) }),
      })
    );
  });

  it('writes a logAdminAction audit entry on create', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.create).mockResolvedValue(makeProfile() as never);

    await POST(makePostRequest(VALID_PAYLOAD));

    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_profile.create',
        entityType: 'agent_profile',
        entityId: PROFILE_ID,
      })
    );
  });

  it('returns 409 on slug conflict', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'x',
      })
    );

    const response = await POST(makePostRequest(VALID_PAYLOAD));

    expect(response.status).toBe(409);
    const data = await parseJson<{ error: { message: string } }>(response);
    expect(data.error.message).toContain('support-family');
  });

  it('rejects oversize persona with a validation error', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makePostRequest({ ...VALID_PAYLOAD, persona: 'a'.repeat(10_001) }));

    expect(response.status).toBe(400);
  });

  it('persists null for optional fields when they are omitted from the payload', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.create).mockResolvedValue(makeProfile() as never);

    await POST(makePostRequest({ name: 'Minimal', slug: 'minimal' }));

    expect(vi.mocked(prisma.aiAgentProfile.create)).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Minimal',
        slug: 'minimal',
        description: null,
        persona: null,
        brandVoiceInstructions: null,
        guardrails: null,
        createdBy: expect.any(String),
      }),
    });
  });

  it('does NOT translate non-P2002 Prisma errors to 409 (only slug conflicts are mapped)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Foreign key violation', {
        code: 'P2003',
        clientVersion: 'x',
      })
    );

    const response = await POST(makePostRequest(VALID_PAYLOAD));

    // The withAdminAuth error handler translates Prisma known-request errors
    // to a structured 4xx envelope; the route's bespoke P2002 → ConflictError
    // branch must NOT swallow other codes. Either way the response is not a
    // 201 success.
    expect(response.status).not.toBe(201);
    expect(response.status).not.toBe(409);
  });

  it('rethrows unexpected runtime errors as a 500', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.create).mockRejectedValue(new Error('boom'));

    const response = await POST(makePostRequest(VALID_PAYLOAD));

    expect(response.status).toBe(500);
  });
});
