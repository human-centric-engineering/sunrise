/**
 * Knowledge Base Search Service
 *
 * Hybrid search combining vector similarity (pgvector cosine distance)
 * with optional keyword matching (PostgreSQL full-text search) and
 * metadata filtering.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { embedText } from './embedder';
import type { KnowledgeSearchResult, PatternSummary } from '@/types/orchestration';
import type { AiKnowledgeChunk } from '@/types/prisma';

/** Default similarity threshold (lower = more similar for cosine distance) */
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_LIMIT = 10;

/** Search filter options */
export interface SearchFilters {
  chunkType?: string;
  patternNumber?: number;
  category?: string;
  section?: string;
  documentId?: string;
}

/**
 * Search the knowledge base using hybrid vector + keyword search.
 *
 * Embeds the query, then performs cosine similarity search via pgvector's
 * <=> operator. Optionally boosts results that match keywords via
 * PostgreSQL's full-text search (to_tsvector/plainto_tsquery).
 *
 * @param query - Natural language search query
 * @param filters - Optional metadata filters
 * @param limit - Maximum results to return (default 10)
 * @param threshold - Maximum cosine distance threshold (default 0.8)
 * @returns Ranked results with similarity scores
 */
export async function searchKnowledge(
  query: string,
  filters?: SearchFilters,
  limit: number = DEFAULT_LIMIT,
  threshold: number = DEFAULT_THRESHOLD
): Promise<KnowledgeSearchResult[]> {
  logger.info('Knowledge search', { query, filters, limit, threshold });

  // Generate query embedding
  const queryEmbedding = await embedText(query);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // Build WHERE clauses for metadata filters
  const conditions: string[] = ['c.embedding IS NOT NULL'];
  const params: unknown[] = [embeddingStr, threshold, limit];
  let paramIdx = 4; // $1=embedding, $2=threshold, $3=limit

  if (filters?.chunkType) {
    conditions.push(`c."chunkType" = $${paramIdx}`);
    params.push(filters.chunkType);
    paramIdx++;
  }
  if (filters?.patternNumber !== undefined) {
    conditions.push(`c."patternNumber" = $${paramIdx}`);
    params.push(filters.patternNumber);
    paramIdx++;
  }
  if (filters?.category) {
    conditions.push(`c.category = $${paramIdx}`);
    params.push(filters.category);
    paramIdx++;
  }
  if (filters?.section) {
    conditions.push(`c.section = $${paramIdx}`);
    params.push(filters.section);
    paramIdx++;
  }
  if (filters?.documentId) {
    conditions.push(`c."documentId" = $${paramIdx}`);
    params.push(filters.documentId);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');

  // Hybrid search: vector similarity + keyword boost
  // The keyword boost adds a small score bonus for full-text matches
  const sql = `
    SELECT
      c.id,
      c."chunkKey",
      c."documentId",
      c.content,
      c."chunkType",
      c."patternNumber",
      c."patternName",
      c.category,
      c.section,
      c.keywords,
      c."estimatedTokens",
      c.metadata,
      (c.embedding <=> $1::vector) AS distance,
      CASE
        WHEN c.keywords IS NOT NULL
          AND plainto_tsquery('english', $${paramIdx}) @@ to_tsvector('english', c.keywords)
        THEN -0.05
        WHEN c.content IS NOT NULL
          AND plainto_tsquery('english', $${paramIdx}) @@ to_tsvector('english', c.content)
        THEN -0.02
        ELSE 0
      END AS keyword_boost
    FROM ai_knowledge_chunk c
    WHERE ${whereClause}
      AND (c.embedding <=> $1::vector) < $2
    ORDER BY (c.embedding <=> $1::vector) + (
      CASE
        WHEN c.keywords IS NOT NULL
          AND plainto_tsquery('english', $${paramIdx}) @@ to_tsvector('english', c.keywords)
        THEN -0.05
        WHEN c.content IS NOT NULL
          AND plainto_tsquery('english', $${paramIdx}) @@ to_tsvector('english', c.content)
        THEN -0.02
        ELSE 0
      END
    ) ASC
    LIMIT $3
  `;

  params.push(query); // keyword search param

  const results = await prisma.$queryRawUnsafe<
    Array<
      AiKnowledgeChunk & {
        distance: number;
        keyword_boost: number;
      }
    >
  >(sql, ...params);

  logger.info('Knowledge search results', {
    query,
    resultCount: results.length,
    topDistance: results[0]?.distance,
  });

  return results.map((row) => {
    const chunk: AiKnowledgeChunk = {
      id: row.id,
      chunkKey: row.chunkKey,
      documentId: row.documentId,
      content: row.content,
      chunkType: row.chunkType,
      patternNumber: row.patternNumber,
      patternName: row.patternName,
      category: row.category,
      section: row.section,
      keywords: row.keywords,
      estimatedTokens: row.estimatedTokens,
      metadata: row.metadata,
    };
    return {
      chunk,
      similarity: 1 - row.distance + Math.abs(row.keyword_boost),
    };
  });
}

/**
 * List all distinct patterns in the knowledge base.
 *
 * Groups chunks by patternNumber and returns a summary for each pattern,
 * suitable for the pattern explorer card grid.
 */
export async function listPatterns(): Promise<PatternSummary[]> {
  const groups = await prisma.aiKnowledgeChunk.groupBy({
    by: ['patternNumber', 'patternName', 'category'],
    where: { patternNumber: { not: null } },
    _count: { id: true },
    orderBy: { patternNumber: 'asc' },
  });

  // Batch-fetch all overview chunks in a single query (avoids N+1)
  const patternNumbers = groups.map((g) => g.patternNumber).filter((n): n is number => n !== null);

  const overviewChunks = await prisma.aiKnowledgeChunk.findMany({
    where: {
      patternNumber: { in: patternNumbers },
      chunkType: 'pattern_overview',
    },
    select: { patternNumber: true, content: true, metadata: true },
  });

  const overviewByPattern = new Map(overviewChunks.map((c) => [c.patternNumber, c]));

  const summaries: PatternSummary[] = [];

  for (const group of groups) {
    if (group.patternNumber === null) continue;

    const overviewChunk = overviewByPattern.get(group.patternNumber) ?? null;

    const rawMeta: unknown = overviewChunk?.metadata ?? null;
    const metadata =
      rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
        ? (rawMeta as Record<string, unknown>)
        : null;
    const complexity = typeof metadata?.complexity === 'string' ? metadata.complexity : null;

    summaries.push({
      patternNumber: group.patternNumber,
      patternName: group.patternName ?? `Pattern ${group.patternNumber}`,
      category: group.category,
      complexity,
      description: overviewChunk?.content?.slice(0, 200) ?? null,
      chunkCount: group._count.id,
    });
  }

  return summaries;
}

/** Ordered sections for pattern detail aggregation */
const SECTION_ORDER = [
  'overview',
  'tldr',
  'TL;DR Summary',
  'definition',
  'Definition & Core Concept',
  'how_it_works',
  'How It Works',
  'code_example',
  'Code Examples',
  'swe_parallels',
  'SWE Parallels',
  'when_to_use',
  'When to Use',
  'pitfalls',
  'Pitfalls',
  'related_patterns',
  'Related Patterns',
];

/**
 * Get all chunks for a specific pattern, ordered by section.
 *
 * Aggregates all knowledge chunks for a pattern number into a
 * structured response with sections in logical reading order.
 *
 * @param patternNumber - The pattern number (1-21+)
 * @returns All chunks for that pattern, ordered by section
 */
export async function getPatternDetail(patternNumber: number): Promise<{
  patternName: string | null;
  chunks: AiKnowledgeChunk[];
  totalTokens: number;
}> {
  const chunks = await prisma.aiKnowledgeChunk.findMany({
    where: { patternNumber },
    orderBy: { chunkKey: 'asc' },
  });

  if (chunks.length === 0) {
    return { patternName: null, chunks: [], totalTokens: 0 };
  }

  // Sort by section order
  const sorted = [...chunks].sort((a, b) => {
    const aIdx = SECTION_ORDER.findIndex(
      (s) => s.toLowerCase() === (a.section ?? '').toLowerCase()
    );
    const bIdx = SECTION_ORDER.findIndex(
      (s) => s.toLowerCase() === (b.section ?? '').toLowerCase()
    );
    const aOrder = aIdx === -1 ? 999 : aIdx;
    const bOrder = bIdx === -1 ? 999 : bIdx;
    return aOrder - bOrder;
  });

  return {
    patternName: chunks[0].patternName,
    chunks: sorted,
    totalTokens: chunks.reduce((sum, c) => sum + (c.estimatedTokens ?? 0), 0),
  };
}
