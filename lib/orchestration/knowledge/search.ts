/**
 * Knowledge Base Search Service
 *
 * Two ranking modes, selected by `searchConfig.hybridEnabled`:
 *
 *  - **Vector-only (default).** Cosine distance via pgvector with an
 *    additive keyword boost for chunks matching `plainto_tsquery`.
 *  - **Hybrid (BM25-flavoured + vector).** Blends cosine similarity with
 *    `ts_rank_cd` over the generated `searchVector` tsvector column.
 *    Use this when exact-term recall matters (legal, financial,
 *    regulatory, medical terminology). Ranking is
 *    `vectorWeight × vector_score + bm25Weight × keyword_score`.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { embedText, getActiveEmbeddingModelSummary } from '@/lib/orchestration/knowledge/embedder';
import type { KnowledgeSearchResult, PatternSummary, SearchConfig } from '@/types/orchestration';
import type { AiKnowledgeChunk } from '@/types/prisma';

/** Default similarity threshold (lower = more similar for cosine distance) */
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_LIMIT = 10;

/** Built-in defaults used when searchConfig is null (no admin override). */
const DEFAULT_KEYWORD_BOOST: number = -0.02;
const DEFAULT_KEYWORD_BOOST_STRONG: number = -0.05;
const DEFAULT_VECTOR_WEIGHT: number = 1.0;
const DEFAULT_BM25_WEIGHT: number = 1.0;

interface ResolvedSearchWeights {
  keywordBoost: number;
  keywordBoostStrong: number;
  vectorWeight: number;
  hybridEnabled: boolean;
  bm25Weight: number;
}

/**
 * Resolve search weights from the settings singleton, falling back to
 * built-in defaults when no admin override is stored.
 */
async function resolveSearchWeights(): Promise<ResolvedSearchWeights> {
  let config: SearchConfig | null = null;
  try {
    const settings = await getOrchestrationSettings();
    config = settings.searchConfig;
  } catch {
    // Settings DB unavailable — use defaults silently
  }

  // Per-field fallback so a partial override (e.g. `{ hybridEnabled: true }`
  // alone) inherits defaults for everything the admin didn't explicitly set.
  // The strong (keyword-match) boost is derived proportionally from the soft
  // boost — default ratio is -0.05 / -0.02 = 2.5×.
  const ratio = DEFAULT_KEYWORD_BOOST_STRONG / DEFAULT_KEYWORD_BOOST;
  const keywordBoost = config?.keywordBoostWeight ?? DEFAULT_KEYWORD_BOOST;
  return {
    keywordBoost,
    keywordBoostStrong: keywordBoost * ratio,
    vectorWeight: config?.vectorWeight ?? DEFAULT_VECTOR_WEIGHT,
    hybridEnabled: config?.hybridEnabled === true,
    bm25Weight: config?.bm25Weight ?? DEFAULT_BM25_WEIGHT,
  };
}

/**
 * Fail fast when the operator has picked a new active embedding model
 * (changing dim) but hasn't re-embedded the corpus yet. Without this
 * check, the search would still call out to the embedder, spend a
 * round-trip, then crash on the SQL cast — a confusing failure mode.
 *
 * Skips silently when:
 *   - no active model is set (legacy fallback path; stored vectors
 *     are 1536 by construction and the embedder produces 1536),
 *   - the corpus is empty (no chunks to compare against),
 *   - stored chunks have no `embeddingDimension` recorded yet (rows
 *     pre-dating Phase 1 — they were 1536, by construction).
 *
 * Uses `groupBy(embeddingDimension)` rather than a single-row sample so
 * a partially-re-embedded corpus (some chunks at the old dim, some at
 * the new) is caught even when the `findFirst` happens to land on a
 * matching row. The query is cheap — at most one row per distinct
 * dimension in the corpus — and the aggregated counts feed a clearer
 * error message when there's drift.
 */
