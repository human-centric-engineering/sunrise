/**
 * Admin Orchestration — Knowledge embedding projection
 *
 * GET /api/v1/admin/orchestration/knowledge/embeddings
 *
 * Returns chunk metadata plus a 2D UMAP projection of each chunk's
 * 1,536-dimension embedding vector. Drives the "Embedding space" view
 * in `components/admin/orchestration/knowledge/embedding-projection-view.tsx`,
 * where points cluster by semantic similarity (UMAP preserves local
 * neighbour structure during the dimensionality reduction).
 *
 * Why server-side UMAP, not client-side:
 *   - Each chunk is a 1,536-dim Float64. Shipping 1,000 chunks = ~12 MB
 *     of JSON. Running UMAP server-side and returning two floats per
 *     chunk drops the payload by ~99% (a few hundred KB) while still
 *     letting the browser render the scatter plot.
 *   - Server CPU >> browser CPU; UMAP iterations finish faster.
 *   - Keeps the projection a pure function of stored data (browser
 *     session can't drift the layout).
 *
 * Stability: UMAP is non-deterministic by default. We pass a seeded
 * PRNG (`random: seededRandom(seed)`) so successive requests with the
 * same dataset produce the same layout — without that, every refresh
 * would shuffle the coordinates and break the user's mental map of
 * which clusters are which.
 *
 * Query params:
 *   scope     — "system" | "app" (optional, omit for all)
 *   limit     — Max chunks to project (default 2000, max 5000). When
 *               the embedded chunk count exceeds this, we sample
 *               uniformly (every Nth chunk by id ordering) and set
 *               `truncated: true` in the stats so the UI can warn.
 *   nNeighbors — UMAP nNeighbors override (default 15). Documented
 *                here so power users can experiment from the URL.
 *
 * Authentication: Admin role required. Rate-limited (compute is
 * non-trivial — a request per few seconds is fine, hammering it isn't).
 */

import { z } from 'zod';
import { UMAP } from 'umap-js';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

/**
 * Hard cap on how many chunks we'll project per request. Above this
 * UMAP starts taking >10s on a typical box, and the resulting scatter
 * plot is too dense to read anyway. We sample uniformly past this and
 * surface a warning in the response.
 */
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 2000;

/**
 * Soft floor — UMAP needs at least this many points to produce a
 * meaningful 2D embedding. With 5–10 points the layout is essentially
 * random; we still return what we have but the UI shows a hint.
 */
const MIN_USEFUL_POINTS = 10;

