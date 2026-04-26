/**
 * Integration Test: Admin Orchestration Agent Capabilities
 *
 * GET    /api/v1/admin/orchestration/agents/:id/capabilities           (list)
 * POST   /api/v1/admin/orchestration/agents/:id/capabilities          (attach)
 * PATCH  /api/v1/admin/orchestration/agents/:id/capabilities/:capId   (update link)
 * DELETE /api/v1/admin/orchestration/agents/:id/capabilities/:capId   (detach)
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/capabilities/route.ts
 * @see app/api/v1/admin/orchestration/agents/[id]/capabilities/[capId]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/agents/[id]/capabilities/route';
import {
  PATCH,
  DELETE,
} from '@/app/api/v1/admin/orchestration/agents/[id]/capabilities/[capId]/route';
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
    aiAgent: { findUnique: vi.fn() },
    aiCapability: { findUnique: vi.fn() },
    aiAgentCapability: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/capabilities', () => ({
  capabilityDispatcher: {
    clearCache: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const CAPABILITY_ID = 'cmjbv4i3x00003wsloputgwu2';
const LINK_ID = 'cmjbv4i3x00003wsloputgwu3';

const VALID_ATTACH_BODY = { capabilityId: CAPABILITY_ID };

function makeAgent() {
  return { id: AGENT_ID, name: 'Test Agent', slug: 'test-agent', isActive: true };
}

function makeCapability() {
  return { id: CAPABILITY_ID, name: 'Test Capability', slug: 'test-capability', isActive: true };
}

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    agentId: AGENT_ID,
    capabilityId: CAPABILITY_ID,
    isEnabled: true,
    customConfig: null,
    customRateLimit: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAttachRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/capabilities`,
  } as unknown as NextRequest;
}

function makeCapIdRequest(method = 'PATCH', body?: Record<string, unknown>): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body ?? {}),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/capabilities/${CAPABILITY_ID}`,
  } as unknown as NextRequest;
}

function makeAttachParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeCapIdParams(id: string, capId: string) {
  return { params: Promise.resolve({ id, capId }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests: POST /agents/:id/capabilities ───────────────────────────────────

describe('POST /api/v1/admin/orchestration/agents/:id/capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makeAttachRequest(VALID_ATTACH_BODY), makeAttachParams(AGENT_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makeAttachRequest(VALID_ATTACH_BODY), makeAttachParams(AGENT_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      vi.mocked(prisma.aiAgentCapability.create).mockResolvedValue(makeLink() as never);

      await POST(makeAttachRequest(VALID_ATTACH_BODY), makeAttachParams(AGENT_ID));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });

  describe('Successful attach', () => {
    it('creates link and clears capability cache', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      vi.mocked(prisma.aiAgentCapability.create).mockResolvedValue(makeLink() as never);

      const response = await POST(makeAttachRequest(VALID_ATTACH_BODY), makeAttachParams(AGENT_ID));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: unknown }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(vi.mocked(capabilityDispatcher.clearCache)).toHaveBeenCalledOnce();
    });
  });

  describe('Error cases', () => {
    it('returns 404 when agent not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

      const response = await POST(makeAttachRequest(VALID_ATTACH_BODY), makeAttachParams(AGENT_ID));

      expect(response.status).toBe(404);
    });

    it('returns 404 when capability not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(null);

      const response = await POST(makeAttachRequest(VALID_ATTACH_BODY), makeAttachParams(AGENT_ID));

      expect(response.status).toBe(404);
    });

    it('returns 409 when capability already attached (P2002)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiAgentCapability.create).mockRejectedValue(p2002);

      const response = await POST(makeAttachRequest(VALID_ATTACH_BODY), makeAttachParams(AGENT_ID));

      expect(response.status).toBe(409);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    });

    it('returns 400 for invalid agent CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeAttachRequest(VALID_ATTACH_BODY), makeAttachParams('bad-id'));

      expect(response.status).toBe(400);
    });
  });
});

// ─── Tests: PATCH /agents/:id/capabilities/:capId ───────────────────────────

describe('PATCH /api/v1/admin/orchestration/agents/:id/capabilities/:capId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await PATCH(
        makeCapIdRequest('PATCH', { isEnabled: false }),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await PATCH(
        makeCapIdRequest('PATCH', { isEnabled: false }),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Successful update', () => {
    it('updates link and clears capability cache', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgentCapability.update).mockResolvedValue(
        makeLink({ isEnabled: false }) as never
      );

      const response = await PATCH(
        makeCapIdRequest('PATCH', { isEnabled: false }),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(vi.mocked(capabilityDispatcher.clearCache)).toHaveBeenCalledOnce();
    });

    it('uses compound agentId_capabilityId where clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgentCapability.update).mockResolvedValue(makeLink() as never);

      await PATCH(
        makeCapIdRequest('PATCH', { isEnabled: false }),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(vi.mocked(prisma.aiAgentCapability.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agentId_capabilityId: { agentId: AGENT_ID, capabilityId: CAPABILITY_ID } },
        })
      );
    });

    it('updates all optional fields in a single payload', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgentCapability.update).mockResolvedValue(makeLink() as never);

      const fullPayload = {
        isEnabled: false,
        customConfig: { tool: 'custom' },
        customRateLimit: 30,
      };

      await PATCH(makeCapIdRequest('PATCH', fullPayload), makeCapIdParams(AGENT_ID, CAPABILITY_ID));

      const updateCall = vi.mocked(prisma.aiAgentCapability.update).mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        isEnabled: false,
        customConfig: { tool: 'custom' },
        customRateLimit: 30,
      });
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded on PATCH', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await PATCH(
        makeCapIdRequest('PATCH', { isEnabled: false }),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.aiAgentCapability.update)).not.toHaveBeenCalled();
    });
  });

  describe('Error cases', () => {
    it('returns 404 when link not found (P2025)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const p2025 = new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiAgentCapability.update).mockRejectedValue(p2025);

      const response = await PATCH(
        makeCapIdRequest('PATCH', { isEnabled: false }),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(404);
    });
  });
});

// ─── Tests: DELETE /agents/:id/capabilities/:capId ──────────────────────────

describe('DELETE /api/v1/admin/orchestration/agents/:id/capabilities/:capId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(
        makeCapIdRequest('DELETE'),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(
        makeCapIdRequest('DELETE'),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Successful detach', () => {
    it('deletes link and clears capability cache', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgentCapability.delete).mockResolvedValue(makeLink() as never);

      const response = await DELETE(
        makeCapIdRequest('DELETE'),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { agentId: string; capabilityId: string; detached: boolean };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.detached).toBe(true);
      expect(vi.mocked(capabilityDispatcher.clearCache)).toHaveBeenCalledOnce();
    });

    it('uses compound agentId_capabilityId where clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgentCapability.delete).mockResolvedValue(makeLink() as never);

      await DELETE(makeCapIdRequest('DELETE'), makeCapIdParams(AGENT_ID, CAPABILITY_ID));

      expect(vi.mocked(prisma.aiAgentCapability.delete)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agentId_capabilityId: { agentId: AGENT_ID, capabilityId: CAPABILITY_ID } },
        })
      );
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded on DELETE', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await DELETE(
        makeCapIdRequest('DELETE'),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.aiAgentCapability.delete)).not.toHaveBeenCalled();
    });
  });

  describe('Error cases', () => {
    it('returns 404 when link not found (P2025)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const p2025 = new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiAgentCapability.delete).mockRejectedValue(p2025);

      const response = await DELETE(
        makeCapIdRequest('DELETE'),
        makeCapIdParams(AGENT_ID, CAPABILITY_ID)
      );

      expect(response.status).toBe(404);
    });
  });
});

// ─── Tests: GET /agents/:id/capabilities ────────────────────────────────────

describe('GET /api/v1/admin/orchestration/agents/:id/capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const response = await GET(makeAttachRequest({}), makeAttachParams(AGENT_ID));
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const response = await GET(makeAttachRequest({}), makeAttachParams(AGENT_ID));
      expect(response.status).toBe(403);
    });
  });

  describe('404 on missing agent', () => {
    it('returns 404 when agent does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
      const response = await GET(makeAttachRequest({}), makeAttachParams(AGENT_ID));
      expect(response.status).toBe(404);
    });
  });

  describe('Successful list', () => {
    it('returns 200 with attached pivot rows', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      const mockLinks = [{ ...makeLink(), capability: makeCapability() }];
      vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue(mockLinks as never);

      const response = await GET(makeAttachRequest({}), makeAttachParams(AGENT_ID));
      const data = await parseJson<{ success: boolean; data: unknown[] }>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
    });

    it('returns empty array when agent has no capabilities attached', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([] as never);

      const response = await GET(makeAttachRequest({}), makeAttachParams(AGENT_ID));
      const data = await parseJson<{ success: boolean; data: unknown[] }>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(0);
    });

    it('calls findMany with include capability and orderBy capability.name asc', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([] as never);

      await GET(makeAttachRequest({}), makeAttachParams(AGENT_ID));

      expect(vi.mocked(prisma.aiAgentCapability.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agentId: AGENT_ID },
          include: { capability: true },
          orderBy: { capability: { name: 'asc' } },
        })
      );
    });
  });

  describe('Validation', () => {
    it('returns 400 for invalid agent CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await GET(makeAttachRequest({}), makeAttachParams('bad-id'));
      expect(response.status).toBe(400);
    });
  });
});
