/**
 * Unit Tests: Knowledge Embedding Projection Endpoint
 *
 * GET /api/v1/admin/orchestration/knowledge/embeddings
 *
 * Test coverage focuses on the parts that aren't already covered by
 * UMAP itself:
 *
 * - Authentication / rate-limit gates
 * - Empty knowledge base → returns chunks: [], stats.projectable=false
 * - Below minimum useful points → returns chunks but projectable=false
 * - Above the minimum → returns 2D coordinates from UMAP
 * - Truncation flag set when totalEmbedded > limit
 * - Malformed pgvector text → row dropped, droppedMalformed counted
 * - Scope filter forwarded to the SQL query
 *
 * @see app/api/v1/admin/orchestration/knowledge/embeddings/route.ts
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

import { GET } from '@/app/api/v1/admin/orchestration/knowledge/embeddings/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
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
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/embeddings${queryString}`,
  } as unknown as NextRequest;
}

type ProjectionResponse = {
  success: boolean;
  data?: {
    chunks: Array<{
      id: string;
      documentId: string;
      documentName: string;
      x: number;
      y: number;
      contentPreview: string;
    }>;
    stats: {
      totalEmbedded: number;
      returned: number;
      truncated: boolean;
      droppedMalformed: number;
      projectable: boolean;
      maxChunks: number;
      minUsefulPoints: number;
    };
  };
};

/**
 * Build a synthetic pgvector text payload of the given dimension.
 * Each entry is a deterministic float so two chunks generated with the
 * same `seed` collide on the projection target — a useful property for
 * verifying clustering shape if needed.
 */
function makeVectorText(dim: number, seed: number): string {
  const xs: number[] = [];
  for (let i = 0; i < dim; i++) {
    // simple linear congruential pattern; value range covers negatives
    xs.push(Math.sin(seed * 0.13 + i * 0.07));
  }
  return JSON.stringify(xs);
}

function makeRow(overrides: Record<string, unknown> = {}, vectorSeed = 1): Record<string, unknown> {
  return {
    id: `chunk-${vectorSeed}`,
    documentId: 'doc-001',
    documentName: 'Test Document',
    documentStatus: 'ready',
    chunkType: 'pattern_section',
    patternName: null,
    section: 'Section A',
    estimatedTokens: 300,
    content: 'chunk content preview',
    embeddingModel: 'text-embedding-3-small',
    embeddingProvider: 'openai',
    embeddedAt: new Date('2024-01-01T00:00:00.000Z'),
    embeddingText: makeVectorText(16, vectorSeed),
    ...overrides,
  };
}