const querySchema = z.object({
  scope: z.enum(['system', 'app']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  nNeighbors: z.coerce.number().int().min(2).max(100).default(15),
});

/**
 * Tiny seeded PRNG (mulberry32). UMAP only needs a `() => number in [0, 1)`,
 * not a high-quality crypto RNG, so this is enough to make successive
 * requests against the same data return the same layout. We bump the
 * seed if we ever change the projection contract so old clients don't
 * cache stale coordinates.
 */
function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTION_SEED = 0x5ec0d3;

/**
 * Parse pgvector's text representation `"[v1,v2,...]"` into number[].
 * The Prisma raw client returns the column as a string (because the
 * column is declared `Unsupported("vector(1536)")`), and pgvector's
 * text format is JSON-array-compatible.
 */
function parseVector(text: string): number[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return null;
    const items = parsed as unknown[];
    const out = new Array<number>(items.length);
    for (let i = 0; i < items.length; i++) {
      const v = items[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      out[i] = v;
    }
    return out;
  } catch {
    return null;
  }
}

interface RawChunkRow {
  id: string;
  documentId: string;
  documentName: string;
  documentStatus: string;
  chunkType: string;
  patternName: string | null;
  section: string | null;
  estimatedTokens: number | null;
  content: string;
  embeddingModel: string | null;
  embeddingProvider: string | null;
  embeddedAt: Date | null;
  embeddingText: string;
}

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { scope, limit, nNeighbors } = validateQueryParams(searchParams, querySchema);

  // Count embedded chunks first so we can decide whether to sample.
  // The scope filter joins on the document table; we keep the join in
  // raw SQL because the chunk table's `embedding` column is pgvector
  // (Unsupported in the typed Prisma client).
  const totalEmbeddedRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(c.id)::bigint AS count
      FROM ai_knowledge_chunk c
      JOIN ai_knowledge_document d ON d.id = c."documentId"
     WHERE c.embedding IS NOT NULL
       AND (${scope ?? null}::text IS NULL OR d.scope = ${scope ?? null}::text)
  `;
  const totalEmbedded = Number(totalEmbeddedRows[0]?.count ?? 0);
  const truncated = totalEmbedded > limit;

  // Uniform sampling: when totalEmbedded > limit, take every (totalEmbedded / limit)-th
  // chunk by id ordering. We use a window function so the sample stride
  // is computed inside the query rather than streaming everything to
  // Node first.
  const stride = truncated ? Math.ceil(totalEmbedded / limit) : 1;

  const rows = await prisma.$queryRaw<RawChunkRow[]>`
    WITH numbered AS (
      SELECT
        c.id,
        c."documentId",
        d.name AS "documentName",
        d.status AS "documentStatus",
        c."chunkType",
        c."patternName",
        c.section,
        c."estimatedTokens",
        c.content,
        c."embeddingModel",
        c."embeddingProvider",
        c."embeddedAt",
        c.embedding::text AS "embeddingText",
        ROW_NUMBER() OVER (ORDER BY c.id) AS rn
      FROM ai_knowledge_chunk c
      JOIN ai_knowledge_document d ON d.id = c."documentId"
      WHERE c.embedding IS NOT NULL
        AND (${scope ?? null}::text IS NULL OR d.scope = ${scope ?? null}::text)
    )
    SELECT id, "documentId", "documentName", "documentStatus", "chunkType",
           "patternName", section, "estimatedTokens", content,
           "embeddingModel", "embeddingProvider", "embeddedAt", "embeddingText"
      FROM numbered
     WHERE (rn - 1) % ${stride}::bigint = 0
     ORDER BY rn
     LIMIT ${limit}::int
  `;

  // Parse each pgvector text blob into a number[] and drop rows whose
  // vector was malformed. A malformed embedding is a data integrity
  // problem worth surfacing in logs, but we keep going — one bad row
  // shouldn't deny the whole projection.
  const parsedChunks: Array<RawChunkRow & { vector: number[] }> = [];
  let droppedMalformed = 0;
  for (const row of rows) {
    const v = parseVector(row.embeddingText);
    if (!v) {
      droppedMalformed++;
      continue;
    }
    parsedChunks.push({ ...row, vector: v });
  }
  if (droppedMalformed > 0) {
    log.warn('Dropped chunks with malformed embedding text during projection', {
      droppedMalformed,
      retained: parsedChunks.length,
    });
  }

  // Build the response. Project only when we have enough points to
  // make UMAP behave sensibly; below the floor the user gets back the
  // chunks with x=y=0 plus a stats flag the UI can render as a hint.
  const projectable = parsedChunks.length >= MIN_USEFUL_POINTS;

  let projection: Array<[number, number]> = [];
  if (projectable) {
    // Clamp nNeighbors to (totalPoints - 1). UMAP rejects nNeighbors >=
    // dataset size (it can't find k+1 neighbours) — we silently lower
    // rather than 400 the request.
    const effectiveNeighbors = Math.min(nNeighbors, parsedChunks.length - 1);
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: effectiveNeighbors,
      minDist: 0.1,
      spread: 1,
      random: seededRandom(PROJECTION_SEED),
    });
    const result = umap.fit(parsedChunks.map((c) => c.vector));
    // umap-js returns number[][] where each inner array has length
    // `nComponents`. We've fixed that to 2, so destructure to a tuple.
    projection = result.map((coords): [number, number] => [coords[0] ?? 0, coords[1] ?? 0]);
  }

  const chunks = parsedChunks.map((c, i) => ({
    id: c.id,
    documentId: c.documentId,
    documentName: c.documentName,
    documentStatus: c.documentStatus,
    chunkType: c.chunkType,
    patternName: c.patternName,
    section: c.section,
    estimatedTokens: c.estimatedTokens ?? 0,
    contentPreview: c.content.slice(0, 240),
    embeddingModel: c.embeddingModel,
    embeddingProvider: c.embeddingProvider,
    embeddedAt: c.embeddedAt,
    x: projection[i]?.[0] ?? 0,
    y: projection[i]?.[1] ?? 0,
  }));

  log.info('Knowledge embedding projection computed', {
    totalEmbedded,
    returned: chunks.length,
    truncated,
    droppedMalformed,
    projectable,
    nNeighbors,
    scope: scope ?? 'all',
  });

  return successResponse({
    chunks,
    stats: {
      totalEmbedded,
      returned: chunks.length,
      truncated,
      droppedMalformed,
      projectable,
      maxChunks: limit,
      minUsefulPoints: MIN_USEFUL_POINTS,
    },
  });
});
