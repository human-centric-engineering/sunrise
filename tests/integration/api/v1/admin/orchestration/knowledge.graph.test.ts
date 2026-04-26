/**
 * Integration Test: Admin Orchestration — Knowledge Graph
 *
 * GET /api/v1/admin/orchestration/knowledge/graph
 *
 * @see app/api/v1/admin/orchestration/knowledge/graph/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Returns nodes, links, categories, and stats
 * - Scopes filter to "system" | "app" when provided
 * - view=embedded uses $queryRaw for embedded-only chunk aggregation
 * - Chunk nodes are included when total chunks <= 500 (threshold)
 * - Chunk nodes are excluded when total chunks > 500
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/graph/route';
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
    aiKnowledgeDocument: { findMany: vi.fn() },
    aiKnowledgeChunk: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DOC_ID = 'cmjbv4i3x00003wsloputgwul';
const CHUNK_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    name: 'Agent Patterns Guide',
    fileName: 'agent-patterns.pdf',
    status: 'ready',
    scope: 'app',
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    _count: { chunks: 10 },
    ...overrides,
  };
}

function makeChunk(overrides: Record<string, unknown> = {}) {
  return {
    id: CHUNK_ID,
    chunkKey: 'chunk-1',
    documentId: DOC_ID,
    chunkType: 'text',
    patternName: null,
    section: 'Introduction',
    estimatedTokens: 200,
    content: 'This is chunk content about agent patterns and orchestration.',
    ...overrides,
  };
}

function makeGroupByResult(documentId: string, chunkCount: number, totalTokens: number) {
  return {
    documentId,
    _sum: { estimatedTokens: totalTokens },
    _count: { id: chunkCount },
  };
}

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/knowledge/graph');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

interface GraphResponse {
  nodes: Array<{ id: string; name: string; type: string; category: number }>;
  links: Array<{ source: string; target: string }>;
  categories: Array<{ name: string }>;
  stats: {
    documentCount: number;
    completedCount: number;
    chunkCount: number;
    totalTokens: number;
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/graph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 for unauthenticated users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  it('returns 429 when rate limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await GET(makeRequest());

    expect(response.status).toBe(429);
    expect(vi.mocked(prisma.aiKnowledgeDocument.findMany)).not.toHaveBeenCalled();
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('returns 400 for invalid scope value', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeRequest({ scope: 'invalid' }));

    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid view value', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeRequest({ view: 'invalid' }));

    expect(response.status).toBe(400);
  });

  // ── Success: empty knowledge base ─────────────────────────────────────────

  it('returns 200 with only the central KB node when no documents exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: GraphResponse }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.nodes).toHaveLength(1);
    expect(body.data.nodes[0].id).toBe('kb');
    expect(body.data.nodes[0].type).toBe('kb');
    expect(body.data.links).toHaveLength(0);
    expect(body.data.stats.documentCount).toBe(0);
    expect(body.data.stats.chunkCount).toBe(0);
  });

  // ── Success: structure view (default) ─────────────────────────────────────

  it('returns document nodes and links to KB node', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([makeDocument()] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      makeGroupByResult(DOC_ID, 10, 2000),
    ] as never);
    // Chunk count (10) is <= 500, so findMany for chunks will be called
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([makeChunk()] as never);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: GraphResponse }>(response);

    // kb node + document node + chunk node = 3
    expect(body.data.nodes.length).toBeGreaterThanOrEqual(2);

    const docNode = body.data.nodes.find((n) => n.id === DOC_ID);
    expect(docNode).toBeDefined();
    expect(docNode?.type).toBe('document');

    // A link from kb -> document should exist
    const kbToDoc = body.data.links.find((l) => l.source === 'kb' && l.target === DOC_ID);
    expect(kbToDoc).toBeDefined();
  });

  it('assigns correct category index based on document status', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const readyId = 'cmjbv4i3x00003wsloputgwua';
    const failedId = 'cmjbv4i3x00003wsloputgwub';
    const pendingId = 'cmjbv4i3x00003wsloputgwuc';

    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      makeDocument({ id: readyId, status: 'ready' }),
      makeDocument({ id: failedId, status: 'failed' }),
      makeDocument({ id: pendingId, status: 'processing' }),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const response = await GET(makeRequest());
    const body = await parseJson<{ success: boolean; data: GraphResponse }>(response);

    const ready = body.data.nodes.find((n) => n.id === readyId);
    const failed = body.data.nodes.find((n) => n.id === failedId);
    const pending = body.data.nodes.find((n) => n.id === pendingId);

    expect(ready?.category).toBe(1); // Document (Ready)
    expect(failed?.category).toBe(3); // Document (Failed)
    expect(pending?.category).toBe(2); // Document (Pending)
  });

  it('returns correct stats counts', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      makeDocument({ status: 'ready' }),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      makeGroupByResult(DOC_ID, 25, 5000),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([makeChunk()] as never);

    const response = await GET(makeRequest());
    const body = await parseJson<{ success: boolean; data: GraphResponse }>(response);

    expect(body.data.stats.documentCount).toBe(1);
    expect(body.data.stats.completedCount).toBe(1);
    expect(body.data.stats.chunkCount).toBe(25);
    expect(body.data.stats.totalTokens).toBe(5000);
  });

  it('includes 5 categories in every response', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const response = await GET(makeRequest());
    const body = await parseJson<{ success: boolean; data: GraphResponse }>(response);

    expect(body.data.categories).toHaveLength(5);
    expect(body.data.categories[0].name).toBe('Knowledge Base');
    expect(body.data.categories[4].name).toBe('Chunk');
  });

  // ── Chunk threshold ───────────────────────────────────────────────────────

  it('includes chunk nodes when total chunks are below the 500 threshold', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([makeDocument()] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      makeGroupByResult(DOC_ID, 5, 1000),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ id: 'chunk-1' }),
      makeChunk({ id: 'chunk-2' }),
    ] as never);

    const response = await GET(makeRequest());
    const body = await parseJson<{ success: boolean; data: GraphResponse }>(response);

    const chunkNodes = body.data.nodes.filter((n) => n.type === 'chunk');
    expect(chunkNodes.length).toBeGreaterThan(0);

    // Link from document -> chunk should exist
    const docToChunk = body.data.links.find((l) => l.source === DOC_ID);
    expect(docToChunk).toBeDefined();
  });

  it('excludes chunk nodes when total chunks exceed the 500 threshold', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      makeDocument({ _count: { chunks: 600 } }),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      makeGroupByResult(DOC_ID, 600, 120000),
    ] as never);
    // findMany should NOT be called since we're over the threshold

    const response = await GET(makeRequest());
    const body = await parseJson<{ success: boolean; data: GraphResponse }>(response);

    const chunkNodes = body.data.nodes.filter((n) => n.type === 'chunk');
    expect(chunkNodes).toHaveLength(0);
    expect(vi.mocked(prisma.aiKnowledgeChunk.findMany)).not.toHaveBeenCalled();
  });

  // ── Scope filter ──────────────────────────────────────────────────────────

  it('passes scope filter to document query when scope param is provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    await GET(makeRequest({ scope: 'system' }));

    expect(vi.mocked(prisma.aiKnowledgeDocument.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scope: 'system' }),
      })
    );
  });

  it('does not filter scope when param is omitted', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    await GET(makeRequest());

    expect(vi.mocked(prisma.aiKnowledgeDocument.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ scope: expect.anything() }),
      })
    );
  });

  // ── Embedded view ─────────────────────────────────────────────────────────

  it('uses $queryRaw for chunk aggregation in embedded view', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([makeDocument()] as never);
    // embedded view uses $queryRaw for aggregation and chunk fetch
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { documentId: DOC_ID, chunk_count: BigInt(3), total_tokens: BigInt(600) },
      ] as never)
      .mockResolvedValueOnce([] as never); // chunk rows (empty, so no chunk nodes)

    const response = await GET(makeRequest({ view: 'embedded' }));

    expect(response.status).toBe(200);
    // $queryRaw should be called at least once (aggregation)
    expect(vi.mocked(prisma.$queryRaw)).toHaveBeenCalled();
    // groupBy should NOT be called in embedded mode
    expect(vi.mocked(prisma.aiKnowledgeChunk.groupBy)).not.toHaveBeenCalled();
  });

  it('filters out documents with zero embedded chunks in embedded view', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const docWithChunks = makeDocument({ id: 'cmjbv4i3x00003wsloputgwua' });
    const docWithoutChunks = makeDocument({ id: 'cmjbv4i3x00003wsloputgwub' });

    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      docWithChunks,
      docWithoutChunks,
    ] as never);
    // Aggregation only returns result for docWithChunks
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          documentId: 'cmjbv4i3x00003wsloputgwua',
          chunk_count: BigInt(5),
          total_tokens: BigInt(1000),
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const response = await GET(makeRequest({ view: 'embedded' }));
    const body = await parseJson<{ success: boolean; data: GraphResponse }>(response);

    // Only the document with embedded chunks should appear
    const docNodes = body.data.nodes.filter((n) => n.type === 'document');
    expect(docNodes).toHaveLength(1);
    expect(docNodes[0].id).toBe('cmjbv4i3x00003wsloputgwua');
  });
});
