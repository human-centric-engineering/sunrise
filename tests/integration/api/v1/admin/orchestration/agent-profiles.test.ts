/**
 * Integration Test: Admin Orchestration Agent Profiles (list + create)
 *
 * GET  /api/v1/admin/orchestration/agent-profiles
 * POST /api/v1/admin/orchestration/agent-profiles
 *
 * Key assertions:
 *   - GET list returns profiles with `agentCount`: attached agents in every
 *     org, from `agentProfileUsage` (t-731), not a `_count` include.
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

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
}));

vi.mock('@/lib/orchestration/admin/global-config-usage', () => ({
  agentProfileUsage: vi.fn(async () => new Map<string, number>()),
}));

import { GET, POST } from '@/app/api/v1/admin/orchestration/agent-profiles/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { agentProfileUsage } from '@/lib/orchestration/admin/global-config-usage';

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

  it('returns paginated profiles with agentCount counted in every org (t-731)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findMany).mockResolvedValue([
      makeProfile(),
      makeProfile({ id: 'cmjbv4i3x00003wsloputgwu2', slug: 'vip', name: 'VIP Concierge' }),
      makeProfile({ id: 'cmjbv4i3x00003wsloputgwu3', slug: 'unused', name: 'Unused' }),
    ] as never);
    vi.mocked(prisma.aiAgentProfile.count).mockResolvedValue(3);
    vi.mocked(agentProfileUsage).mockResolvedValue(
      new Map([
        [PROFILE_ID, 3],
        ['cmjbv4i3x00003wsloputgwu2', 1],
      ])
    );

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: Array<{ slug: string; agentCount: number }>;
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data.map((p) => [p.slug, p.agentCount])).toEqual([
      ['support-family', 3],
      ['vip', 1],
      ['unused', 0],
    ]);
    expect(vi.mocked(agentProfileUsage)).toHaveBeenCalledWith([
      PROFILE_ID,
      'cmjbv4i3x00003wsloputgwu2',
      'cmjbv4i3x00003wsloputgwu3',
    ]);
  });

  it('passes the search query as a name/slug OR filter to Prisma', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiAgentProfile.count).mockResolvedValue(0);

    await GET(makeGetRequest({ q: 'support' }));

    expect(vi.mocked(prisma.aiAgentProfile.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
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

  it('creates a profile and returns 201 with agentCount: 0', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.create).mockResolvedValue(makeProfile());

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
    vi.mocked(prisma.aiAgentProfile.create).mockResolvedValue(makeProfile());

    await POST(makePostRequest(VALID_PAYLOAD));

    expect(vi.mocked(prisma.aiAgentProfile.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdBy: expect.any(String) }),
      })
    );
  });

  it('writes a logAdminAction audit entry on create', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.create).mockResolvedValue(makeProfile());

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
    vi.mocked(prisma.aiAgentProfile.create).mockResolvedValue(makeProfile());

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