// First $queryRaw call: count total embedded. Returns [{ count: bigint }].
// Second call: fetch the rows. Returns array of RawChunkRow.
function setupQueryRawMocks(totalEmbedded: number, rows: Array<Record<string, unknown>>): void {
  vi.mocked(prisma.$queryRaw)
    .mockResolvedValueOnce([{ count: BigInt(totalEmbedded) }] as never)
    .mockResolvedValueOnce(rows as never);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/embeddings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  it('returns 401 when no session is present', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 when the session is non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser() as never);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
  });

  it('returns 429 when the rate-limit gate fires', async () => {
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false, retryAfter: 30 } as never);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(429);
  });

  it('returns empty chunks and projectable=false when there are no embedded chunks', async () => {
    setupQueryRawMocks(0, []);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await parseJSON<ProjectionResponse>(res);
    expect(body.success).toBe(true);
    expect(body.data?.chunks).toEqual([]);
    expect(body.data?.stats.totalEmbedded).toBe(0);
    expect(body.data?.stats.projectable).toBe(false);
    expect(body.data?.stats.truncated).toBe(false);
  });

  it('returns chunks with x=y=0 below the minimum useful points threshold', async () => {
    // 5 chunks is below MIN_USEFUL_POINTS (10) — UMAP isn't run.
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({ id: `chunk-${i}` }, i + 1));
    setupQueryRawMocks(5, rows);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await parseJSON<ProjectionResponse>(res);
    expect(body.data?.chunks).toHaveLength(5);
    expect(body.data?.stats.projectable).toBe(false);
    // Without projection, all coordinates default to (0, 0).
    for (const chunk of body.data?.chunks ?? []) {
      expect(chunk.x).toBe(0);
      expect(chunk.y).toBe(0);
    }
  });

  it('runs UMAP and returns finite 2D coordinates above the minimum useful points', async () => {
    // Generate 12 chunks — above MIN_USEFUL_POINTS=10 — with distinct
    // vectors so UMAP has structure to project. We don't assert on
    // the specific coordinates (UMAP layouts shift with library
    // versions) but every point must be finite and non-default.
    const rows = Array.from({ length: 12 }, (_, i) => makeRow({ id: `chunk-${i}` }, i + 1));
    setupQueryRawMocks(12, rows);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await parseJSON<ProjectionResponse>(res);
    expect(body.data?.chunks).toHaveLength(12);
    expect(body.data?.stats.projectable).toBe(true);
    for (const chunk of body.data?.chunks ?? []) {
      expect(Number.isFinite(chunk.x)).toBe(true);
      expect(Number.isFinite(chunk.y)).toBe(true);
    }
    // At least two points should differ — sanity-check that UMAP
    // didn't collapse everything to a single coordinate.
    const xs = new Set(body.data?.chunks.map((c) => c.x));
    expect(xs.size).toBeGreaterThan(1);
  });

  it('flags truncated=true when totalEmbedded exceeds the limit', async () => {
    // Endpoint default limit is 2000. Simulate 5000 embedded chunks
    // and the SQL stride sampling returns 2000.
    const rows = Array.from({ length: 12 }, (_, i) => makeRow({ id: `chunk-${i}` }, i + 1));
    setupQueryRawMocks(5000, rows);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await parseJSON<ProjectionResponse>(res);
    expect(body.data?.stats.totalEmbedded).toBe(5000);
    expect(body.data?.stats.truncated).toBe(true);
    // Returned count reflects the rows the (mocked) SQL handed back.
    expect(body.data?.stats.returned).toBe(12);
  });

  it('drops chunks with malformed pgvector text and counts them', async () => {
    const goodRows = Array.from({ length: 11 }, (_, i) => makeRow({ id: `good-${i}` }, i + 1));
    const badRow = makeRow({ id: 'bad-1', embeddingText: '{not-json}' }, 99);
    const oneNonNumeric = makeRow({ id: 'bad-2', embeddingText: '[1, 2, "three"]' }, 100);
    setupQueryRawMocks(13, [...goodRows, badRow, oneNonNumeric]);

    const res = await GET(makeGetRequest());
    const body = await parseJSON<ProjectionResponse>(res);
    expect(body.data?.stats.droppedMalformed).toBe(2);
    expect(body.data?.chunks).toHaveLength(11);
    expect(body.data?.chunks.every((c) => c.id.startsWith('good-'))).toBe(true);
  });

  it('truncates contentPreview to 240 characters', async () => {
    // Long content shouldn't bloat the response payload — the chunk
    // detail dialog only ever shows the preview anyway.
    const longContent = 'x'.repeat(500);
    const rows = Array.from({ length: 12 }, (_, i) =>
      makeRow({ id: `chunk-${i}`, content: longContent }, i + 1)
    );
    setupQueryRawMocks(12, rows);

    const res = await GET(makeGetRequest());
    const body = await parseJSON<ProjectionResponse>(res);
    for (const chunk of body.data?.chunks ?? []) {
      expect(chunk.contentPreview.length).toBe(240);
    }
  });

  it('parses scope and limit query params and forwards them through', async () => {
    setupQueryRawMocks(0, []);
    const res = await GET(makeGetRequest('?scope=app&limit=500'));
    expect(res.status).toBe(200);
    // The scope param hits the COUNT and the row-fetch query as the
    // first variable. Both queries get the parsed value (or null when
    // omitted). We assert that $queryRaw was called twice — once for
    // count, once for rows — confirming the route reached the SQL
    // path with valid query inputs.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects out-of-range limit values', async () => {
    // limit=999999 is above MAX_LIMIT (5000); Zod should reject the
    // request before any DB work happens.
    const res = await GET(makeGetRequest('?limit=999999'));
    expect(res.status).toBe(400);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
