/**
 * Tests: Admin Orchestration — Agent Embed Tokens (list + create)
 *
 * GET  /api/v1/admin/orchestration/agents/:id/embed-tokens
 * POST /api/v1/admin/orchestration/agents/:id/embed-tokens
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
    aiAgent: { findUnique: vi.fn() },
    aiAgentEmbedToken: {
      findMany: vi.fn(),
      create: vi.fn(),
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
import { GET, POST } from '@/app/api/v1/admin/orchestration/agents/[id]/embed-tokens/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    token: 'secret-abc',
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

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/embed-tokens`
  );
}

function makePostRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/embed-tokens`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function makeParams(id = AGENT_ID) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
  vi.mocked(prisma.aiAgentEmbedToken.findMany).mockResolvedValue([]);
  vi.mocked(prisma.aiAgentEmbedToken.create).mockResolvedValue(makeToken() as never);
});

describe('GET /agents/:id/embed-tokens', () => {
  it('returns 400 when agent id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeGetRequest(), makeParams('not-a-cuid'));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeGetRequest(), makeParams());

    expect(response.status).toBe(401);
  });

  it('returns 404 when agent does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const response = await GET(makeGetRequest(), makeParams());

    expect(response.status).toBe(404);
  });

  it('returns 200 with token list', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentEmbedToken.findMany).mockResolvedValue([makeToken()] as never);

    const response = await GET(makeGetRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[] }>(response);
    expect(body.data).toHaveLength(1);
  });

  it('returns empty list when agent has no tokens', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeGetRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[] }>(response);
    expect(body.data).toHaveLength(0);
  });
});

describe('POST /agents/:id/embed-tokens', () => {
  it('returns 400 when agent id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makePostRequest({ allowedOrigins: [] }), makeParams('bad-id'));

    expect(response.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makePostRequest(), makeParams());

    expect(response.status).toBe(401);
  });

  it('returns 404 when agent does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const response = await POST(makePostRequest(), makeParams());

    expect(response.status).toBe(404);
  });

  it('creates a token with label and allowedOrigins', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: AGENT_ID,
      name: 'Support Bot',
    } as never);
    const created = makeToken({ label: 'Blog', allowedOrigins: ['https://blog.com'] });
    vi.mocked(prisma.aiAgentEmbedToken.create).mockResolvedValue(created as never);

    const response = await POST(
      makePostRequest({ label: 'Blog', allowedOrigins: ['https://blog.com'] }),
      makeParams()
    );

    expect(response.status).toBe(201);
    const body = await parseJson<{ data: { label: string } }>(response);
    expect(body.data.label).toBe('Blog');
  });

  it('creates a token without label (no label field)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: AGENT_ID,
      name: 'Bot',
    } as never);

    const response = await POST(makePostRequest({ allowedOrigins: [] }), makeParams());

    expect(response.status).toBe(201);
    expect(prisma.aiAgentEmbedToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ label: null }),
      })
    );
  });

  it('rejects invalid allowedOrigins (non-URL)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makePostRequest({ allowedOrigins: ['not-a-url'] }), makeParams());

    expect(response.status).toBe(400);
  });
});
