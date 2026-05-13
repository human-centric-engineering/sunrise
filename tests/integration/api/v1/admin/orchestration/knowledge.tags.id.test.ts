/**
 * Integration Test: Admin Orchestration — Single Knowledge Tag (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/knowledge/tags/:id
 * PATCH  /api/v1/admin/orchestration/knowledge/tags/:id
 * DELETE /api/v1/admin/orchestration/knowledge/tags/:id?force=true
 *
 * This file targets the branch and function gaps not reached by the broader
 * knowledge-tags.test.ts coverage:
 *  - Auth (401/403) on all three handlers
 *  - Rate limit (429) on PATCH and DELETE
 *  - Invalid CUID (400) on all three handlers
 *  - 404 on PATCH and DELETE when tag does not exist
 *  - Slug description nullification (null value for optional field)
 *  - Documents-with-linked-agents path in GET response shaping
 *
 * @see app/api/v1/admin/orchestration/knowledge/tags/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/knowledge/tags/[id]/route';
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
    knowledgeTag: {
      findUnique: vi.fn(),
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

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => ({})),
}));

vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  invalidateAllAgentAccess: vi.fn(),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { invalidateAllAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TAG_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeTag(overrides: Record<string, unknown> = {}) {
  return {
    id: TAG_ID,
    slug: 'support',
    name: 'Support',
    description: 'Customer support docs',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    _count: { documents: 0, agents: 0 },
    documents: [] as Array<{ document: unknown; createdAt: Date }>,
    agents: [] as Array<{ agent: unknown; createdAt: Date }>,
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(method = 'GET', body?: Record<string, unknown>, query = ''): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body ?? {}),
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/tags/${TAG_ID}${query}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/tags/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest('GET'), makeParams(TAG_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest('GET'), makeParams(TAG_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Validation', () => {
    it('returns 400 for invalid CUID in id param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest('GET'), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Successful retrieval', () => {
    it('returns 200 with tag data including document and agent arrays', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
        makeTag({ _count: { documents: 3, agents: 1 } }) as never
      );

      const response = await GET(makeRequest('GET'), makeParams(TAG_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: {
          id: string;
          documentCount: number;
          agentCount: number;
          documents: unknown[];
          agents: unknown[];
        };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(TAG_ID);
      expect(data.data.documentCount).toBe(3);
      expect(data.data.agentCount).toBe(1);
      // Arrays from join rows are flattened to the nested object
      expect(Array.isArray(data.data.documents)).toBe(true);
      expect(Array.isArray(data.data.agents)).toBe(true);
    });

    it('flattens document join rows into document objects', async () => {
      // The route maps `documents: [{ document: {...} }]` → `[{...}]`
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const docObj = {
        id: 'doc-1',
        name: 'Guide',
        fileName: 'guide.md',
        scope: 'global',
        status: 'ready',
      };
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
        makeTag({
          _count: { documents: 1, agents: 0 },
          documents: [{ document: docObj, createdAt: new Date() }],
        }) as never
      );

      const response = await GET(makeRequest('GET'), makeParams(TAG_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { documents: Array<{ id: string; name: string }> };
      }>(response);
      expect(data.data.documents).toHaveLength(1);
      expect(data.data.documents[0]).toEqual(docObj);
    });

    it('flattens agent join rows into agent objects', async () => {
      // The route maps `agents: [{ agent: {...} }]` → `[{...}]`
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const agentObj = { id: 'agent-1', name: 'Support Bot', slug: 'support-bot', isActive: true };
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
        makeTag({
          _count: { documents: 0, agents: 1 },
          agents: [{ agent: agentObj, createdAt: new Date() }],
        }) as never
      );

      const response = await GET(makeRequest('GET'), makeParams(TAG_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { agents: Array<{ id: string; name: string }> };
      }>(response);
      expect(data.data.agents).toHaveLength(1);
      expect(data.data.agents[0]).toEqual(agentObj);
    });

    it('returns 404 when tag does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest('GET'), makeParams(TAG_ID));

      expect(response.status).toBe(404);
    });
  });
});

// ─── PATCH ────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/admin/orchestration/knowledge/tags/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await PATCH(makeRequest('PATCH', { name: 'New Name' }), makeParams(TAG_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await PATCH(makeRequest('PATCH', { name: 'New Name' }), makeParams(TAG_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(TAG_ID));

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.knowledgeTag.findUnique)).not.toHaveBeenCalled();
    });
  });

  describe('Validation', () => {
    it('returns 400 for invalid CUID in id param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });

    it('returns 400 when body is empty (no fields to update)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(makeTag() as never);

      const response = await PATCH(makeRequest('PATCH', {}), makeParams(TAG_ID));

      expect(response.status).toBe(400);
    });
  });

  describe('Error cases', () => {
    it('returns 404 when tag does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(null);

      const response = await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(TAG_ID));

      expect(response.status).toBe(404);
    });

    it('returns 409 on slug conflict (P2002)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(makeTag() as never);
      vi.mocked(prisma.knowledgeTag.update).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.0.0',
        })
      );

      const response = await PATCH(
        makeRequest('PATCH', { slug: 'already-taken' }),
        makeParams(TAG_ID)
      );

      expect(response.status).toBe(409);
    });
  });

  describe('Successful update', () => {
    it('updates name and returns 200 with updated tag', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(makeTag() as never);
      vi.mocked(prisma.knowledgeTag.update).mockResolvedValue(
        makeTag({ name: 'Renamed' }) as never
      );

      const response = await PATCH(makeRequest('PATCH', { name: 'Renamed' }), makeParams(TAG_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { name: string } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('Renamed');
    });

    it('updates description field when provided', async () => {
      // The route sets `data.description = body.description ?? null` when body.description
      // is defined — passing a value updates the field.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(makeTag() as never);
      vi.mocked(prisma.knowledgeTag.update).mockResolvedValue(
        makeTag({ description: 'New description' }) as never
      );

      const response = await PATCH(
        makeRequest('PATCH', { name: 'Keep Name', description: 'New description' }),
        makeParams(TAG_ID)
      );

      expect(response.status).toBe(200);
      // Verify that the update call contained the new description
      expect(vi.mocked(prisma.knowledgeTag.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ description: 'New description' }),
        })
      );
    });

    it('invalidates agent access cache after update', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(makeTag() as never);
      vi.mocked(prisma.knowledgeTag.update).mockResolvedValue(
        makeTag({ name: 'Updated' }) as never
      );

      await PATCH(makeRequest('PATCH', { name: 'Updated' }), makeParams(TAG_ID));

      expect(vi.mocked(invalidateAllAgentAccess)).toHaveBeenCalled();
    });

    it('calls adminLimiter.check on PATCH', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(makeTag() as never);
      vi.mocked(prisma.knowledgeTag.update).mockResolvedValue(makeTag() as never);

      await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(TAG_ID));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/admin/orchestration/knowledge/tags/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(makeRequest('DELETE'), makeParams(TAG_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(makeRequest('DELETE'), makeParams(TAG_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await DELETE(makeRequest('DELETE'), makeParams(TAG_ID));

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.knowledgeTag.findUnique)).not.toHaveBeenCalled();
    });
  });

  describe('Validation', () => {
    it('returns 400 for invalid CUID in id param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await DELETE(makeRequest('DELETE'), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });

  describe('Error cases', () => {
    it('returns 404 when tag does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(null);

      const response = await DELETE(makeRequest('DELETE'), makeParams(TAG_ID));

      expect(response.status).toBe(404);
    });

    it('returns 409 when tag is granted to agents (force=true does not bypass)', async () => {
      // Agent grants cannot be force-stripped — operator must manually remove them
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
        makeTag({
          _count: { documents: 0, agents: 1 },
          agents: [{ agent: { id: 'a-1', name: 'Bot', slug: 'bot' }, createdAt: new Date() }],
        }) as never
      );

      // Even with ?force=true the route should block
      const response = await DELETE(
        makeRequest('DELETE', undefined, '?force=true'),
        makeParams(TAG_ID)
      );

      expect(response.status).toBe(409);
      expect(vi.mocked(prisma.knowledgeTag.delete)).not.toHaveBeenCalled();
    });

    it('returns 409 when documents are linked but force is not set', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
        makeTag({ _count: { documents: 5, agents: 0 } }) as never
      );

      const response = await DELETE(makeRequest('DELETE'), makeParams(TAG_ID));

      expect(response.status).toBe(409);
    });
  });

  describe('Successful delete', () => {
    it('deletes an unlinked tag and returns 200', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
        makeTag({ _count: { documents: 0, agents: 0 } }) as never
      );
      vi.mocked(prisma.knowledgeTag.delete).mockResolvedValue(makeTag() as never);

      const response = await DELETE(makeRequest('DELETE'), makeParams(TAG_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string; deleted: boolean } }>(
        response
      );
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(TAG_ID);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.deleted).toBe(true);
    });

    it('force-deletes a tag that only has document links (?force=true)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
        makeTag({ _count: { documents: 3, agents: 0 } }) as never
      );
      vi.mocked(prisma.knowledgeTag.delete).mockResolvedValue(makeTag() as never);

      const response = await DELETE(
        makeRequest('DELETE', undefined, '?force=true'),
        makeParams(TAG_ID)
      );

      expect(response.status).toBe(200);
      expect(vi.mocked(prisma.knowledgeTag.delete)).toHaveBeenCalledWith({ where: { id: TAG_ID } });
    });

    it('invalidates agent access cache after delete', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
        makeTag({ _count: { documents: 0, agents: 0 } }) as never
      );
      vi.mocked(prisma.knowledgeTag.delete).mockResolvedValue(makeTag() as never);

      await DELETE(makeRequest('DELETE'), makeParams(TAG_ID));

      expect(vi.mocked(invalidateAllAgentAccess)).toHaveBeenCalled();
    });

    it('calls adminLimiter.check on DELETE', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
        makeTag({ _count: { documents: 0, agents: 0 } }) as never
      );
      vi.mocked(prisma.knowledgeTag.delete).mockResolvedValue(makeTag() as never);

      await DELETE(makeRequest('DELETE'), makeParams(TAG_ID));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });
});
