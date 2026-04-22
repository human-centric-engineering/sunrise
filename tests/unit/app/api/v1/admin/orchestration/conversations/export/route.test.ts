/**
 * Tests: Conversation Export
 *
 * GET /api/v1/admin/orchestration/conversations/export
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
    aiConversation: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() => new Response('Rate limited', { status: 429 })),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn().mockResolvedValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET as ExportConversations } from '@/app/api/v1/admin/orchestration/conversations/export/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'Hello world',
    metadata: {},
    createdAt: new Date('2025-01-01T10:00:00Z'),
    ...overrides,
  };
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    title: 'Test Conversation',
    userId: 'user-1',
    agentId: 'agent-1',
    isActive: true,
    createdAt: new Date('2025-01-01T09:00:00Z'),
    updatedAt: new Date('2025-01-01T10:00:00Z'),
    agent: { id: 'agent-1', name: 'Test Agent', slug: 'test-agent' },
    messages: [makeMessage()],
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/conversations/export');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('GET /conversations/export', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await ExportConversations(makeRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: {
        id: 'session_1',
        userId: 'user_1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: 'user_1',
        name: 'Regular User',
        email: 'user@example.com',
        emailVerified: true,
        image: null,
        role: 'USER',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await ExportConversations(makeRequest());

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await ExportConversations(makeRequest());

    expect(response.status).toBe(429);
  });

  it('returns JSON export by default', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([makeConversation()] as never);

    const response = await ExportConversations(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(response.headers.get('Content-Disposition')).toContain('.json');

    const body = await parseJson<{ success: boolean; data: unknown[]; meta: { total: number } }>(
      response
    );
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('returns CSV export when format=csv', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([makeConversation()] as never);

    const response = await ExportConversations(makeRequest({ format: 'csv' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain('.csv');

    const text = await response.text();
    expect(text).toContain('conversation_id,conversation_title');
    expect(text).toContain('conv-1');
    expect(text).toContain('Hello world');
  });

  it('filters by agentId when provided', async () => {
    // agentId must be a valid CUID (cuidSchema)
    const validAgentId = 'clxxxxxxxxxxxxxxxxxxxxxxx';
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);

    await ExportConversations(makeRequest({ agentId: validAgentId }));

    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agentId: validAgentId }),
      })
    );
  });

  it('filters by userId when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);

    await ExportConversations(makeRequest({ userId: 'user-42' }));

    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-42' }),
      })
    );
  });

  it('filters by title substring (q) when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);

    await ExportConversations(makeRequest({ q: 'onboarding' }));

    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          title: { contains: 'onboarding', mode: 'insensitive' },
        }),
      })
    );
  });

  it('filters by messageSearch when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);

    await ExportConversations(makeRequest({ messageSearch: 'refund' }));

    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          messages: { some: { content: { contains: 'refund', mode: 'insensitive' } } },
        }),
      })
    );
  });

  it('filters by tag when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);

    await ExportConversations(makeRequest({ tag: 'vip' }));

    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tags: { has: 'vip' } }),
      })
    );
  });

  it('filters by isActive when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);

    await ExportConversations(makeRequest({ isActive: 'false' }));

    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: false }),
      })
    );
  });

  it('filters by dateFrom and dateTo when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);

    // Schema requires ISO datetime strings with UTC Z offset
    await ExportConversations(
      makeRequest({
        dateFrom: '2025-01-01T00:00:00Z',
        dateTo: '2025-01-31T23:59:59Z',
      })
    );

    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          updatedAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      })
    );
  });

  it('returns 400 for invalid format value', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await ExportConversations(makeRequest({ format: 'xml' }));

    expect(response.status).toBe(400);
  });

  it('returns empty JSON export when no conversations match', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);

    const response = await ExportConversations(makeRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  it('properly escapes CSV values containing commas', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([
      makeConversation({
        title: 'Title, with comma',
        messages: [makeMessage({ content: 'Content "with" quotes' })],
      }),
    ] as never);

    const response = await ExportConversations(makeRequest({ format: 'csv' }));
    const text = await response.text();

    expect(text).toContain('"Title, with comma"');
    expect(text).toContain('"Content ""with"" quotes"');
  });

  it('includes messages in JSON export', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([
      makeConversation({
        messages: [
          makeMessage({ id: 'msg-1', role: 'user', content: 'Question?' }),
          makeMessage({ id: 'msg-2', role: 'assistant', content: 'Answer!' }),
        ],
      }),
    ] as never);

    const response = await ExportConversations(makeRequest());
    const body = await parseJson<{
      data: Array<{ messages: Array<{ id: string; role: string }> }>;
    }>(response);

    expect(body.data[0].messages).toHaveLength(2);
    expect(body.data[0].messages[0].role).toBe('user');
    expect(body.data[0].messages[1].role).toBe('assistant');
  });

  it('limits result to MAX_EXPORT_CONVERSATIONS', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);

    await ExportConversations(makeRequest());

    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 })
    );
  });
});
