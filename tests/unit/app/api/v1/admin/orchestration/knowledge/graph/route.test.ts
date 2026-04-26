/**
 * Unit Tests: Knowledge Graph Endpoint
 *
 * GET /api/v1/admin/orchestration/knowledge/graph
 *
 * Test Coverage:
 * - Happy path: structure view returns nodes / links / categories / stats
 * - Empty knowledge base (no documents) → minimal graph with only KB root node
 * - Scope filter applied to document query
 * - Chunk-node threshold: totalChunks > 500 suppresses chunk nodes
 * - Document with errorMessage → errorMessage included in node metadata
 * - Document without errorMessage → errorMessage absent from node metadata
 * - Document with chunkCount === 0 → link label is "contains" (not "contains (N chunks)")
 * - Embedded view: raw-query path, filters out docs with zero embedded chunks
 * - Chunk edge-label variants: pattern_overview, pattern_section (with/without section), glossary, fallback
 * - Chunk with embeddingModel / embeddingProvider / embeddedAt → included in metadata
 * - Chunk missing those optional fields → absent from metadata
 * - Rate limiting: returns 429 when limit exceeded
 * - Unauthenticated / non-admin: returns 401/403
 *
 * @see app/api/v1/admin/orchestration/knowledge/graph/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { parseJSON } from '@/tests/helpers/assertions';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      findMany: vi.fn(),
    },
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

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { GET } from '@/app/api/v1/admin/orchestration/knowledge/graph/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGetRequest(queryString = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/graph${queryString}`,
  } as unknown as NextRequest;
}

interface GraphNode {
  id: string;
  name: string;
  type: string;
  category: number;
  metadata: Record<string, unknown>;
}

interface GraphLink {
  source: string;
  target: string;
  label: string;
}

interface GraphResponse {
  success: boolean;
  data: {
    nodes: GraphNode[];
    links: GraphLink[];
    categories: Array<{ name: string }>;
    stats: {
      documentCount: number;
      completedCount: number;
      chunkCount: number;
      totalTokens: number;
    };
  };
}

const BASE_CREATED_AT = new Date('2024-01-01T00:00:00.000Z');

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-001',
    name: 'Test Document',
    fileName: 'test.md',
    status: 'ready',
    scope: null,
    errorMessage: null,
    createdAt: BASE_CREATED_AT,
    _count: { chunks: 3 },
    ...overrides,
  };
}

function makeChunkGroupBy(documentId = 'doc-001') {
  return {
    documentId,
    _sum: { estimatedTokens: 900 },
    _count: { id: 3 },
  };
}

function makeChunk(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chunk-001',
    chunkKey: 'key-001',
    documentId: 'doc-001',
    chunkType: 'text',
    patternName: null,
    section: null,
    estimatedTokens: 300,
    content: 'chunk content',
    embeddingModel: null,
    embeddingProvider: null,
    embeddedAt: null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/graph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);

    // Default: one document, three chunks (below 500 threshold)
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([makeDocument()] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([makeChunkGroupBy()] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([makeChunk()] as never);
  });

  // ── Happy path — structure view ──────────────────────────────────────────

  it('returns 200 with nodes, links, categories, and stats', async () => {
    // Arrange — default mocks set in beforeEach

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: response shape matches contract
    expect(res.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.categories).toHaveLength(5);
    expect(body.data.stats.documentCount).toBe(1);
    expect(body.data.stats.chunkCount).toBe(3);
  });

  it('includes KB root node, document node, and chunk node', async () => {
    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: KB root, one doc node, one chunk node
    const types = body.data.nodes.map((n) => n.type);
    expect(types).toContain('kb');
    expect(types).toContain('document');
    expect(types).toContain('chunk');

    // KB root metadata encodes scope=all when no scope param given
    const kbNode = body.data.nodes.find((n) => n.id === 'kb');
    expect(kbNode?.metadata.scope).toBe('all');
    expect(kbNode?.metadata.view).toBe('structure');
  });

  it('applies scope param to document query and KB node metadata', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      makeDocument({ scope: 'app' }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest('?scope=app'));
    const body = await parseJSON<GraphResponse>(res);

    // Assert: findMany called with scope filter
    expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scope: 'app' }),
      })
    );
    // KB node metadata reflects scope
    const kbNode = body.data.nodes.find((n) => n.id === 'kb');
    expect(kbNode?.metadata.scope).toBe('app');
  });

  // ── Empty graph ──────────────────────────────────────────────────────────

  it('returns only the KB root node when there are no documents', async () => {
    // Arrange: empty knowledge base — no docs, no chunks
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([] as never);
    // showChunks=true (0<=500) but filteredDocIds is empty so findMany returns nothing
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: only the KB root, no document or chunk nodes, no links
    expect(res.status).toBe(200);
    expect(body.data.nodes).toHaveLength(1);
    expect(body.data.nodes[0].id).toBe('kb');
    expect(body.data.links).toHaveLength(0);
    expect(body.data.stats.documentCount).toBe(0);
    expect(body.data.stats.chunkCount).toBe(0);
  });

  // ── Chunk threshold ──────────────────────────────────────────────────────

  it('omits chunk nodes when totalChunks exceeds 500', async () => {
    // Arrange: groupBy returns 501 chunks across documents
    const manyChunkAgg = { ...makeChunkGroupBy(), _count: { id: 501 } };
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([manyChunkAgg] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: no chunk-type nodes; findMany for chunks never called
    const chunkNodes = body.data.nodes.filter((n) => n.type === 'chunk');
    expect(chunkNodes).toHaveLength(0);
    expect(prisma.aiKnowledgeChunk.findMany).not.toHaveBeenCalled();
  });

  // ── Document metadata: errorMessage conditional ──────────────────────────

  it('includes errorMessage in document node metadata when present', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      makeDocument({ status: 'failed', errorMessage: 'Parse error at line 42' }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: errorMessage propagated into node metadata
    const docNode = body.data.nodes.find((n) => n.type === 'document');
    expect(docNode?.metadata.errorMessage).toBe('Parse error at line 42');
  });

  it('omits errorMessage from document node metadata when null', async () => {
    // Arrange: default document has errorMessage: null

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: errorMessage key absent
    const docNode = body.data.nodes.find((n) => n.type === 'document');
    expect(docNode?.metadata).not.toHaveProperty('errorMessage');
  });

  // ── Link label: chunkCount === 0 ─────────────────────────────────────────

  it('uses plain "contains" link label when a document has no chunks', async () => {
    // Arrange: doc with zero chunks in both groupBy and _count
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      makeDocument({ _count: { chunks: 0 } }),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { documentId: 'doc-001', _sum: { estimatedTokens: 0 }, _count: { id: 0 } },
    ] as never);
    // 0 total chunks → showChunks true but findMany returns nothing
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: link to the document has label "contains" (not "contains (0 chunks)")
    const docLink = body.data.links.find((l) => l.target === 'doc-001');
    expect(docLink?.label).toBe('contains');
  });

  it('uses "contains (N chunks)" link label when chunkCount > 0', async () => {
    // Arrange: default doc has 3 chunks

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert
    const docLink = body.data.links.find((l) => l.target === 'doc-001');
    expect(docLink?.label).toBe('contains (3 chunks)');
  });

  // ── Chunk edge-label variants ────────────────────────────────────────────

  it('labels chunk edge as "overview" for pattern_overview chunk type', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ chunkType: 'pattern_overview' }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: chunk→document link has "overview" label
    const chunkLink = body.data.links.find(
      (l) => l.source === 'doc-001' && l.target === 'chunk-001'
    );
    expect(chunkLink?.label).toBe('overview');
  });

  it('labels chunk edge as "section: <name>" for pattern_section with a section', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ chunkType: 'pattern_section', section: 'Introduction' }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert
    const chunkLink = body.data.links.find((l) => l.target === 'chunk-001');
    expect(chunkLink?.label).toBe('section: Introduction');
  });

  it('labels chunk edge as "section" for pattern_section without a section', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ chunkType: 'pattern_section', section: null }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: falls back to "section" when section is null
    const chunkLink = body.data.links.find((l) => l.target === 'chunk-001');
    expect(chunkLink?.label).toBe('section');
  });

  it('labels chunk edge as "glossary" for glossary chunk type', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ chunkType: 'glossary' }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert
    const chunkLink = body.data.links.find((l) => l.target === 'chunk-001');
    expect(chunkLink?.label).toBe('glossary');
  });

  it('uses human-readable label for unknown chunk types (underscore→space)', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ chunkType: 'code_block' }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: underscores replaced with spaces
    const chunkLink = body.data.links.find((l) => l.target === 'chunk-001');
    expect(chunkLink?.label).toBe('code block');
  });

  // ── Chunk metadata: optional embedding fields ────────────────────────────

  it('includes embeddingModel/Provider/embeddedAt in chunk metadata when present', async () => {
    // Arrange
    const embeddedAt = new Date('2024-06-01T00:00:00.000Z');
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({
        embeddingModel: 'text-embedding-3-small',
        embeddingProvider: 'openai',
        embeddedAt,
      }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: all three optional fields present
    const chunkNode = body.data.nodes.find((n) => n.type === 'chunk');
    expect(chunkNode?.metadata.embeddingModel).toBe('text-embedding-3-small');
    expect(chunkNode?.metadata.embeddingProvider).toBe('openai');
    expect(chunkNode?.metadata.embeddedAt).toBeDefined();
  });

  it('omits embeddingModel/Provider/embeddedAt from chunk metadata when null', async () => {
    // Arrange: default chunk has null for all optional embedding fields

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: optional fields absent from metadata
    const chunkNode = body.data.nodes.find((n) => n.type === 'chunk');
    expect(chunkNode?.metadata).not.toHaveProperty('embeddingModel');
    expect(chunkNode?.metadata).not.toHaveProperty('embeddingProvider');
    expect(chunkNode?.metadata).not.toHaveProperty('embeddedAt');
  });

  // ── Embedded view ────────────────────────────────────────────────────────

  it('uses raw query for chunk aggregates in embedded view', async () => {
    // Arrange: embedded view; $queryRaw returns aggregates and chunk rows
    vi.mocked(prisma.$queryRaw)
      // First call: aggregate stats per document
      .mockResolvedValueOnce([
        { documentId: 'doc-001', chunk_count: BigInt(2), total_tokens: BigInt(600) },
      ] as never)
      // Second call: individual chunk rows for node building
      .mockResolvedValueOnce([makeChunk({ id: 'chunk-emb-001' })] as never);

    // Act
    const res = await GET(makeGetRequest('?view=embedded'));
    const body = await parseJSON<GraphResponse>(res);

    // Assert: raw query used (groupBy not called), response still valid
    expect(res.status).toBe(200);
    expect(prisma.aiKnowledgeChunk.groupBy).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    // Chunk node built from raw query result
    const chunkNode = body.data.nodes.find((n) => n.id === 'chunk-emb-001');
    expect(chunkNode?.type).toBe('chunk');
  });

  it('excludes documents with zero embedded chunks in embedded view', async () => {
    // Arrange: two documents; only doc-002 has embedded chunks
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      makeDocument({ id: 'doc-001', name: 'No Embeds' }),
      makeDocument({ id: 'doc-002', name: 'Has Embeds' }),
    ] as never);

    vi.mocked(prisma.$queryRaw)
      // Aggregate: only doc-002 has embedded chunks
      .mockResolvedValueOnce([
        { documentId: 'doc-002', chunk_count: BigInt(2), total_tokens: BigInt(400) },
      ] as never)
      // Chunk rows for doc-002 only
      .mockResolvedValueOnce([makeChunk({ id: 'chunk-002', documentId: 'doc-002' })] as never);

    // Act
    const res = await GET(makeGetRequest('?view=embedded'));
    const body = await parseJSON<GraphResponse>(res);

    // Assert: doc-001 excluded (zero embedded chunks), doc-002 included
    expect(res.status).toBe(200);
    const docNodes = body.data.nodes.filter((n) => n.type === 'document');
    expect(docNodes).toHaveLength(1);
    expect(docNodes[0].id).toBe('doc-002');
    expect(body.data.stats.documentCount).toBe(1);
  });

  // ── Document status category indices ─────────────────────────────────────

  it('assigns category 1 (Document Ready) to ready documents', async () => {
    // Arrange: default document has status 'ready'

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert
    const docNode = body.data.nodes.find((n) => n.type === 'document');
    expect(docNode?.category).toBe(1);
  });

  it('assigns category 3 (Document Failed) to failed documents', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      makeDocument({ status: 'failed', errorMessage: 'fail reason' }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert
    const docNode = body.data.nodes.find((n) => n.type === 'document');
    expect(docNode?.category).toBe(3);
  });

  it('assigns category 2 (Document Pending) to processing/pending documents', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      makeDocument({ status: 'processing' }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: processing maps to 2 (Pending/Processing)
    const docNode = body.data.nodes.find((n) => n.type === 'document');
    expect(docNode?.category).toBe(2);
  });

  // ── Chunk node: section name vs chunkType as display name ────────────────

  it('uses section as chunk node name when section is set', async () => {
    // Arrange
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ section: 'Background' }),
    ] as never);

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert: section takes priority over chunkType for display name
    const chunkNode = body.data.nodes.find((n) => n.type === 'chunk');
    expect(chunkNode?.name).toBe('Background');
  });

  it('falls back to chunkType as chunk node name when section is null', async () => {
    // Arrange: default chunk has section: null, chunkType: 'text'

    // Act
    const res = await GET(makeGetRequest());
    const body = await parseJSON<GraphResponse>(res);

    // Assert
    const chunkNode = body.data.nodes.find((n) => n.type === 'chunk');
    expect(chunkNode?.name).toBe('text');
  });

  // ── Rate limiting ────────────────────────────────────────────────────────

  it('returns 429 when rate limit is exceeded', async () => {
    // Arrange
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    // Act
    const res = await GET(makeGetRequest());

    // Assert: early return from rate limiter
    expect(res.status).toBe(429);
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.findMany).not.toHaveBeenCalled();
  });

  // ── Authentication ───────────────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

    // Act
    const res = await GET(makeGetRequest());

    // Assert
    expect(res.status).toBe(401);
    expect(prisma.aiKnowledgeDocument.findMany).not.toHaveBeenCalled();
  });

  it('returns 403 when authenticated but not admin', async () => {
    // Arrange: regular user, not admin
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER') as never);

    // Act
    const res = await GET(makeGetRequest());

    // Assert
    expect(res.status).toBe(403);
    expect(prisma.aiKnowledgeDocument.findMany).not.toHaveBeenCalled();
  });

  // ── Query validation ─────────────────────────────────────────────────────

  it('returns 400 for invalid scope parameter', async () => {
    // Act
    const res = await GET(makeGetRequest('?scope=invalid'));

    // Assert: Zod validation rejects unknown scope value
    expect(res.status).toBe(400);
    expect(prisma.aiKnowledgeDocument.findMany).not.toHaveBeenCalled();
  });
});