async function assertActiveModelMatchesStoredVectors(): Promise<void> {
  const active = await getActiveEmbeddingModelSummary();
  if (!active) return;

  const dimensionGroups = await prisma.aiKnowledgeChunk.groupBy({
    by: ['embeddingDimension'],
    where: { embeddingDimension: { not: null } },
    _count: { _all: true },
  });

  if (dimensionGroups.length === 0) return;

  const mismatched = dimensionGroups.filter((g) => g.embeddingDimension !== active.dimensions);
  if (mismatched.length === 0) return;

  // Surface one stored model name per mismatched dimension so the
  // operator sees what produced the rows without spelunking through
  // chunks themselves. `embeddingModel` can be null on legacy rows; the
  // ?? 'unknown' guard preserves that case.
  const exemplars = await Promise.all(
    mismatched.map(async (g) => {
      const row = await prisma.aiKnowledgeChunk.findFirst({
        where: { embeddingDimension: g.embeddingDimension },
        select: { embeddingModel: true },
      });
      return {
        dimension: g.embeddingDimension,
        count: g._count._all,
        model: row?.embeddingModel ?? 'unknown',
      };
    })
  );

  const summary = exemplars
    .map((e) => `${e.count} chunk(s) embedded by "${e.model}" at ${e.dimension} dims`)
    .join('; ');

  throw new Error(
    `Embedding model mismatch: the active model "${active.modelId}" produces ` +
      `${active.dimensions}-dim vectors, but the corpus contains: ${summary}. ` +
      'Run `npm run embeddings:reset` and re-upload documents to apply the new model.'
  );
}

/** Search filter options */
export interface SearchFilters {
  chunkType?: string;
  patternNumber?: number;
  section?: string;
  documentId?: string;
  /**
   * Restrict to chunks belonging to any of these documents. Used by the agent
   * knowledge-access resolver. **The presence of this field (even as `[]`)
   * is significant** — it switches the search into "restricted mode" and
   * makes `includeSystemScope` meaningful. An empty array means "no granted
   * docs"; combined with `includeSystemScope: true` it collapses the search
   * to system-scoped seed docs only. Omit the field entirely for unrestricted
   * search.
   */
  documentIds?: string[];
  /**
   * When true, include chunks from system-scoped documents alongside the
   * `documentIds` allowlist. Only meaningful when `documentIds` is set.
   */
  includeSystemScope?: boolean;
  scope?: string;
}

/**
 * Embedding provenance + billing data for a knowledge-search call.
 * Re-exported here so the chat capability and any other call site can
 * surface the per-query embedding cost back to the user without
 * round-tripping through `embedText` separately.
 */
export interface KnowledgeSearchEmbedding {
  model: string;
  provider: string;
  inputTokens: number;
  costUsd: number;
}

/** Full return shape for `searchKnowledgeWithEmbedding`. */
export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
  embedding: KnowledgeSearchEmbedding;
}

/**
 * Search the knowledge base using hybrid vector + keyword search.
 *
 * Embeds the query, then performs cosine similarity search via pgvector's
 * <=> operator. Optionally boosts results that match keywords via
 * PostgreSQL's full-text search (to_tsvector/plainto_tsquery).
 *
 * Most callers only need the results array; use
 * {@link searchKnowledgeWithEmbedding} when the embedding provenance
 * (model id, token usage, cost) is needed — e.g. the chat capability
 * rolling embedding cost into the turn's `sideEffectModels` total.
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
  const { results } = await searchKnowledgeWithEmbedding(query, filters, limit, threshold);
  return results;
}

/**
 * Same as {@link searchKnowledge} but additionally returns the
 * embedding provenance (model, provider, tokens, cost) so callers can
 * attribute the per-query embedding spend to their request — currently
 * used by the chat handler to roll it into the turn's side-effect
 * model summary.
 */
