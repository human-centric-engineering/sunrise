/**
 * Tests: Admin Orchestration — Single Embed Token (patch + delete)
 *
 * PATCH  /api/v1/admin/orchestration/agents/:id/embed-tokens/:tokenId
 * DELETE /api/v1/admin/orchestration/agents/:id/embed-tokens/:tokenId
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgentEmbedToken: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import {
  PATCH,
  DELETE,
} from '@/app/api/v1/admin/orchestration/agents/[id]/embed-tokens/[tokenId]/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const TOKEN_ID = 'cmjbv4i3x00004wsloputgwu3';

function makeExistingToken(overrides: Record<string, unknown> = {}) {
  return {
    id: TOKEN_ID,
    agentId: AGENT_ID,
    label: 'Marketing site',
    allowedOrigins: ['https://example.com'],
    isActive: true,
    createdBy: 'user-1',
    createdAt: new Date(),
    creator: { id: 'user-1', name: 'Admin' },
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/embed-tokens/${TOKEN_ID}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/embed-tokens/${TOKEN_ID}`,
    { method: 'DELETE' }
  );
}

function makeParams() {
  return { params: Promise.resolve({ id: AGENT_ID, tokenId: TOKEN_ID }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiAgentEmbedToken.findFirst).mockResolvedValue(makeExistingToken() as never);
  vi.mocked(prisma.aiAgentEmbedToken.update).mockResolvedValue(makeExistingToken() as never);
  vi.mocked(prisma.aiAgentEmbedToken.delete).mockResolvedValue(makeExistingToken() as never);
});

describe('PATCH /agents/:id/embed-tokens/:tokenId', () => {
  it('returns 400 when agent id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({ isActive: false }), {
      params: Promise.resolve({ id: 'bad-id', tokenId: TOKEN_ID }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 when token id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({ isActive: false }), {
      params: Promise.resolve({ id: AGENT_ID, tokenId: 'bad-token' }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await PATCH(makePatchRequest({ isActive: false }), makeParams());

    expect(response.status).toBe(401);
  });

  it('returns 404 when token does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentEmbedToken.findFirst).mockResolvedValue(null);

    const response = await PATCH(makePatchRequest({ isActive: false }), makeParams());

    expect(response.status).toBe(404);
  });

  it('returns 400 when no fields are provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({}), makeParams());

    expect(response.status).toBe(400);
  });

  it('updates isActive to false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const updated = makeExistingToken({ isActive: false });
    vi.mocked(prisma.aiAgentEmbedToken.update).mockResolvedValue(updated as never);

    const response = await PATCH(makePatchRequest({ isActive: false }), makeParams());

    expect(response.status).toBe(200);
    expect(prisma.aiAgentEmbedToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false }),
      })
    );
  });

  it('updates label', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const updated = makeExistingToken({ label: 'New Label' });
    vi.mocked(prisma.aiAgentEmbedToken.update).mockResolvedValue(updated as never);

    const response = await PATCH(makePatchRequest({ label: 'New Label' }), makeParams());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { label: string } }>(response);
    expect(body.data.label).toBe('New Label');
  });
});

describe('DELETE /agents/:id/embed-tokens/:tokenId', () => {
  it('returns 400 when agent id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: 'bad-id', tokenId: TOKEN_ID }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await DELETE(makeDeleteRequest(), makeParams());

    expect(response.status).toBe(401);
  });

  it('returns 404 when token does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentEmbedToken.findFirst).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest(), makeParams());

    expect(response.status).toBe(404);
  });

  it('deletes the token and returns { deleted: true }', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await DELETE(makeDeleteRequest(), makeParams());

    expect(response.status).toBe(200);
    expect(prisma.aiAgentEmbedToken.delete).toHaveBeenCalledWith({ where: { id: TOKEN_ID } });
    const body = await parseJson<{ data: { deleted: boolean } }>(response);
    expect(body.data.deleted).toBe(true);
  });
});
