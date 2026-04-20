/**
 * Integration Test: Admin Orchestration Agent Invite Tokens
 *
 * GET    /api/v1/admin/orchestration/agents/:id/invite-tokens        (list)
 * POST   /api/v1/admin/orchestration/agents/:id/invite-tokens        (create)
 * DELETE /api/v1/admin/orchestration/agents/:id/invite-tokens/:tokenId  (revoke)
 *
 * Integration tests go deeper than the unit test at
 * tests/unit/app/api/v1/admin/orchestration/agents/invite-tokens/invite-tokens.route.test.ts.
 * They verify:
 *   - Exact Prisma query arguments (select, where, orderBy, data)
 *   - Full response payload shapes
 *   - CRUD flow: create → list → revoke
 *   - 403 Forbidden for non-admin authenticated users
 *   - Field-level Zod validation errors (label too long, maxUses < 1, bad datetime)
 *   - Invalid tokenId CUID on DELETE
 *   - createdBy is taken from the session user id on POST
 *   - revokedAt write arguments verified on DELETE
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/invite-tokens/route.ts
 * @see app/api/v1/admin/orchestration/agents/[id]/invite-tokens/[tokenId]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/agents/[id]/invite-tokens/route';
import { DELETE } from '@/app/api/v1/admin/orchestration/agents/[id]/invite-tokens/[tokenId]/route';
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
    aiAgent: {
      findFirst: vi.fn(),
    },
    aiAgentInviteToken: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const TOKEN_ID = 'cmjbv4i3x00004wsloputgwum';
const ADMIN_USER_ID = 'cmjbv4i3x00003wsloputgwul';

const EXPIRES_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: TOKEN_ID,
    token: 'tok_abc123',
    label: 'Beta testers',
    maxUses: 10,
    useCount: 3,
    expiresAt: null,
    revokedAt: null,
    createdBy: ADMIN_USER_ID,
    createdAt: new Date('2025-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeInviteOnlyAgent() {
  return { id: AGENT_ID, visibility: 'invite_only' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/invite-tokens`
  );
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/invite-tokens`,
  } as unknown as NextRequest;
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/invite-tokens/${TOKEN_ID}`,
    { method: 'DELETE' }
  );
}

function makeAgentParams(id = AGENT_ID) {
  return { params: Promise.resolve({ id }) };
}

function makeTokenParams(id = AGENT_ID, tokenId = TOKEN_ID) {
  return { params: Promise.resolve({ id, tokenId }) };
}

async function parseJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests: GET /agents/:id/invite-tokens ────────────────────────────────────

describe('GET /api/v1/admin/orchestration/agents/:id/invite-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest(), makeAgentParams());

      expect(response.status).toBe(401);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    });

    it('returns 403 when authenticated as non-admin user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest(), makeAgentParams());

      expect(response.status).toBe(403);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    });
  });

  describe('Successful retrieval', () => {
    it('returns tokens array with full payload shape', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiAgentInviteToken.findMany).mockResolvedValue([makeToken()] as never);

      const response = await GET(makeGetRequest(), makeAgentParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { tokens: unknown[] } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.tokens).toHaveLength(1);
      const token = data.data.tokens[0] as Record<string, unknown>;
      expect(token).toMatchObject({
        id: TOKEN_ID,
        token: 'tok_abc123',
        label: 'Beta testers',
        maxUses: 10,
        useCount: 3,
        expiresAt: null,
        revokedAt: null,
        createdBy: ADMIN_USER_ID,
      });
    });

    it('returns empty tokens array when agent has no tokens', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiAgentInviteToken.findMany).mockResolvedValue([] as never);

      const response = await GET(makeGetRequest(), makeAgentParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { tokens: unknown[] } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.tokens).toHaveLength(0);
    });

    it('queries tokens with correct where, orderBy, and select', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiAgentInviteToken.findMany).mockResolvedValue([] as never);

      await GET(makeGetRequest(), makeAgentParams());

      expect(vi.mocked(prisma.aiAgentInviteToken.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agentId: AGENT_ID },
          orderBy: { createdAt: 'desc' },
          select: expect.objectContaining({
            id: true,
            token: true,
            label: true,
            maxUses: true,
            useCount: true,
            expiresAt: true,
            revokedAt: true,
            createdBy: true,
            createdAt: true,
          }),
        })
      );
    });

    it('queries agent with select { id: true } before listing tokens', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiAgentInviteToken.findMany).mockResolvedValue([] as never);

      await GET(makeGetRequest(), makeAgentParams());

      expect(vi.mocked(prisma.aiAgent.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: AGENT_ID },
          select: { id: true },
        })
      );
    });

    it('returns both active and revoked tokens in the list', async () => {
      const activeToken = makeToken({ id: TOKEN_ID, revokedAt: null });
      const revokedToken = makeToken({
        id: 'cmjbv4i3x00005wsloputgwup',
        token: 'tok_revoked',
        revokedAt: new Date('2025-05-01'),
      });
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiAgentInviteToken.findMany).mockResolvedValue([
        activeToken,
        revokedToken,
      ] as never);

      const response = await GET(makeGetRequest(), makeAgentParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: { tokens: unknown[] } }>(response);
      expect(data.data.tokens).toHaveLength(2);
    });
  });

  describe('Error cases', () => {
    it('returns 404 when agent does not exist', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);

      const response = await GET(makeGetRequest(), makeAgentParams());

      expect(response.status).toBe(404);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    });

    it('returns 400 for invalid (non-CUID) agent id', async () => {
      const response = await GET(makeGetRequest(), makeAgentParams('not-a-cuid'));

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('does not query tokens when agent id is invalid', async () => {
      await GET(makeGetRequest(), makeAgentParams('bad-id'));

      expect(vi.mocked(prisma.aiAgentInviteToken.findMany)).not.toHaveBeenCalled();
    });
  });
});

// ─── Tests: POST /agents/:id/invite-tokens ───────────────────────────────────

describe('POST /api/v1/admin/orchestration/agents/:id/invite-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest({}), makeAgentParams());

      expect(response.status).toBe(401);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    });

    it('returns 403 when authenticated as non-admin user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest({}), makeAgentParams());

      expect(response.status).toBe(403);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);
      vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue(makeToken() as never);

      await POST(makePostRequest({ label: 'Test' }), makeAgentParams());

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });

    it('returns 429 and does not write when rate limit exceeded', async () => {
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest({ label: 'Test' }), makeAgentParams());

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.aiAgentInviteToken.create)).not.toHaveBeenCalled();
    });
  });

  describe('Successful creation', () => {
    it('creates token with all optional fields and returns 201', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);
      vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue(
        makeToken({ label: 'Partners', maxUses: 50, expiresAt: new Date(EXPIRES_AT) }) as never
      );

      const response = await POST(
        makePostRequest({ label: 'Partners', maxUses: 50, expiresAt: EXPIRES_AT }),
        makeAgentParams()
      );

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: { token: Record<string, unknown> } }>(
        response
      );
      expect(data.success).toBe(true);
      expect(data.data.token).toMatchObject({
        id: TOKEN_ID,
        label: 'Partners',
        maxUses: 50,
      });
      expect(data.data.token.expiresAt).toBeDefined();
    });

    it('creates token with no optional fields (minimal payload)', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);
      vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue(
        makeToken({ label: null, maxUses: null, expiresAt: null }) as never
      );

      const response = await POST(makePostRequest({}), makeAgentParams());

      expect(response.status).toBe(201);
      const data = await parseJson<{ data: { token: Record<string, unknown> } }>(response);
      expect(data.data.token.id).toBe(TOKEN_ID);
      expect(data.data.token.label).toBeNull();
      expect(data.data.token.maxUses).toBeNull();
    });

    it('passes createdBy from session user id to Prisma', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);
      vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue(makeToken() as never);

      await POST(makePostRequest({ label: 'Org A' }), makeAgentParams());

      expect(vi.mocked(prisma.aiAgentInviteToken.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdBy: ADMIN_USER_ID }),
        })
      );
    });

    it('passes agentId from route param to Prisma', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);
      vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue(makeToken() as never);

      await POST(makePostRequest({}), makeAgentParams());

      expect(vi.mocked(prisma.aiAgentInviteToken.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ agentId: AGENT_ID }),
        })
      );
    });

    it('passes null expiresAt when field is omitted', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);
      vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue(makeToken() as never);

      await POST(makePostRequest({ label: 'No expiry' }), makeAgentParams());

      const createCall = vi.mocked(prisma.aiAgentInviteToken.create).mock.calls[0][0];
      expect(createCall.data.expiresAt).toBeNull();
    });

    it('converts expiresAt string to Date object when passed to Prisma', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);
      vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue(makeToken() as never);

      await POST(makePostRequest({ expiresAt: EXPIRES_AT }), makeAgentParams());

      const createCall = vi.mocked(prisma.aiAgentInviteToken.create).mock.calls[0][0];
      expect(createCall.data.expiresAt).toBeInstanceOf(Date);
    });

    it('returns token with select fields present in response', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);
      vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue(makeToken() as never);

      await POST(makePostRequest({}), makeAgentParams());

      expect(vi.mocked(prisma.aiAgentInviteToken.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            id: true,
            token: true,
            label: true,
            maxUses: true,
            useCount: true,
            expiresAt: true,
            createdAt: true,
          }),
        })
      );
    });
  });

  describe('Visibility guard', () => {
    it('returns 400 when agent visibility is public', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
        id: AGENT_ID,
        visibility: 'public',
      } as never);

      const response = await POST(makePostRequest({ label: 'Test' }), makeAgentParams());

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 when agent visibility is private', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
        id: AGENT_ID,
        visibility: 'private',
      } as never);

      const response = await POST(makePostRequest({ label: 'Test' }), makeAgentParams());

      expect(response.status).toBe(400);
    });

    it('does not write token when visibility check fails', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
        id: AGENT_ID,
        visibility: 'public',
      } as never);

      await POST(makePostRequest({ label: 'Test' }), makeAgentParams());

      expect(vi.mocked(prisma.aiAgentInviteToken.create)).not.toHaveBeenCalled();
    });
  });

  describe('Validation errors', () => {
    it('returns 400 for label exceeding 200 characters', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);

      const response = await POST(makePostRequest({ label: 'x'.repeat(201) }), makeAgentParams());

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 for maxUses less than 1', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);

      const response = await POST(makePostRequest({ maxUses: 0 }), makeAgentParams());

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 for non-integer maxUses', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);

      const response = await POST(makePostRequest({ maxUses: 1.5 }), makeAgentParams());

      expect(response.status).toBe(400);
    });

    it('returns 400 for malformed expiresAt (not ISO datetime)', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);

      const response = await POST(makePostRequest({ expiresAt: 'not-a-date' }), makeAgentParams());

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 for invalid (non-CUID) agent id', async () => {
      const response = await POST(makePostRequest({}), makeAgentParams('not-a-cuid'));

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 for negative maxUses', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);

      const response = await POST(makePostRequest({ maxUses: -5 }), makeAgentParams());

      expect(response.status).toBe(400);
    });
  });

  describe('Not found', () => {
    it('returns 404 when agent does not exist', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);

      const response = await POST(makePostRequest({ label: 'Test' }), makeAgentParams());

      expect(response.status).toBe(404);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    });
  });
});

// ─── Tests: DELETE /agents/:id/invite-tokens/:tokenId ───────────────────────

describe('DELETE /api/v1/admin/orchestration/agents/:id/invite-tokens/:tokenId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(response.status).toBe(401);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    });

    it('returns 403 when authenticated as non-admin user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(response.status).toBe(403);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on DELETE', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(
        makeToken({ revokedAt: null }) as never
      );
      vi.mocked(prisma.aiAgentInviteToken.update).mockResolvedValue({} as never);

      await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });

    it('returns 429 and does not write when rate limit exceeded', async () => {
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.aiAgentInviteToken.update)).not.toHaveBeenCalled();
    });
  });

  describe('Successful revoke', () => {
    it('revokes an active token and returns success message', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(
        makeToken({ revokedAt: null }) as never
      );
      vi.mocked(prisma.aiAgentInviteToken.update).mockResolvedValue({} as never);

      const response = await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { message: string } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.message).toBe('Token revoked');
    });

    it('writes revokedAt as a Date instance', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(
        makeToken({ revokedAt: null }) as never
      );
      vi.mocked(prisma.aiAgentInviteToken.update).mockResolvedValue({} as never);

      await DELETE(makeDeleteRequest(), makeTokenParams());

      const updateCall = vi.mocked(prisma.aiAgentInviteToken.update).mock.calls[0][0];
      expect(updateCall.data.revokedAt).toBeInstanceOf(Date);
    });

    it('uses token id in the where clause for update', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(
        makeToken({ revokedAt: null }) as never
      );
      vi.mocked(prisma.aiAgentInviteToken.update).mockResolvedValue({} as never);

      await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(vi.mocked(prisma.aiAgentInviteToken.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TOKEN_ID },
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        })
      );
    });

    it('returns 200 with already-revoked message and skips update', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(
        makeToken({ revokedAt: new Date('2025-03-01') }) as never
      );

      const response = await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { message: string } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.message).toBe('Token already revoked');
      expect(vi.mocked(prisma.aiAgentInviteToken.update)).not.toHaveBeenCalled();
    });

    it('looks up token by both tokenId and agentId to prevent cross-agent access', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(
        makeToken({ revokedAt: null }) as never
      );
      vi.mocked(prisma.aiAgentInviteToken.update).mockResolvedValue({} as never);

      await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(vi.mocked(prisma.aiAgentInviteToken.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TOKEN_ID, agentId: AGENT_ID },
        })
      );
    });
  });

  describe('Error cases', () => {
    it('returns 404 when token does not exist', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(null);

      const response = await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(response.status).toBe(404);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    });

    it('returns 400 for invalid (non-CUID) agent id', async () => {
      const response = await DELETE(makeDeleteRequest(), makeTokenParams('not-a-cuid', TOKEN_ID));

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 for invalid (non-CUID) token id', async () => {
      const response = await DELETE(makeDeleteRequest(), makeTokenParams(AGENT_ID, 'not-a-cuid'));

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('does not query DB when agent id is invalid', async () => {
      await DELETE(makeDeleteRequest(), makeTokenParams('bad-id', TOKEN_ID));

      expect(vi.mocked(prisma.aiAgentInviteToken.findFirst)).not.toHaveBeenCalled();
    });

    it('does not query DB when token id is invalid', async () => {
      await DELETE(makeDeleteRequest(), makeTokenParams(AGENT_ID, 'bad-token'));

      expect(vi.mocked(prisma.aiAgentInviteToken.findFirst)).not.toHaveBeenCalled();
    });
  });
});

// ─── CRUD Flow ────────────────────────────────────────────────────────────────

describe('CRUD flow: create → list → revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  it('token created via POST appears in GET list and can be revoked via DELETE', async () => {
    // Step 1: POST — create token
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeInviteOnlyAgent() as never);
    vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue(
      makeToken({ label: 'Flow test', revokedAt: null }) as never
    );

    const createResponse = await POST(
      makePostRequest({ label: 'Flow test', maxUses: 5 }),
      makeAgentParams()
    );
    expect(createResponse.status).toBe(201);
    const createData = await parseJson<{ data: { token: { id: string } } }>(createResponse);
    const createdId = createData.data.token.id;

    // Step 2: GET — token appears in list
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({ id: AGENT_ID } as never);
    vi.mocked(prisma.aiAgentInviteToken.findMany).mockResolvedValue([
      makeToken({ id: createdId, label: 'Flow test', revokedAt: null }),
    ] as never);

    const listResponse = await GET(makeGetRequest(), makeAgentParams());
    expect(listResponse.status).toBe(200);
    const listData = await parseJson<{ data: { tokens: Array<{ id: string }> } }>(listResponse);
    expect(listData.data.tokens.some((t) => t.id === createdId)).toBe(true);

    // Step 3: DELETE — token gets revoked
    vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(
      makeToken({ id: createdId, revokedAt: null }) as never
    );
    vi.mocked(prisma.aiAgentInviteToken.update).mockResolvedValue({} as never);

    const deleteResponse = await DELETE(makeDeleteRequest(), makeTokenParams(AGENT_ID, createdId));
    expect(deleteResponse.status).toBe(200);
    const deleteData = await parseJson<{ data: { message: string } }>(deleteResponse);
    expect(deleteData.data.message).toBe('Token revoked');

    // Verify Prisma update was called with the right id
    expect(vi.mocked(prisma.aiAgentInviteToken.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: createdId },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      })
    );
  });
});