export async function searchKnowledgeWithEmbedding(
  query: string,
  filters?: SearchFilters,
  limit: number = DEFAULT_LIMIT,
  threshold: number = DEFAULT_THRESHOLD
): Promise<KnowledgeSearchResponse> {
  logger.info('Knowledge search', { query, filters, limit, threshold });

  await assertActiveModelMatchesStoredVectors();

  const weights = await resolveSearchWeights();

  // Generate query embedding (pass 'query' input type for Voyage optimisation)
  const embedResult = await embedText(query, 'query');
  const queryEmbedding = embedResult.embedding;
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
  // Document-scope filter. The presence of `documentIds` (even when empty)
  // signals an explicit restriction — the resolver passes `documentIds: []`
  // for a restricted agent with zero grants, and that MUST collapse the
  // search to system-scoped seed docs (or nothing) rather than falling back
  // to an unfiltered KB. Skipping this clause on `length === 0` was the
  // empty-grants bypass — fixed by emitting an explicit predicate in every
  // case where the caller passes the array.
  if (filters?.documentIds !== undefined) {
    if (filters.documentIds.length === 0) {
      conditions.push(filters.includeSystemScope ? `d.scope = 'system'` : `FALSE`);
    } else {
      const placeholders = filters.documentIds.map((_, i) => `$${paramIdx + i}`).join(', ');
      const docFilter = filters.includeSystemScope
        ? `(c."documentId" IN (${placeholders}) OR d.scope = 'system')`
        : `c."documentId" IN (${placeholders})`;
      conditions.push(docFilter);
      for (const id of filters.documentIds) {
        params.push(id);
        paramIdx++;
      }
    }
  }
  if (filters?.scope) {
    conditions.push(`d.scope = $${paramIdx}`);
    params.push(filters.scope);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');

  const results = weights.hybridEnabled
    ? await runHybridSearch({ query, weights, params, paramIdx, whereClause })
    : await runVectorOnlySearch({ query, weights, params, paramIdx, whereClause });

  return {
    results,
    embedding: {
      model: embedResult.model,
      provider: embedResult.provider,
      inputTokens: embedResult.inputTokens,
      costUsd: embedResult.costUsd,
    },
  };
}

interface SearchBranchInput {
  query: string;
  weights: ResolvedSearchWeights;
  params: unknown[];
  paramIdx: number;
  whereClause: string;
}

/**
 * Vector-only search path (default). Byte-for-byte the legacy behaviour:
 * cosine distance ranking with an additive keyword boost for chunks whose
 * keywords or content match `plainto_tsquery(query)`.
 */
async function runVectorOnlySearch({
  query,
  weights,
  params,
  paramIdx,
  whereClause,
}: SearchBranchInput): Promise<KnowledgeSearchResult[]> {
  const queryParamIdx = paramIdx;
  const boostStrongParamIdx = paramIdx + 1;
  const boostParamIdx = paramIdx + 2;

  const sql = `
    SELECT
      c.id,
      c."chunkKey",
      c."documentId",
      c.content,
      c."chunkType",
      c."patternNumber",
      c."patternName",
      c.section,
      c.keywords,
      c."estimatedTokens",
      c.metadata,
      c."embeddingModel",
      c."embeddingProvider",
      c."embeddingDimension",
      c."embeddedAt",
      d.name AS "documentName",
      (c.embedding <=> $1::vector) AS distance,
      CASE
        WHEN c.keywords IS NOT NULL
          AND plainto_tsquery('english', $${queryParamIdx}) @@ to_tsvector('english', c.keywords)
        THEN $${boostStrongParamIdx}::float
        WHEN c.content IS NOT NULL
          AND plainto_tsquery('english', $${queryParamIdx}) @@ to_tsvector('english', c.content)
        THEN $${boostParamIdx}::float
        ELSE 0
      END AS keyword_boost
    FROM ai_knowledge_chunk c
    JOIN ai_knowledge_document d ON d.id = c."documentId"
    WHERE ${whereClause}
      AND (c.embedding <=> $1::vector) < $2
    ORDER BY (c.embedding <=> $1::vector) + (
      CASE
        WHEN c.keywords IS NOT NULL
          AND plainto_tsquery('english', $${queryParamIdx}) @@ to_tsvector('english', c.keywords)
        THEN $${boostStrongParamIdx}::float
        WHEN c.content IS NOT NULL
          AND plainto_tsquery('english', $${queryParamIdx}) @@ to_tsvector('english', c.content)
        THEN $${boostParamIdx}::float
        ELSE 0
      END
    ) ASC
    LIMIT $3
  `;

  params.push(query, weights.keywordBoostStrong, weights.keywordBoost);

  const results = await prisma.$queryRawUnsafe<
    Array<
      AiKnowledgeChunk & {
        documentName: string;
        distance: number;
        keyword_boost: number;
      }
    >
  >(sql, ...params);

  logger.info('Knowledge search results', {
    query,
    resultCount: results.length,
    topDistance: results[0]?.distance,
    mode: 'vector_only',
  });

  return results.map((row) => ({
    chunk: pickChunk(row),
    similarity: Math.min(
      1,
      (1 - row.distance) * weights.vectorWeight + Math.abs(row.keyword_boost)
    ),
    documentName: row.documentName,
  }));
}

/**
 * Hybrid search path. Blends cosine similarity with a BM25-flavoured score
 * (`ts_rank_cd` over the generated `searchVector` column, normalisation 32
 * which bounds output to [0, 1)). Final ranking uses
 * `vectorWeight × vector_score + bm25Weight × keyword_score`. The legacy
 * additive `keywordBoostWeight` is intentionally ignored in this mode —
 * `bm25Weight` controls keyword influence instead.
 *
 * The cosine-distance threshold continues to gate candidates so the
 * semantic recall floor is preserved across both modes.
 */
async function runHybridSearch({
  query,
  weights,
  params,
  paramIdx,
  whereClause,
}: SearchBranchInput): Promise<KnowledgeSearchResult[]> {
  const queryParamIdx = paramIdx;
  const vectorWeightParamIdx = paramIdx + 1;
  const bm25WeightParamIdx = paramIdx + 2;

  const sql = `
    WITH scored AS (
      SELECT
        c.id,
        c."chunkKey",
        c."documentId",
        c.content,
        c."chunkType",
        c."patternNumber",
        c."patternName",
        c.section,
        c.keywords,
        c."estimatedTokens",
        c.metadata,
        c."embeddingModel",
        c."embeddingProvider",
        c."embeddingDimension",
        c."embeddedAt",
        d.name AS "documentName",
        (c.embedding <=> $1::vector) AS distance,
        GREATEST(0.0, 1.0 - (c.embedding <=> $1::vector)) AS vector_score,
        COALESCE(
          ts_rank_cd(c."searchVector", plainto_tsquery('english', $${queryParamIdx}), 32),
          0.0
        ) AS keyword_score
      FROM ai_knowledge_chunk c
      JOIN ai_knowledge_document d ON d.id = c."documentId"
      WHERE ${whereClause}
        AND (c.embedding <=> $1::vector) < $2
    )
    SELECT
      *,
      ($${vectorWeightParamIdx}::float * vector_score
        + $${bm25WeightParamIdx}::float * keyword_score) AS final_score
    FROM scored
    ORDER BY final_score DESC
    LIMIT $3
  `;

  params.push(query, weights.vectorWeight, weights.bm25Weight);

  const results = await prisma.$queryRawUnsafe<
    Array<
      AiKnowledgeChunk & {
        documentName: string;
        distance: number;
        vector_score: number;
        keyword_score: number;
        final_score: number;
      }
    >
  >(sql, ...params);

  logger.info('Knowledge search results', {
    query,
    resultCount: results.length,
    topFinalScore: results[0]?.final_score,
    mode: 'hybrid',
  });

  return results.map((row) => ({
    chunk: pickChunk(row),
    similarity: Math.min(1, Math.max(0, row.final_score)),
    documentName: row.documentName,
    vectorScore: row.vector_score,
    keywordScore: row.keyword_score,
    finalScore: row.final_score,
  }));
}

/** Project a raw row into the public `AiKnowledgeChunk` shape. */
function pickChunk(row: AiKnowledgeChunk): AiKnowledgeChunk {
  return {
    id: row.id,
    chunkKey: row.chunkKey,
    documentId: row.documentId,
    content: row.content,
    chunkType: row.chunkType,
    patternNumber: row.patternNumber,
    patternName: row.patternName,
    section: row.section,
    keywords: row.keywords,
    estimatedTokens: row.estimatedTokens,
    embeddingModel: row.embeddingModel,
    embeddingProvider: row.embeddingProvider,
    embeddingDimension: row.embeddingDimension,
    embeddedAt: row.embeddedAt,
    metadata: row.metadata,
  };
}

/**
 * Strip leading markdown headings (lines starting with `#`) so the
 * card description doesn't repeat the pattern name already shown in
 * the card title.
 */
function stripLeadingHeadings(content: string | null | undefined): string | null {
  if (!content) return null;
  const stripped = content.replace(/^(?:#+ .*\n?)+/, '').trim();
  return stripped || null;
}

/**
 * Extract the first paragraph from markdown content.
 * A paragraph is a block of non-empty lines separated by blank lines.
 * Returns the full first paragraph (no character truncation).
 */
function firstParagraph(content: string | null | undefined): string | null {
  if (!content) return null;
  const stripped = stripLeadingHeadings(content);
  if (!stripped) return null;
  // Split on blank lines, take the first non-empty block
  const paragraph = stripped.split(/\n\s*\n/)[0]?.trim() ?? null;
  return paragraph || null;
}

/**
 * List all distinct patterns in the knowledge base.
 *
 * Groups chunks by patternNumber and returns a summary for each pattern,
 * suitable for the pattern explorer card grid.
 */
export async function listPatterns(): Promise<PatternSummary[]> {
  const groups = await prisma.aiKnowledgeChunk.groupBy({
    by: ['patternNumber', 'patternName'],
    where: { patternNumber: { not: null } },
    _count: { id: true },
    orderBy: { patternNumber: 'asc' },
  });

  // Batch-fetch overview and TL;DR chunks in two queries (avoids N+1)
  const patternNumbers = groups.map((g) => g.patternNumber).filter((n): n is number => n !== null);

  const [overviewChunks, tldrChunks] = await Promise.all([
    prisma.aiKnowledgeChunk.findMany({
      where: {
        patternNumber: { in: patternNumbers },
        chunkType: 'pattern_overview',
      },
      select: { patternNumber: true, content: true, metadata: true },
    }),
    prisma.aiKnowledgeChunk.findMany({
      where: {
        patternNumber: { in: patternNumbers },
        section: 'Summary',
      },
      select: { patternNumber: true, content: true },
    }),
  ]);

  const overviewByPattern = new Map(overviewChunks.map((c) => [c.patternNumber, c]));
  const tldrByPattern = new Map(tldrChunks.map((c) => [c.patternNumber, c]));

  // Deduplicate by patternNumber — groupBy already returns one row per
  // (patternNumber, patternName) so we just merge chunk counts if a single
  // pattern has rows under multiple `patternName` strings (rare; defensive).
  const merged = new Map<number, { patternName: string | null; chunkCount: number }>();
  for (const group of groups) {
    if (group.patternNumber === null) continue;
    const existing = merged.get(group.patternNumber);
    if (existing) {
      existing.chunkCount += group._count.id;
      existing.patternName ??= group.patternName;
    } else {
      merged.set(group.patternNumber, {
        patternName: group.patternName,
        chunkCount: group._count.id,
      });
    }
  }

  const summaries: PatternSummary[] = [];

  for (const [patternNumber, { patternName, chunkCount }] of merged) {
    const overviewChunk = overviewByPattern.get(patternNumber) ?? null;
    const tldrChunk = tldrByPattern.get(patternNumber) ?? null;

    const description =
      firstParagraph(tldrChunk?.content) ?? firstParagraph(overviewChunk?.content) ?? null;

    summaries.push({
      patternNumber,
      patternName: patternName ?? `Pattern ${patternNumber}`,
      description,
      chunkCount,
    });
  }

  return summaries;
}

/** Ordered sections for pattern detail aggregation */
const SECTION_ORDER = [
  'overview',
  'tldr',
  'Summary',
  'definition',
  'Definition & Core Concept',
  'Agentic Definition',
  'Common Questions',
  'how_it_works',
  'How It Works',
  'code_example',
  'Code Examples',
  'swe_parallels',
  'Traditional Software Engineering Parallels',
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
