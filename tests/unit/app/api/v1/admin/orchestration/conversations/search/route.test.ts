/**
 * Tests: Conversation Semantic Search
 *
 * GET /api/v1/admin/orchestration/conversations/search
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
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedText: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/admin/orchestration/conversations/search/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const FAKE_EMBEDDING = Array.from({ length: 1024 }, (_, i) => i * 0.001);

function makeSearchResult(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    conversationTitle: 'Test Conversation',
    agentId: 'agent-1',
    userId: 'user-1',
    conversationCreatedAt: new Date('2025-01-01'),
    messageId: 'msg-1',
    messageRole: 'assistant',
    messageContent: 'This is the matching message content',
    messageCreatedAt: new Date('2025-01-01T10:00:00Z'),
    agentName: 'Support Bot',
    agentSlug: 'support-bot',
    distance: 0.25,
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/conversations/search');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(embedText).mockResolvedValue(FAKE_EMBEDDING);
});

describe('GET /conversations/search', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeRequest({ q: 'test query' }));
    expect(response.status).toBe(401);
  });

  it('returns 422 when q is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await GET(makeRequest());
    expect(response.status).toBe(400);
  });

  it('returns search results ranked by similarity', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      makeSearchResult({ distance: 0.2 }),
      makeSearchResult({ conversationId: 'conv-2', messageId: 'msg-2', distance: 0.4 }),
    ]);

    const response = await GET(makeRequest({ q: 'customer support issue' }));
    expect(response.status).toBe(200);

    const body = await parseJson<{
      data: Array<{ conversationId: string; bestMatch: { similarity: number } }>;
      meta: { total: number };
    }>(response);

    expect(body.data).toHaveLength(2);
    expect(body.data[0].conversationId).toBe('conv-1');
    expect(body.data[0].bestMatch.similarity).toBeCloseTo(0.8);
    expect(body.data[1].bestMatch.similarity).toBeCloseTo(0.6);
    expect(body.meta.total).toBe(2);
  });

  it('deduplicates by conversation — keeps best match only', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      makeSearchResult({ conversationId: 'conv-1', messageId: 'msg-1', distance: 0.1 }),
      makeSearchResult({ conversationId: 'conv-1', messageId: 'msg-2', distance: 0.3 }),
    ]);

    const response = await GET(makeRequest({ q: 'test' }));
    const body = await parseJson<{ data: Array<{ conversationId: string }> }>(response);

    // Should only have one entry for conv-1 (the first/best match)
    expect(body.data).toHaveLength(1);
    expect(body.data[0].conversationId).toBe('conv-1');
  });

  it('passes filters to the SQL query', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    await GET(
      makeRequest({
        q: 'test',
        agentId: 'agent-42',
        userId: 'user-99',
        dateFrom: '2025-01-01',
        dateTo: '2025-06-30',
      })
    );

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0];

    // SQL should contain filter conditions
    expect(sql).toContain('"agentId"');
    expect(sql).toContain('"userId"');
    expect(sql).toContain('timestamptz');

    // Params should include the filter values (after embedding, threshold, limit)
    expect(params).toContain('agent-42');
    expect(params).toContain('user-99');
    expect(params).toContain('2025-01-01');
    expect(params).toContain('2025-06-30');
  });

  it('embeds the query text using embedText', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    await GET(makeRequest({ q: 'how do I reset my password' }));

    expect(embedText).toHaveBeenCalledWith('how do I reset my password', 'query');
  });

  it('truncates long message content in results', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const longContent = 'x'.repeat(1000);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      makeSearchResult({ messageContent: longContent }),
    ]);

    const response = await GET(makeRequest({ q: 'test' }));
    const body = await parseJson<{
      data: Array<{ bestMatch: { content: string } }>;
    }>(response);

    expect(body.data[0].bestMatch.content.length).toBe(500);
  });

  it('returns empty array when no matches found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    const response = await GET(makeRequest({ q: 'nonexistent query' }));
    expect(response.status).toBe(200);

    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  it('respects custom limit and threshold', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    await GET(makeRequest({ q: 'test', limit: '5', threshold: '0.5' }));

    const [_sql, _embedding, threshold, limit] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0];

    expect(threshold).toBe(0.5);
    expect(limit).toBe(5);
  });
});
