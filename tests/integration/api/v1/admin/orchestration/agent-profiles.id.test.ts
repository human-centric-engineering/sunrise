/**
 * Integration Test: Admin Orchestration Agent Profiles (single resource)
 *
 * GET    /api/v1/admin/orchestration/agent-profiles/:id
 * PATCH  /api/v1/admin/orchestration/agent-profiles/:id
 * DELETE /api/v1/admin/orchestration/agent-profiles/:id
 *
 * Key assertions:
 *   - GET returns the profile with its attached agents (id, slug, name).
 *   - PATCH ignores slug changes (slug is not in the update schema).
 *   - DELETE hard-deletes and reports detachedAgentCount; FK SET NULL
 *     leaves attached agents intact (this test exercises the route's
 *     contract; the FK behaviour is verified at the DB level by the
 *     migration itself).
 *
 * @see app/api/v1/admin/orchestration/agent-profiles/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
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
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
}));

import { DELETE, GET, PATCH } from '@/app/api/v1/admin/orchestration/agent-profiles/[id]/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';

const PROFILE_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    name: 'Support Family',
    slug: 'support-family',
    description: 'Shared profile.',
    persona: 'You are a calm senior support specialist.',
    brandVoiceInstructions: 'Friendly and concise.',
    guardrails: 'Never give medical advice.',
    isSystem: false,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function urlFor(id: string): string {
  return `http://localhost:3000/api/v1/admin/orchestration/agent-profiles/${id}`;
}

function makeGetRequest(id: string): NextRequest {
  return new NextRequest(urlFor(id));
}

function makePatchRequest(id: string, body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: urlFor(id),
  } as unknown as NextRequest;
}

function makeDeleteRequest(id: string): NextRequest {
  return new NextRequest(urlFor(id), { method: 'DELETE' });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/v1/admin/orchestration/agent-profiles/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeGetRequest(PROFILE_ID), paramsOf(PROFILE_ID));
    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await GET(makeGetRequest(PROFILE_ID), paramsOf(PROFILE_ID));
    expect(response.status).toBe(403);
  });

  it('returns 400 when the id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await GET(makeGetRequest('not-a-cuid'), paramsOf('not-a-cuid'));
    expect(response.status).toBe(400);
  });

  it('returns 404 when the profile does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findUnique).mockResolvedValue(null);

    const response = await GET(makeGetRequest(PROFILE_ID), paramsOf(PROFILE_ID));

    expect(response.status).toBe(404);
  });

  it('returns the profile with its attached agents', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findUnique).mockResolvedValue({
      ...makeProfile(),
      agents: [
        { id: 'agent_a', slug: 'support', name: 'Support', isActive: true },
        { id: 'agent_b', slug: 'vip-support', name: 'VIP Support', isActive: true },
      ],
    } as never);

    const response = await GET(makeGetRequest(PROFILE_ID), paramsOf(PROFILE_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: { agents: Array<{ slug: string }> };
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data.agents).toHaveLength(2);
    expect(data.data.agents[0].slug).toBe('support');

    // Confirm the include shape sent to Prisma — guards that the edit
    // page will get the agents list in the response.
    expect(vi.mocked(prisma.aiAgentProfile.findUnique)).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          agents: expect.objectContaining({
            select: { id: true, slug: true, name: true, isActive: true },
          }),
        }),
      })
    );
  });
});

describe('PATCH /api/v1/admin/orchestration/agent-profiles/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when the profile is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findUnique).mockResolvedValue(null);

    const response = await PATCH(
      makePatchRequest(PROFILE_ID, { name: 'Renamed' }),
      paramsOf(PROFILE_ID)
    );

    expect(response.status).toBe(404);
  });

  it('updates name + persona and audit-logs the change', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findUnique).mockResolvedValue(makeProfile());
    vi.mocked(prisma.aiAgentProfile.update).mockResolvedValue(
      makeProfile({ name: 'Renamed', persona: 'New persona.' })
    );

    const response = await PATCH(
      makePatchRequest(PROFILE_ID, { name: 'Renamed', persona: 'New persona.' }),
      paramsOf(PROFILE_ID)
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(prisma.aiAgentProfile.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PROFILE_ID },
        data: { name: 'Renamed', persona: 'New persona.' },
      })
    );
    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_profile.update',
        entityId: PROFILE_ID,
      })
    );
  });

  it('excludes the always-bumping updatedAt/createdAt from the audit diff (#396)', async () => {
    // `updatedAt` bumps on every Prisma `update()`, so the route must filter it
    // (and createdAt) out of the audit diff — otherwise every PATCH records a
    // spurious timestamp change. computeChanges' ignoreKeys behaviour is
    // unit-tested for real in admin-audit-logger.test.ts.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findUnique).mockResolvedValue(makeProfile());
    vi.mocked(prisma.aiAgentProfile.update).mockResolvedValue(makeProfile({ name: 'Renamed' }));

    await PATCH(makePatchRequest(PROFILE_ID, { name: 'Renamed' }), paramsOf(PROFILE_ID));

    expect(vi.mocked(computeChanges).mock.calls.at(-1)?.[2]).toEqual({
      ignoreKeys: ['updatedAt', 'createdAt'],
    });
  });

  it('silently drops a slug change — slug is not in the update schema', async () => {
    // Following the same non-strict Zod convention as updateProviderConfigSchema,
    // unknown fields are silently dropped. The contract is: slug rename is
    // not supported via PATCH (create a new profile and re-point agents).
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findUnique).mockResolvedValue(makeProfile());
    vi.mocked(prisma.aiAgentProfile.update).mockResolvedValue(makeProfile());

    const response = await PATCH(
      makePatchRequest(PROFILE_ID, { slug: 'renamed', name: 'Renamed' }),
      paramsOf(PROFILE_ID)
    );

    expect(response.status).toBe(200);
    // Only the recognised field should reach Prisma.
    expect(vi.mocked(prisma.aiAgentProfile.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: 'Renamed' },
      })
    );
    const call = vi.mocked(prisma.aiAgentProfile.update).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('slug');
  });

  it('accepts null to clear a text field', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findUnique).mockResolvedValue(makeProfile());
    vi.mocked(prisma.aiAgentProfile.update).mockResolvedValue(makeProfile({ guardrails: null }));

    const response = await PATCH(
      makePatchRequest(PROFILE_ID, { guardrails: null }),
      paramsOf(PROFILE_ID)
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(prisma.aiAgentProfile.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { guardrails: null } })
    );
  });
});

describe('DELETE /api/v1/admin/orchestration/agent-profiles/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when the profile is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findUnique).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest(PROFILE_ID), paramsOf(PROFILE_ID));

    expect(response.status).toBe(404);
  });

  it('hard-deletes and reports detachedAgentCount', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentProfile.findUnique).mockResolvedValue({
      ...makeProfile(),
      _count: { agents: 4 },
    } as never);
    vi.mocked(prisma.aiAgentProfile.delete).mockResolvedValue(makeProfile());

    const response = await DELETE(makeDeleteRequest(PROFILE_ID), paramsOf(PROFILE_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{ data: { deleted: boolean; detachedAgentCount: number } }>(
      response
    );
    expect(data.data.deleted).toBe(true);
    expect(data.data.detachedAgentCount).toBe(4);

    expect(vi.mocked(prisma.aiAgentProfile.delete)).toHaveBeenCalledWith({
      where: { id: PROFILE_ID },
    });
    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_profile.delete',
        metadata: { detachedAgentCount: 4 },
      })
    );
  });
});
