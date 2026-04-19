/**
 * Unit Test: Agent Invite Token CRUD endpoints
 *
 * Covers:
 * - GET /agents/:id/invite-tokens — list tokens
 * - POST /agents/:id/invite-tokens — create token
 * - DELETE /agents/:id/invite-tokens/:tokenId — revoke token
 * - Auth + rate limiting
 * - Visibility check (only invite_only agents can have tokens)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findFirst: vi.fn() },
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

// ─── Imports ────────────────────────────────────────────────────────────────

import { GET, POST } from '@/app/api/v1/admin/orchestration/agents/[id]/invite-tokens/route';
import { DELETE } from '@/app/api/v1/admin/orchestration/agents/[id]/invite-tokens/[tokenId]/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const TOKEN_ID = 'cmjbv4i3x00004wsloputgwum';
const USER_ID = 'cmjbv4i3x00005wsloputgwun';

function makeGetRequest(): NextRequest {
  return new Request('http://localhost/test', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }) as unknown as NextRequest;
}

function makePostRequest(body: unknown): NextRequest {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeDeleteRequest(): NextRequest {
  return new Request('http://localhost/test', {
    method: 'DELETE',
  }) as unknown as NextRequest;
}

function makeAgentParams(agentId = AGENT_ID) {
  return { params: Promise.resolve({ id: agentId }) };
}

function makeTokenParams(agentId = AGENT_ID, tokenId = TOKEN_ID) {
  return { params: Promise.resolve({ id: agentId, tokenId }) };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Invite Token Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── GET — List tokens ──────────────────────────────────────────────────

  describe('GET /agents/:id/invite-tokens', () => {
    it('returns tokens for an agent', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiAgentInviteToken.findMany).mockResolvedValue([
        {
          id: TOKEN_ID,
          token: 'tok_abc123',
          label: 'Beta testers',
          maxUses: 10,
          useCount: 3,
          expiresAt: null,
          revokedAt: null,
          createdBy: USER_ID,
          createdAt: new Date(),
        },
      ] as never);

      const res = await GET(makeGetRequest(), makeAgentParams());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.tokens).toHaveLength(1);
      expect(json.data.tokens[0].label).toBe('Beta testers');
    });

    it('returns 404 for unknown agent', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);

      const res = await GET(makeGetRequest(), makeAgentParams());

      expect(res.status).toBe(404);
    });

    it('rejects unauthenticated requests', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const res = await GET(makeGetRequest(), makeAgentParams());

      expect(res.status).toBe(401);
    });
  });

  // ── POST — Create token ────────────────────────────────────────────────

  describe('POST /agents/:id/invite-tokens', () => {
    it('creates a token for an invite_only agent', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
        id: AGENT_ID,
        visibility: 'invite_only',
      } as never);
      vi.mocked(prisma.aiAgentInviteToken.create).mockResolvedValue({
        id: TOKEN_ID,
        token: 'tok_new123',
        label: 'Partners',
        maxUses: 50,
        useCount: 0,
        expiresAt: null,
        createdAt: new Date(),
      } as never);

      const res = await POST(
        makePostRequest({ label: 'Partners', maxUses: 50 }),
        makeAgentParams()
      );
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(201);
      expect(json.data.token.label).toBe('Partners');
    });

    it('rejects token creation for non-invite_only agent', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
        id: AGENT_ID,
        visibility: 'public',
      } as never);

      const res = await POST(makePostRequest({}), makeAgentParams());

      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown agent', async () => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);

      const res = await POST(makePostRequest({}), makeAgentParams());

      expect(res.status).toBe(404);
    });
  });

  // ── DELETE — Revoke token ──────────────────────────────────────────────

  describe('DELETE /agents/:id/invite-tokens/:tokenId', () => {
    it('revokes an active token', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
        id: TOKEN_ID,
        agentId: AGENT_ID,
        revokedAt: null,
      } as never);
      vi.mocked(prisma.aiAgentInviteToken.update).mockResolvedValue({} as never);

      const res = await DELETE(makeDeleteRequest(), makeTokenParams());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.message).toBe('Token revoked');
      expect(prisma.aiAgentInviteToken.update).toHaveBeenCalled();
    });

    it('returns success for already-revoked token', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
        id: TOKEN_ID,
        agentId: AGENT_ID,
        revokedAt: new Date(),
      } as never);

      const res = await DELETE(makeDeleteRequest(), makeTokenParams());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.message).toBe('Token already revoked');
      expect(prisma.aiAgentInviteToken.update).not.toHaveBeenCalled();
    });

    it('returns 404 for unknown token', async () => {
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(null);

      const res = await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(res.status).toBe(404);
    });

    it('returns 429 when rate limited', async () => {
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      const res = await DELETE(makeDeleteRequest(), makeTokenParams());

      expect(res.status).toBe(429);
    });
  });
});
